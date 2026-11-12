import Anthropic from '@anthropic-ai/sdk';
import { DateTime } from 'luxon';
import { uid } from '../db.ts';
import { config } from '../config.ts';
import type { User } from '../auth.ts';
import { dayBounds, today } from '../time.ts';
import { getOccurrence, listOccurrences, listUnscheduled, updateOccurrence, type Occurrence } from './events.ts';
import { proposePlan, type PlanResult } from './planner.ts';
import { strip } from './expenseParser.ts';

/**
 * Assistant de la journée : fait le point sur les tâches du jour, réorganise la journée, déplace ou reporte un élément.
 * Il ne modifie RIEN lui-même : il renvoie des propositions que la personne applique d'un geste (« Appliquer »).
 * Claude s'en charge quand une clé est configurée ; sinon, des règles locales couvrent les demandes courantes.
 */

export type Proposal =
  | { id: string; type: 'complete'; itemId: string; title: string; detail: string }
  | { id: string; type: 'move'; itemId: string; title: string; detail: string; start: string; end: string }
  | { id: string; type: 'postpone'; itemId: string; title: string; detail: string; planDate: string; start: string | null; end: string | null }
  | { id: string; type: 'plan'; title: string; detail: string; changes: { id: string; title: string; start: string; end: string }[]; postponed: { id: string; title: string; start: string | null; end: string | null; planDate: string | null }[] };

export type AssistantReply = { reply: string; proposals: Proposal[]; source: 'ai' | 'rules' };
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
  const reply = (r: string, proposals: Proposal[] = []): AssistantReply => ({ reply: r, proposals, source: 'rules' });

  if (/reorganis|replanif|retard|deborde|trop charge|plus le temps|optimis|refai.* ma journee|reorg/.test(t)) {
    const p = planProposal(user, proposePlan(user.id, user.timezone, user.settings, today(user.timezone)));
    return p ? reply('Voici une journée réorganisée à partir de maintenant, en gardant tes rendez-vous fixes et tes pauses.', [p]) : reply('Ta journée tient déjà dans le temps qui reste : rien à déplacer.');
  }
  if (/\b(fini|finie|termine|terminee|fait|faite|complete|complété|accompli)\b/.test(t)) {
    const it = findItem(active, message);
    if (it) return reply(`Je peux marquer « ${it.title} » comme fait.`, [completeProposal(user, it)]);
    return reply(active.length ? `Lequel as-tu terminé ? Il reste : ${active.map((i) => i.title).join(', ')}.` : 'Tout est déjà marqué comme fait aujourd’hui.');
  }
  if (/\b(deplace|decale|bouge|reporte|repousse|remets|mets|place|avance|recule|change)\b/.test(t)) {
    const it = findItem(items, message);
    if (!it) return reply(`Quel élément veux-tu déplacer ? Aujourd’hui : ${items.map((i) => i.title).join(', ') || 'rien de prévu'}.`);
    const when = parseWhen(message, user);
    if (!when.time) {
      if (when.date !== today(user.timezone) || /report|repousse|remets/.test(t)) return reply(`Je peux reporter « ${it.title} ».`, [postponeProposal(user, it, when.date === today(user.timezone) ? DateTime.now().setZone(user.timezone).plus({ days: 1 }).toISODate()! : when.date)]);
      return reply(`À quelle heure veux-tu placer « ${it.title} » ? Ex. : « déplace ${it.title.toLowerCase()} à 15 h ».`);
    }
    const start = DateTime.fromISO(when.date, { zone: user.timezone }).set({ hour: when.time.h, minute: when.time.m }).toUTC().toISO()!;
    return reply(`Je peux déplacer « ${it.title} ».`, [moveProposal(user, it, start)]);
  }
  return reply(daySummary(user));
}

// ---------- Claude ----------

