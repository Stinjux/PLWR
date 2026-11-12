import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { config } from '../config.ts';
import { strip } from './expenseParser.ts';
import { aiAllowed, fallbackParams, recordUsage } from './aiUsage.ts';

/**
 * Transforme un objectif écrit librement (« courir 3 fois par semaine », « 5 000 $ pour un voyage en juin »)
 * en objectif mesurable + une première étape à planifier.
 * Claude s'en charge quand une clé est configurée ; sinon des règles locales couvrent les cas courants.
 */

export type GoalDraft = {
  title: string;
  kind: 'financial' | 'personal';
  metric: 'check' | 'quantity' | 'duration' | 'amount';
  target: number;
  unit: string;
  period: 'once' | 'daily' | 'weekly' | 'monthly';
  deadline: string | null;
  summary: string;
  firstStep: { title: string; durationMin: number };
  source: 'ai' | 'rules';
};

const GoalSchema = z.object({
  title: z.string().describe('≤ 60 car.'),
  kind: z.enum(['financial', 'personal']),
  metric: z.enum(['check', 'quantity', 'duration', 'amount']),
  target: z.number().describe('par période'),
  unit: z.string(),
  period: z.enum(['once', 'daily', 'weekly', 'monthly']),
  deadline: z.string().nullable().describe('YYYY-MM-DD'),
  summary: z.string().describe('1 phrase'),
  firstStep: z.object({ title: z.string().describe('≤ 50 car.'), durationMin: z.number() }),
});

const SYSTEM = `Rends mesurable l'objectif écrit (Québec, français, $ CA). N'invente ni montant ni fréquence absents ; sans chiffre : check, 1, once. Durées en minutes, montants en dollars. Première étape : action concrète faisable cette semaine. Ton factuel.`;

const clampText = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);

function sanitize(d: Omit<GoalDraft, 'source'>, source: GoalDraft['source']): GoalDraft {
  const metric = d.metric;
  let target = Number(d.target);
  if (!Number.isFinite(target) || target <= 0) target = 1;
  if (metric === 'check') target = 1;
  const deadline = d.deadline && /^\d{4}-\d{2}-\d{2}$/.test(d.deadline) && d.deadline > DateTime.now().toISODate()! ? d.deadline : null;
  return {
    title: clampText(d.title || 'Mon objectif', 80),
    kind: d.kind === 'financial' ? 'financial' : 'personal',
    metric,
    target: Math.round(target * 100) / 100,
    unit: clampText(metric === 'amount' ? '$' : metric === 'duration' ? 'min' : d.unit || (metric === 'quantity' ? 'fois' : ''), 20),
    period: d.period,
    deadline,
    summary: clampText(d.summary || '', 200),
    firstStep: { title: clampText(d.firstStep?.title || `Commencer : ${d.title}`, 80), durationMin: Math.min(240, Math.max(10, Math.round(Number(d.firstStep?.durationMin) || 30))) },
    source,
  };
}

const MONTHS = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];
const PERIOD_WORDS: [RegExp, GoalDraft['period']][] = [
  [/(par|chaque|tous les|toutes les|\/)\s*(jour|jours|soir|matin)|quotidien/, 'daily'],
  [/(par|chaque|toutes les|\/)\s*(semaine|sem)|hebdo/, 'weekly'],
  [/(par|chaque|tous les|\/)\s*mois|mensuel/, 'monthly'],
];

