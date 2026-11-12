import Anthropic from '@anthropic-ai/sdk';
import { DateTime } from 'luxon';
import { all, get, nowIso, run, uid } from '../db.ts';
import { config } from '../config.ts';
import type { User } from '../auth.ts';
import { dayBounds, today } from '../time.ts';
import { createEvent, getOccurrence, listOccurrences, listUnscheduled, updateOccurrence, type Occurrence } from './events.ts';
import { formatGoalValue, goalProgress, rowToGoal, type Goal } from './goals.ts';
import { proposePlan, type PlanResult } from './planner.ts';
import { strip } from './expenseParser.ts';
import { aiAllowed, fallbackParams, recordUsage } from './aiUsage.ts';

/**
 * Assistant de la journée : fait le point sur les tâches du jour, réorganise la journée, déplace ou reporte un élément.
 * Il ne modifie RIEN lui-même : il renvoie des propositions que la personne applique d'un geste (« Appliquer »).
 * Claude s'en charge quand une clé est configurée ; sinon, des règles locales couvrent les demandes courantes.
 */

export type Proposal =
  | { id: string; type: 'complete'; itemId: string; title: string; detail: string }
  | { id: string; type: 'move'; itemId: string; title: string; detail: string; start: string; end: string }
  | { id: string; type: 'postpone'; itemId: string; title: string; detail: string; planDate: string; start: string | null; end: string | null }
  | { id: string; type: 'goal_progress'; goalId: string; title: string; detail: string; value: number }
  | { id: string; type: 'goal_block'; goalId: string; title: string; detail: string; blockTitle: string; start: string; end: string }
  | { id: string; type: 'plan'; title: string; detail: string; changes: { id: string; title: string; start: string; end: string }[]; postponed: { id: string; title: string; start: string | null; end: string | null; planDate: string | null }[] };

export type AssistantReply = { reply: string; proposals: Proposal[]; source: 'ai' | 'rules'; handled?: boolean };
type Item = { id: string; title: string; kind: 'fixed' | 'flexible'; start: string | null; end: string | null; durationMin: number; status: string; priority: number; recurring: boolean };

const hm = (iso: string, tz: string) => {
  const d = DateTime.fromISO(iso).setZone(tz);
  return d.minute ? d.toFormat("H 'h' mm") : d.toFormat("H 'h'");
};
const dur = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}` : ''}` : `${m} min`);

/** Éléments du jour (mon agenda) : rendez-vous, blocs et tâches à placer aujourd'hui. */
export function dayItems(user: User): { date: string; items: Item[] } {
  const date = today(user.timezone);
  const { start, end } = dayBounds(date, user.timezone);
  const toItem = (o: Occurrence): Item => ({ id: o.id, title: o.title, kind: o.kind, start: o.start, end: o.end, durationMin: o.durationMin, status: o.status, priority: o.priority, recurring: o.isRecurring });
  const scheduled = listOccurrences(user.id, user.timezone, start, end).map(toItem);
  const loose = listUnscheduled(user.id, date).filter((o) => o.planDate === date && o.status !== 'cancelled').map(toItem);
  return { date, items: [...scheduled, ...loose] };
}

/** Bilan factuel de la journée. */
export function daySummary(user: User): string {
  const { items } = dayItems(user);
  if (!items.length) return 'Rien n’est prévu aujourd’hui. Tu peux ajouter un événement ou une tâche, ou me demander de planifier quelque chose.';
  const tasks = items.filter((i) => i.kind === 'flexible');
  const done = tasks.filter((i) => i.status === 'done').length;
  const now = new Date().toISOString();
  const next = items.filter((i) => i.start && i.start > now && i.status === 'active').sort((a, b) => a.start!.localeCompare(b.start!))[0];
  const left = tasks.filter((i) => i.status === 'active');
  const parts = [`${tasks.length ? `${done} tâche${done > 1 ? 's' : ''} terminée${done > 1 ? 's' : ''} sur ${tasks.length}` : 'Aucune tâche aujourd’hui'}.`];
  if (next) parts.push(`Prochain : ${next.title} à ${hm(next.start!, user.timezone)}.`);
  if (left.length) parts.push(`Il reste ${left.map((i) => i.title).slice(0, 3).join(', ')}${left.length > 3 ? '…' : ''} (≈ ${dur(left.reduce((s, i) => s + i.durationMin, 0))}).`);
  else if (tasks.length) parts.push('Tout est fait pour aujourd’hui.');
  return parts.join(' ');
}

