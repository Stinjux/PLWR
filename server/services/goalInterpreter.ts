import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { config } from '../config.ts';
import { strip } from './expenseParser.ts';

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
  title: z.string().describe('Titre court et motivant, en français, 60 caractères max (ex. « Courir 3 fois par semaine »)'),
  kind: z.enum(['financial', 'personal']).describe('financial = argent (épargne, dette, budget) ; personal = le reste'),
  metric: z
    .enum(['check', 'quantity', 'duration', 'amount'])
    .describe('amount = dollars ; duration = minutes ; quantity = nombre de fois ou d’unités ; check = fait / pas fait'),
  target: z.number().describe('Cible par période (ex. 3 pour 3 fois par semaine, 20 pour 20 min par jour, 5000 pour 5 000 $). Durées en minutes.'),
  unit: z.string().describe('Unité courte : « $ », « min », « fois », « pages », « km »… ; vide pour check'),
  period: z.enum(['once', 'daily', 'weekly', 'monthly']).describe('Fréquence de la cible ; once pour un objectif à atteindre une fois'),
  deadline: z.string().nullable().describe('Date limite YYYY-MM-DD si la personne en indique une (ex. « d’ici juin » → dernier jour de juin), sinon null'),
  summary: z.string().describe('Une phrase factuelle en français qui résume ce qui sera suivi, sans encouragement'),
  firstStep: z.object({
    title: z.string().describe('Première action concrète à planifier cette semaine, en français, 50 caractères max'),
    durationMin: z.number().describe('Durée réaliste de cette première action, en minutes (15 à 120)'),
  }),
});

const SYSTEM = `Tu transformes l'objectif qu'une personne écrit dans une app d'agenda et de budget (Québec, français, dollars canadiens) en objectif mesurable.
Règles :
- Respecte ce que la personne a écrit ; n'invente pas de montant ni de fréquence absents. S'il n'y a pas de chiffre, choisis metric=check, target=1, period=once.
- Les durées sont en minutes. Les montants sont en dollars (pas en cents).
- La première étape est une action concrète, courte et faisable cette semaine (ex. « Ouvrir un compte épargne », « Première course de 20 min »).
- Ton factuel : pas de slogan, pas d'emoji.`;

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

export async function interpretGoal(text: string, tz = config.defaultTimezone): Promise<GoalDraft> {
  const clean = clampText(String(text || ''), 300);
  if (clean.length < 3) throw new Error('Décris ton objectif en quelques mots');
  if (!config.vision.anthropicKey) return interpretWithRules(clean, tz);
  try {
    const client = new Anthropic({ apiKey: config.vision.anthropicKey, timeout: 20_000, maxRetries: 1 });
    const response = await client.beta.messages.parse({
      model: config.vision.anthropicModel,
      max_tokens: 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: betaZodOutputFormat(GoalSchema) },
      system: SYSTEM,
      messages: [{ role: 'user', content: `Date du jour : ${DateTime.now().setZone(tz).toISODate()}.\nObjectif écrit par la personne : « ${clean} »` }],
    });
    if (response.stop_reason === 'refusal' || !response.parsed_output) return interpretWithRules(clean, tz);
    return sanitize(response.parsed_output as Omit<GoalDraft, 'source'>, 'ai');
  } catch (e) {
    if (e instanceof Anthropic.APIError) console.error(`[objectif] Claude indisponible (${e.status ?? '?'}) : règles locales`);
    else console.error('[objectif] interprétation impossible, règles locales :', e instanceof Error ? e.message : e);
    return interpretWithRules(clean, tz);
  }
}