/** Règles locales (sans clé API) : montants, durées, « N fois par … », échéances simples. */
export function interpretWithRules(text: string, tz = config.defaultTimezone): GoalDraft {
  const raw = clampText(text, 200);
  const t = strip(raw).replace(/[’‘`´]/g, "'");
  const period = PERIOD_WORDS.find(([re]) => re.test(t))?.[1] || 'once';
  let deadline: string | null = null;
  const now = DateTime.now().setZone(tz);
  const m = t.match(/(?:d'ici|avant|pour)\s+(?:la fin de |fin )?(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)/);
  if (m) {
    let d = now.set({ month: MONTHS.indexOf(m[1]) + 1 }).endOf('month');
    if (d < now) d = d.plus({ years: 1 });
    deadline = d.toISODate();
  }
  const inMonths = t.match(/(?:dans|en|d'ici)\s+(\d{1,2})\s+mois/);
  if (!deadline && inMonths) deadline = now.plus({ months: Number(inMonths[1]) }).toISODate();
  const financial = /\$|epargn|economis|dette|rembours|budget|fonds|carte de credit|mise de fonds|celi|reer|placement|argent/.test(t);
  const title = raw.charAt(0).toUpperCase() + raw.slice(1).replace(/[.!]+$/, '');

  const money = t.match(/(\d[\d\s]*(?:[.,]\d{1,2})?)\s*(k)?\s*\$|\$\s*(\d[\d\s]*)/);
  if (money) {
    const n = Number((money[1] || money[3]).replace(/\s/g, '').replace(',', '.')) * (money[2] ? 1000 : 1);
    return sanitize({ title, kind: 'financial', metric: 'amount', target: n, unit: '$', period, deadline, summary: `Suivi de ${n.toLocaleString('fr-CA')} $${period === 'monthly' ? ' par mois' : ''}${deadline ? ` d’ici le ${deadline}` : ''}.`, firstStep: { title: /dette|rembours|carte/.test(t) ? 'Faire le point sur mes dettes' : 'Ouvrir ou choisir mon compte épargne', durationMin: 30 } }, 'rules');
  }
  const times = t.match(/(\d+)\s*(?:fois|x)\b/);
  if (times) {
    const n = Number(times[1]);
    return sanitize({ title, kind: financial ? 'financial' : 'personal', metric: 'quantity', target: n, unit: 'fois', period: period === 'once' ? 'weekly' : period, deadline, summary: `Suivi de ${n} fois${period === 'daily' ? ' par jour' : period === 'monthly' ? ' par mois' : ' par semaine'}.`, firstStep: { title: `Première séance : ${title}`, durationMin: 45 } }, 'rules');
  }
  const dur = t.match(/(\d+)\s*(min|minutes?|h|heures?)\b/);
  if (dur) {
    const minutes = Number(dur[1]) * (/^h/.test(dur[2]) ? 60 : 1);
    return sanitize({ title, kind: 'personal', metric: 'duration', target: minutes, unit: 'min', period: period === 'once' ? 'daily' : period, deadline, summary: `Suivi de ${minutes} min${period === 'weekly' ? ' par semaine' : period === 'monthly' ? ' par mois' : ' par jour'}.`, firstStep: { title: title, durationMin: Math.min(120, minutes) } }, 'rules');
  }
  return sanitize({ title, kind: financial ? 'financial' : 'personal', metric: 'check', target: 1, unit: '', period: 'once', deadline, summary: 'Objectif à cocher une fois atteint.', firstStep: { title: `Première étape : ${title}`, durationMin: 30 } }, 'rules');
}

/** Réponses déjà calculées (les idées proposées reviennent souvent) : aucun nouvel appel pour le même texte. */
const cache = new Map<string, GoalDraft>();

/**
 * Économe en jetons : les règles locales suffisent dès que le texte contient une mesure (montant, durée, « N fois ») ;
 * Claude n'est appelé que pour les objectifs sans chiffre, une fois par texte, et dans la limite quotidienne.
 */
export async function interpretGoal(text: string, tz = config.defaultTimezone, userId?: string): Promise<GoalDraft> {
  const clean = clampText(String(text || ''), 300);
  if (clean.length < 3) throw new Error('Décris ton objectif en quelques mots');
  const rules = interpretWithRules(clean, tz);
  if (rules.metric !== 'check') return rules;
  const key = strip(clean).replace(/\s+/g, ' ');
  if (cache.has(key)) return cache.get(key)!;
  if (!config.vision.anthropicKey || (userId && !aiAllowed(userId, tz))) return rules;
  try {
    const client = new Anthropic({ apiKey: config.vision.anthropicKey, timeout: 20_000, maxRetries: 1 });
    const model = config.ai.textModel;
    const response = await client.beta.messages.parse({
      model,
      max_tokens: 1000,
      ...fallbackParams(model),
      output_config: { effort: 'low', format: betaZodOutputFormat(GoalSchema) },
      system: SYSTEM,
      messages: [{ role: 'user', content: `${DateTime.now().setZone(tz).toISODate()} : « ${clean} »` }],
    } as any);
    recordUsage(userId || null, 'goal', model, response.usage);
    if (response.stop_reason === 'refusal' || !response.parsed_output) return rules;
    const out = sanitize(response.parsed_output as Omit<GoalDraft, 'source'>, 'ai');
    if (cache.size > 500) cache.clear();
    cache.set(key, out);
    return out;
  } catch (e) {
    if (e instanceof Anthropic.APIError) console.error(`[objectif] Claude indisponible (${e.status ?? '?'}) : règles locales`);
    else console.error('[objectif] interprétation impossible, règles locales :', e instanceof Error ? e.message : e);
    return interpretWithRules(clean, tz);
  }
}