// ---------- Objectifs enregistrés ----------

type GoalInfo = { goal: Goal; done: number; target: number; remaining: number; percent: number; completed: boolean; periodLabel: string; checkedToday?: boolean };
const PERIOD_SHORT: Record<string, string> = { daily: 'aujourd’hui', weekly: 'cette semaine', monthly: 'ce mois-ci', once: 'au total' };

export function userGoals(user: User): GoalInfo[] {
  return all('SELECT * FROM goals WHERE user_id = ? AND archived = 0 ORDER BY created_at', user.id).map((r) => {
    const goal = rowToGoal(r);
    const p = goalProgress(goal, user.timezone);
    return { goal, done: p.done, target: p.target, remaining: p.remaining, percent: p.percent, completed: p.completed, periodLabel: PERIOD_SHORT[goal.period], checkedToday: p.checkedToday };
  });
}

const goalLine = (g: GoalInfo) =>
  g.goal.metric === 'check'
    ? `${g.goal.title} : ${g.completed ? 'fait' : 'à faire'} ${g.periodLabel}`
    : `${g.goal.title} : ${formatGoalValue(g.goal, g.done)} sur ${formatGoalValue(g.goal, g.target)} ${g.periodLabel} (${g.percent} %)`;

/** Bilan factuel des objectifs enregistrés. */
export function goalsSummary(user: User): string {
  const goals = userGoals(user);
  if (!goals.length) return 'Tu n’as pas encore d’objectif enregistré. Tu peux en créer un dans Objectifs, ou me dire par exemple « je veux lire 20 min par jour ».';
  const done = goals.filter((g) => g.completed).length;
  const lines = goals.slice(0, 6).map((g) => `• ${goalLine(g)}`);
  const behind = goals.filter((g) => !g.completed && g.goal.metric !== 'check').sort((a, b) => a.percent - b.percent)[0];
  return [`${done} objectif${done > 1 ? 's' : ''} atteint${done > 1 ? 's' : ''} sur ${goals.length} pour la période en cours.`, ...lines, behind ? `Le plus en retard : ${behind.goal.title} (il reste ${formatGoalValue(behind.goal, behind.remaining)}).` : ''].filter(Boolean).join('\n');
}

function goalProgressProposal(g: GoalInfo, value: number): Proposal {
  const after = g.done + value;
  return {
    id: uid(),
    type: 'goal_progress',
    goalId: g.goal.id,
    title: `Noter un progrès : ${g.goal.title}`,
    detail: g.goal.metric === 'check' ? `marqué comme fait ${g.periodLabel}` : `+${formatGoalValue(g.goal, value)} · ${formatGoalValue(g.goal, after)} sur ${formatGoalValue(g.goal, g.target)} ${g.periodLabel}`,
    value,
  };
}

function goalBlockProposal(user: User, g: GoalInfo, startIso: string, durationMin: number, title?: string): Proposal {
  const blockTitle = (title || g.goal.title).trim().slice(0, 120);
  const end = new Date(Date.parse(startIso) + durationMin * 60000).toISOString();
  const d = DateTime.fromISO(startIso).setZone(user.timezone);
  const day = d.toISODate() === today(user.timezone) ? 'aujourd’hui' : d.toFormat('cccc d', { locale: 'fr-CA' });
  return { id: uid(), type: 'goal_block', goalId: g.goal.id, title: `Planifier « ${blockTitle} »`, detail: `${day} à ${hm(startIso, user.timezone)} · ${dur(durationMin)} · lié à ${g.goal.title}`, blockTitle, start: startIso, end };
}

// ---------- Propositions ----------

function planProposal(user: User, plan: PlanResult): Proposal | null {
  if (!plan.changes.length && !plan.postponed.length) return null;
  const lines = [
    ...plan.changes.map((c) => `${c.title} → ${hm(c.to.start, user.timezone)}`),
    ...plan.postponed.map((p) => `${p.title} → ${p.suggestion ? `${DateTime.fromISO(p.suggestion.start).setZone(user.timezone).toFormat('ccc d', { locale: 'fr-CA' })} ${hm(p.suggestion.start, user.timezone)}` : 'demain, à placer'}`),
  ];
  return {
    id: uid(),
    type: 'plan',
    title: 'Réorganiser ma journée',
    detail: lines.join(' · '),
    changes: plan.changes.map((c) => ({ id: c.id, title: c.title, start: c.to.start, end: c.to.end })),
    postponed: plan.postponed.map((p) => ({ id: p.id, title: p.title, start: p.suggestion?.start ?? null, end: p.suggestion?.end ?? null, planDate: p.suggestion ? null : DateTime.now().setZone(user.timezone).plus({ days: 1 }).toISODate() })),
  };
}