const TOOLS: Anthropic.Beta.BetaTool[] = [
  { name: 'propose_complete', description: 'Propose de marquer un élément du jour comme fait.', input_schema: { type: 'object', properties: { item_id: { type: 'string' } }, required: ['item_id'] } },
  {
    name: 'propose_move',
    description: 'Propose de déplacer un élément à une date et une heure (heure locale).',
    input_schema: { type: 'object', properties: { item_id: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' }, time: { type: 'string', description: 'HH:MM, 24 h' } }, required: ['item_id', 'date', 'time'] },
  },
  {
    name: 'propose_postpone',
    description: 'Propose de reporter un élément à un autre jour (même heure pour un rendez-vous, « à placer » pour une tâche).',
    input_schema: { type: 'object', properties: { item_id: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' } }, required: ['item_id', 'date'] },
  },
  { name: 'propose_reorganize', description: 'Propose une journée réorganisée à partir de maintenant (rendez-vous fixes et pauses gardés, tâches replacées ou reportées).', input_schema: { type: 'object', properties: {} } },
];

const SYSTEM = `Tu es l'assistant de la journée dans PLWR, une app d'agenda, d'objectifs et de budget (Québec, français, tutoiement).
Tu aides la personne à suivre l'avancement de ses tâches d'aujourd'hui, à réorganiser sa journée et à replanifier des éléments.
Règles :
- Tu ne modifies rien toi-même : utilise les outils propose_* pour créer des propositions ; la personne les applique d'un geste. Dis-le simplement.
- N'utilise que les identifiants d'éléments fournis dans le contexte.
- Réponds en 1 à 3 phrases courtes, factuelles et chaleureuses. Pas d'emoji, pas de slogans.
- Pour un bilan, donne les chiffres (fait / total), le prochain élément et ce qui reste.`;

async function withClaude(user: User, message: string, history: { role: 'user' | 'assistant'; text: string }[]): Promise<AssistantReply> {
  const { date, items } = dayItems(user);
  const byId = new Map(items.map((i) => [i.id, i]));
  const ctx = items.map((i) => ({ id: i.id, titre: i.title, type: i.kind === 'fixed' ? 'rendez-vous' : 'tâche', debut: i.start ? DateTime.fromISO(i.start).setZone(user.timezone).toFormat('HH:mm') : null, duree_min: i.durationMin, statut: i.status, recurrent: i.recurring }));
  const now = DateTime.now().setZone(user.timezone);
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...history.slice(-8).map((h) => ({ role: h.role, content: h.text.slice(0, 1000) })),
    { role: 'user', content: `Contexte (aujourd'hui ${date}, il est ${now.toFormat('HH:mm')}, fuseau ${user.timezone}) :\n${JSON.stringify(ctx)}\n\nMessage : ${message.slice(0, 1000)}` },
  ];
  const proposals: Proposal[] = [];
  const client = new Anthropic({ apiKey: config.vision.anthropicKey, timeout: 30_000, maxRetries: 1 });
  for (let turn = 0; turn < 4; turn++) {
    const response = await client.beta.messages.create({
      model: config.vision.anthropicModel,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system: SYSTEM,
      tools: TOOLS,
      messages,
    });
    if (response.stop_reason === 'refusal') return withRules(user, message);
    const uses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (!uses.length || response.stop_reason !== 'tool_use') {
      const text = response.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
      return { reply: text || daySummary(user), proposals, source: 'ai' };
    }
    messages.push({ role: 'assistant', content: response.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = uses.map((u) => {
      const input = (u.input || {}) as Record<string, string>;
      const item = input.item_id ? byId.get(input.item_id) : undefined;
      let out = 'Proposition créée, en attente de confirmation.';
      try {
        if (u.name === 'propose_reorganize') {
          const p = planProposal(user, proposePlan(user.id, user.timezone, user.settings, date));
          if (p) proposals.push(p);
          else out = 'Rien à déplacer : la journée tient dans le temps qui reste.';
        } else if (!item) out = 'Élément inconnu : utilise un identifiant du contexte.';
        else if (u.name === 'propose_complete') proposals.push(completeProposal(user, item));
        else if (u.name === 'propose_postpone' && /^\d{4}-\d{2}-\d{2}$/.test(input.date || '')) proposals.push(postponeProposal(user, item, input.date));
        else if (u.name === 'propose_move' && /^\d{4}-\d{2}-\d{2}$/.test(input.date || '') && /^\d{1,2}:\d{2}$/.test(input.time || '')) {
          proposals.push(moveProposal(user, item, DateTime.fromISO(`${input.date}T${input.time.padStart(5, '0')}`, { zone: user.timezone }).toUTC().toISO()!));
        } else out = 'Paramètres invalides.';
      } catch (e) {
        out = e instanceof Error ? e.message : 'Erreur';
      }
      return { type: 'tool_result', tool_use_id: u.id, content: out };
    });
    messages.push({ role: 'user', content: results });
  }
  return { reply: 'Voici mes propositions.', proposals, source: 'ai' };
}

export async function assistantReply(user: User, message: string, history: { role: 'user' | 'assistant'; text: string }[] = []): Promise<AssistantReply> {
  const text = String(message || '').trim();
  if (!text) return { reply: daySummary(user), proposals: [], source: 'rules' };
  if (!config.vision.anthropicKey) return withRules(user, text);
  try {
    return await withClaude(user, text, history.filter((h) => (h.role === 'user' || h.role === 'assistant') && typeof h.text === 'string'));
  } catch (e) {
    console.error('[assistant] Claude indisponible, règles locales :', e instanceof Anthropic.APIError ? e.status : e instanceof Error ? e.message : e);
    return withRules(user, text);
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