function moveProposal(user: User, item: Item, startIso: string): Proposal {
  const end = new Date(Date.parse(startIso) + item.durationMin * 60000).toISOString();
  const d = DateTime.fromISO(startIso).setZone(user.timezone);
  const sameDay = d.toISODate() === today(user.timezone);
  return { id: uid(), type: 'move', itemId: item.id, title: `Déplacer « ${item.title} »`, detail: `${item.start ? `${hm(item.start, user.timezone)} → ` : ''}${sameDay ? '' : `${d.toFormat('cccc d', { locale: 'fr-CA' })} `}${hm(startIso, user.timezone)}`, start: startIso, end };
}

function postponeProposal(user: User, item: Item, date: string): Proposal {
  const d = DateTime.fromISO(date, { zone: user.timezone });
  const label = d.toFormat('cccc d LLLL', { locale: 'fr-CA' });
  if (item.start && (item.kind === 'fixed' || item.recurring)) {
    const s = DateTime.fromISO(item.start).setZone(user.timezone);
    const start = d.set({ hour: s.hour, minute: s.minute }).toUTC().toISO()!;
    return { id: uid(), type: 'postpone', itemId: item.id, title: `Reporter « ${item.title} »`, detail: `${label} à ${hm(start, user.timezone)}`, planDate: date, start, end: new Date(Date.parse(start) + item.durationMin * 60000).toISOString() };
  }
  return { id: uid(), type: 'postpone', itemId: item.id, title: `Reporter « ${item.title} »`, detail: `${label}, à placer dans la journée`, planDate: date, start: null, end: null };
}

const completeProposal = (user: User, item: Item): Proposal => ({ id: uid(), type: 'complete', itemId: item.id, title: `Marquer « ${item.title} » comme fait`, detail: item.start ? `prévu à ${hm(item.start, user.timezone)}` : 'tâche du jour' });

// ---------- Règles locales ----------

const tokens = (s: string) => strip(s).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t) => t.length > 2);
function findItem(items: Item[], text: string): Item | undefined {
  const words = new Set(tokens(text));
  let best: Item | undefined, score = 0;
  for (const it of items) {
    const tt = tokens(it.title);
    const s = tt.filter((t) => words.has(t) || [...words].some((w) => w.length > 3 && (t.startsWith(w) || w.startsWith(t)))).length / Math.max(1, tt.length);
    if (s > score) (best = it), (score = s);
  }
  return score >= 0.34 ? best : undefined;
}

const stem = (t: string) => t.slice(0, 4);
function findGoal(goals: GoalInfo[], text: string): GoalInfo | undefined {
  const words = tokens(text);
  let best: GoalInfo | undefined, score = 0;
  for (const g of goals) {
    const tt = tokens(g.goal.title);
    const hits = tt.filter((t) => words.some((w) => w === t || (w.length >= 4 && t.length >= 4 && stem(w) === stem(t)))).length;
    const s = hits / Math.max(1, tt.length);
    if (s > score) (best = g), (score = s);
  }
  return score > 0 ? best : undefined;
}

/** Valeur d'un progrès dans l'unité de l'objectif (minutes, dollars, nombre, 1 pour « à cocher »). */
function progressValue(g: GoalInfo, text: string): number | null {
  const t = strip(text).replace(',', '.');
  if (g.goal.metric === 'check') return 1;
  if (g.goal.metric === 'amount') {
    const m = t.match(/(\d+(?:\.\d+)?)\s*\$|\$\s*(\d+(?:\.\d+)?)/);
    return m ? Number(m[1] || m[2]) : null;
  }
  if (g.goal.metric === 'duration') {
    const h = t.match(/(\d+(?:\.\d+)?)\s*(?:h|heures?)\s*(\d{1,2})?/);
    if (h) return Math.round(Number(h[1]) * 60 + Number(h[2] || 0));
    const m = t.match(/(\d+)\s*(?:min|minutes?)\b/);
    return m ? Number(m[1]) : null;
  }
  const unit = strip(g.goal.unit || '');
  const withUnit = unit ? t.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 4)}`)) : null;
  if (withUnit) return Number(withUnit[1]);
  return /\bfois\b/.test(t) ? Number(t.match(/(\d+)\s*fois/)?.[1] || 1) : 1; // une séance de plus
}

function parseWhen(text: string, user: User): { date: string; time: { h: number; m: number } | null } {
  const t = strip(text);
  const now = DateTime.now().setZone(user.timezone);
  let d = now;
  if (/apres-demain|apres demain/.test(t)) d = now.plus({ days: 2 });
  else if (/demain/.test(t)) d = now.plus({ days: 1 });
  else {
    const days = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
    const i = days.findIndex((x) => new RegExp(`\\b${x}\\b`).test(t));
    if (i >= 0) d = now.plus({ days: ((i + 1 - now.weekday + 7) % 7) || 7 });
  }
  const m = t.match(/\b(\d{1,2})\s*(?:h|:)\s*(\d{2})?\b/);
  const time = m ? { h: Math.min(23, Number(m[1])), m: Math.min(59, Number(m[2] || 0)) } : null;
  return { date: d.toISODate()!, time };
}

function withRules(user: User, message: string): AssistantReply {
  const t = strip(message);
  const { items } = dayItems(user);
  const active = items.filter((i) => i.status === 'active');
  const reply = (r: string, proposals: Proposal[] = []): AssistantReply => ({ reply: r, proposals, source: 'rules', handled: true });
  /** Les règles n'ont pas pu conclure : Claude (s'il est configuré) prendra la demande. */
  const ask = (r: string): AssistantReply => ({ reply: r, proposals: [], source: 'rules', handled: false });

  const goals = userGoals(user);
  if (/objectif/.test(t) && !/\b(planifi|prevoi|bloque|reserve|cale)/.test(t)) return reply(goalsSummary(user));

  // Planifier un bloc pour un objectif : « planifie 30 min de lecture demain à 19 h »
  if (/\b(planifie|planifier|prevois|prevoir|bloque|bloquer|reserve|reserver|cale|caler)\b/.test(t)) {
    const g = findGoal(goals, message);
    if (g) {
      const when = parseWhen(message, user);
      if (!when.time) return ask(`À quelle heure veux-tu placer un bloc pour « ${g.goal.title} » ? Ex. : « planifie ${g.goal.title.toLowerCase()} demain à 19 h ».`);
      const minutes = Number(t.match(/(\d+)\s*(?:min|minutes?)\b/)?.[1] || 0);
      const durationMin = minutes || (g.goal.metric === 'duration' ? Math.min(120, Math.max(15, Math.round(g.remaining || g.target))) : 30);
      const start = DateTime.fromISO(when.date, { zone: user.timezone }).set({ hour: when.time.h, minute: when.time.m }).toUTC().toISO()!;
      return reply(`Je peux réserver ce temps pour « ${g.goal.title} ».`, [goalBlockProposal(user, g, start, durationMin)]);
    }
  }

  if (/reorganis|replanif|retard|deborde|trop charge|plus le temps|optimis|refai.* ma journee|reorg/.test(t)) {
    const p = planProposal(user, proposePlan(user.id, user.timezone, user.settings, today(user.timezone)));
    return p ? reply('Voici une journée réorganisée à partir de maintenant, en gardant tes rendez-vous fixes et tes pauses.', [p]) : reply('Ta journée tient déjà dans le temps qui reste : rien à déplacer.');
  }
  if (/\b(fini|finie|termine|terminee|fait|faite|complete|complété|accompli)\b/.test(t)) {
    const it = findItem(active, message);
    if (it) return reply(`Je peux marquer « ${it.title} » comme fait.`, [completeProposal(user, it)]);
    const g = findGoal(goals, message);
    if (g) {
      const v = progressValue(g, message);
      if (v) return reply(`Je peux noter ce progrès sur « ${g.goal.title} ».`, [goalProgressProposal(g, v)]);
    }
    return ask(active.length ? `Lequel as-tu terminé ? Il reste : ${active.map((i) => i.title).join(', ')}.` : 'Tout est déjà marqué comme fait aujourd’hui.');
  }
  // Progrès sur un objectif : « j'ai couru ce matin », « j'ai lu 25 min », « j'ai mis 100 $ de côté »
  if (/\bj.?ai\b/.test(t) && goals.length) {
    const g = findGoal(goals, message) || (/(epargn|economis|de cote|depose|rembours|verse)/.test(t) || /\d\s*\$/.test(t) ? goals.find((x) => x.goal.metric === 'amount') : undefined);
    if (g) {
      const v = progressValue(g, message);
      if (v) return reply(`Je peux noter ce progrès sur « ${g.goal.title} ».`, [goalProgressProposal(g, v)]);
      return ask(`Combien pour « ${g.goal.title} » ? Ex. : « j’ai ${g.goal.metric === 'amount' ? 'mis 50 $ de côté' : 'fait 30 min'} ».`);
    }
  }

  if (/\b(deplace|decale|bouge|reporte|repousse|remets|mets|place|avance|recule|change)\b/.test(t)) {
    const it = findItem(items, message);
    if (!it) return ask(`Quel élément veux-tu déplacer ? Aujourd’hui : ${items.map((i) => i.title).join(', ') || 'rien de prévu'}.`);
    const when = parseWhen(message, user);
    if (!when.time) {
      if (when.date !== today(user.timezone) || /report|repousse|remets/.test(t)) return reply(`Je peux reporter « ${it.title} ».`, [postponeProposal(user, it, when.date === today(user.timezone) ? DateTime.now().setZone(user.timezone).plus({ days: 1 }).toISODate()! : when.date)]);
      return ask(`À quelle heure veux-tu placer « ${it.title} » ? Ex. : « déplace ${it.title.toLowerCase()} à 15 h ».`);
    }
    const start = DateTime.fromISO(when.date, { zone: user.timezone }).set({ hour: when.time.h, minute: when.time.m }).toUTC().toISO()!;
    return reply(`Je peux déplacer « ${it.title} ».`, [moveProposal(user, it, start)]);
  }
  // Bilan demandé explicitement : les règles suffisent ; sinon la demande est libre et revient à Claude
  const asked = /(ou j.?en suis|bilan|progres|avancement|le point|resume|il me reste|reste.t.il|mon programme|ma journee|aujourd.?hui)/.test(t);
  return asked ? reply(daySummary(user)) : ask(daySummary(user));
}

// ---------- Claude ----------

// Outils courts : les identifiants sont des codes (e1, o1) traduits au retour, pour économiser des jetons.
const TOOLS: Anthropic.Beta.BetaTool[] = [
  { name: 'fait', description: 'Marquer un élément comme fait.', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'deplacer', description: 'Déplacer un élément (date AAAA-MM-JJ, heure HH:MM).', input_schema: { type: 'object', properties: { id: { type: 'string' }, date: { type: 'string' }, heure: { type: 'string' } }, required: ['id', 'date', 'heure'] } },
  { name: 'reporter', description: 'Reporter un élément à une date.', input_schema: { type: 'object', properties: { id: { type: 'string' }, date: { type: 'string' } }, required: ['id', 'date'] } },
  { name: 'progres', description: 'Noter un progrès sur un objectif (unité de l’objectif).', input_schema: { type: 'object', properties: { id: { type: 'string' }, valeur: { type: 'number' } }, required: ['id', 'valeur'] } },
  {
    name: 'bloc',
    description: 'Réserver du temps pour un objectif.',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, date: { type: 'string' }, heure: { type: 'string' }, minutes: { type: 'number' } }, required: ['id', 'date', 'heure', 'minutes'] },
  },
  { name: 'reorganiser', description: 'Réorganiser la journée à partir de maintenant.', input_schema: { type: 'object', properties: {} } },
];

const SYSTEM = `Assistant de journée (Québec, tutoiement). Pour tout changement, appelle un outil : il crée une proposition que la personne valide. Utilise seulement les codes fournis (e = élément du jour, o = objectif). Réponds en 1 à 2 phrases factuelles, sans emoji.`;

async function withClaude(user: User, message: string, history: { role: 'user' | 'assistant'; text: string }[]): Promise<AssistantReply> {
  const { date, items } = dayItems(user);
  const goals = userGoals(user);
  const tz = user.timezone;
  const hhmm = (iso: string | null) => (iso ? DateTime.fromISO(iso).setZone(tz).toFormat('HH:mm') : '-');
  // Contexte compact : « code|titre|heure|minutes|r(endez-vous) ou t(âche)|x si fait »
  const itemCode = new Map(items.map((it, i) => [`e${i + 1}`, it]));
  const goalCode = new Map(goals.map((g, i) => [`o${i + 1}`, g]));
  const unit = (g: GoalInfo) => (g.goal.metric === 'duration' ? 'min' : g.goal.metric === 'amount' ? '$' : g.goal.metric === 'check' ? 'fait' : g.goal.unit);
  const itemsTxt = [...itemCode].map(([c, i]) => `${c}|${i.title}|${hhmm(i.start)}|${i.durationMin}|${i.kind === 'fixed' ? 'r' : 't'}${i.status === 'done' ? '|x' : ''}`).join('\n');
  const goalsTxt = [...goalCode].map(([c, g]) => `${c}|${g.goal.title}|${g.done}/${g.target} ${unit(g)}|${g.goal.period}`).join('\n');
  const now = DateTime.now().setZone(tz);
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...history.slice(-4).map((h) => ({ role: h.role, content: h.text.slice(0, 300) })),
    { role: 'user', content: `${date} ${now.toFormat('HH:mm')}\nÉléments:\n${itemsTxt || '(aucun)'}\nObjectifs:\n${goalsTxt || '(aucun)'}\n\n${message.slice(0, 500)}` },
  ];
  const model = config.ai.textModel;
  const client = new Anthropic({ apiKey: config.vision.anthropicKey, timeout: 30_000, maxRetries: 1 });
  // Un seul appel : les outils ne font que créer des propositions, inutile de renvoyer le contexte pour un second tour.
  const response = await client.beta.messages.create({
    model,
    max_tokens: 1500,
    ...fallbackParams(model),
    output_config: { effort: 'low' },
    system: SYSTEM,
    tools: TOOLS,
    messages,
  } as any);
  recordUsage(user.id, 'assistant', model, (response as any).usage);
  if (response.stop_reason === 'refusal') return withRules(user, message);
  const proposals: Proposal[] = [];
  const issues: string[] = [];
  for (const u of response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')) {
    const inp = (u.input || {}) as any;
    const item = itemCode.get(inp.id);
    const goal = goalCode.get(inp.id);
    const okDate = /^\d{4}-\d{2}-\d{2}$/.test(inp.date || '');
    const okTime = /^\d{1,2}:\d{2}$/.test(inp.heure || '');
    const at = () => DateTime.fromISO(`${inp.date}T${String(inp.heure).padStart(5, '0')}`, { zone: tz }).toUTC().toISO()!;
    if (u.name === 'reorganiser') {
      const p = planProposal(user, proposePlan(user.id, tz, user.settings, date));
      if (p) proposals.push(p);
      else issues.push('Ta journée tient déjà dans le temps qui reste.');
    } else if (u.name === 'fait' && item) proposals.push(completeProposal(user, item));
    else if (u.name === 'deplacer' && item && okDate && okTime) proposals.push(moveProposal(user, item, at()));
    else if (u.name === 'reporter' && item && okDate) proposals.push(postponeProposal(user, item, inp.date));
    else if (u.name === 'progres' && goal && Number(inp.valeur) > 0) proposals.push(goalProgressProposal(goal, Number(inp.valeur)));
    else if (u.name === 'bloc' && goal && okDate && okTime) proposals.push(goalBlockProposal(user, goal, at(), Math.min(240, Math.max(10, Math.round(Number(inp.minutes) || 30)))));
  }
  const text = response.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
  return { reply: text || issues[0] || (proposals.length ? 'Voici ma proposition : applique-la si elle te convient.' : daySummary(user)), proposals, source: 'ai' };
}

/**
 * Économe en jetons : les règles locales répondent d'abord (bilan, objectifs, « j'ai fini », déplacer, reporter, réorganiser) ;
 * Claude n'est appelé que pour une demande qu'elles ne savent pas traiter, dans la limite quotidienne par personne.
 */
export async function assistantReply(user: User, message: string, history: { role: 'user' | 'assistant'; text: string }[] = []): Promise<AssistantReply> {
  const text = String(message || '').trim();
  if (!text) return { reply: daySummary(user), proposals: [], source: 'rules' };
  const rules = withRules(user, text);
  const done = ({ handled, ...r }: AssistantReply) => r;
  if (rules.handled || rules.proposals.length || !config.vision.anthropicKey || !aiAllowed(user.id, user.timezone)) return done(rules);
  try {
    return await withClaude(user, text, history.filter((h) => (h.role === 'user' || h.role === 'assistant') && typeof h.text === 'string'));
  } catch (e) {
    console.error('[assistant] Claude indisponible, règles locales :', e instanceof Anthropic.APIError ? e.status : e instanceof Error ? e.message : e);
    return done(rules);
  }
}

/** Applique une proposition acceptée (sur mon agenda seulement). */
export function applyProposal(user: User, p: Proposal): string {
  const mine = (id: string) => {
    const o = getOccurrence(user.id, id);
    if (!o) throw new Error('Élément introuvable dans ton agenda');
    if (o.source !== 'plwr') throw new Error('Cet élément vient d’un agenda relié : modifie-le à sa source');
    return o;
  };
  if (p.type === 'complete') {
    mine(p.itemId);
    updateOccurrence(user.id, p.itemId, { status: 'done' }, 'this');
    return 'Marqué comme fait.';
  }
  if (p.type === 'move') {
    mine(p.itemId);
    updateOccurrence(user.id, p.itemId, { start: p.start, end: p.end }, 'this');
    return `Déplacé à ${hm(p.start, user.timezone)}.`;
  }
  if (p.type === 'postpone') {
    const o = mine(p.itemId);
    if (p.start && p.end) updateOccurrence(user.id, p.itemId, { start: p.start, end: p.end }, 'this');
    else if (!o.recurrenceId) updateOccurrence(user.id, p.itemId, { start: null, planDate: p.planDate }, 'this');
    else throw new Error('Une occurrence d’une série doit garder une heure');
    return 'Reporté.';
  }
  if (p.type === 'goal_progress') {
    const r = get('SELECT * FROM goals WHERE id = ? AND user_id = ? AND archived = 0', p.goalId, user.id);
    if (!r) throw new Error('Objectif introuvable');
    const g = rowToGoal(r);
    const value = Number(p.value);
    if (!(value > 0) || value > 1_000_000) throw new Error('Valeur invalide');
    const d = today(user.timezone);
    if (g.metric === 'check') run('DELETE FROM goal_entries WHERE goal_id = ? AND date = ? AND event_id IS NULL', g.id, d);
    run('INSERT INTO goal_entries (id, user_id, goal_id, date, value, note, created_at) VALUES (?,?,?,?,?,?,?)', uid(), user.id, g.id, d, g.metric === 'check' ? 1 : value, 'Noté avec l’assistant', nowIso());
    const pr = goalProgress(g, user.timezone);
    return g.metric === 'check' ? `${g.title} : fait.` : `${g.title} : ${formatGoalValue(g, pr.done)} sur ${formatGoalValue(g, pr.target)}.`;
  }
  if (p.type === 'goal_block') {
    if (!get('SELECT 1 FROM goals WHERE id = ? AND user_id = ? AND archived = 0', p.goalId, user.id)) throw new Error('Objectif introuvable');
    if (!p.start || !p.end || Date.parse(p.end) <= Date.parse(p.start)) throw new Error('Horaire invalide');
    const durationMin = Math.round((Date.parse(p.end) - Date.parse(p.start)) / 60000);
    createEvent(user.id, { title: String(p.blockTitle || 'Bloc objectif').slice(0, 120), kind: 'flexible', start: p.start, durationMin, goalIds: [p.goalId], reminders: [10] });
    return `Bloc planifié à ${hm(p.start, user.timezone)}.`;
  }
  if (p.type === 'plan') {
    for (const c of p.changes || []) (mine(c.id), updateOccurrence(user.id, c.id, { start: c.start, end: c.end }, 'this'));
    for (const x of p.postponed || []) {
      const o = mine(x.id);
      if (x.start && x.end) updateOccurrence(user.id, x.id, { start: x.start, end: x.end }, 'this');
      else if (!o.recurrenceId) updateOccurrence(user.id, x.id, { start: null, planDate: x.planDate || DateTime.now().setZone(user.timezone).plus({ days: 1 }).toISODate() }, 'this');
    }
    return 'Journée réorganisée.';
  }
  throw new Error('Proposition inconnue');
}
