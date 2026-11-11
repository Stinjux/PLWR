import { DateTime } from 'luxon';
import type { Occurrence } from './events.ts';
import { listOccurrences, listUnscheduled } from './events.ts';
import { atTime, dayBounds } from '../time.ts';
import type { UserSettings } from '../auth.ts';

type Interval = { s: number; e: number; label?: string };

export type PlanChange = {
  id: string;
  title: string;
  kind: 'move' | 'schedule';
  from: { start: string; end: string } | null;
  to: { start: string; end: string };
  lateForDue?: boolean;
};
export type PlanPostponed = {
  id: string;
  title: string;
  durationMin: number;
  reason: string;
  suggestion: { start: string; end: string } | null;
};
export type PlanResult = {
  date: string;
  changes: PlanChange[];
  kept: string[];
  postponed: PlanPostponed[];
  freeMinutes: number;
  neededMinutes: number;
  overloaded: boolean;
  breaks: { label: string; start: string; end: string }[];
};

export type PlanInput = {
  date: string;
  tz: string;
  now: Date;
  settings: Pick<UserSettings, 'dayStart' | 'dayEnd' | 'bufferMinutes' | 'breaks'>;
  keepBreaks?: string[]; // libellés des pauses à préserver (par défaut toutes)
  dayStart?: string;
  dayEnd?: string;
  occurrences: Occurrence[]; // occurrences planifiées de la journée
  unscheduled: Occurrence[]; // tâches à placer
  /** Occurrences des jours suivants, pour proposer un autre créneau. */
  futureDays?: { date: string; occurrences: Occurrence[] }[];
};

const MIN = 60_000;
const STEP = 5 * MIN;
const ceilStep = (t: number) => Math.ceil(t / STEP) * STEP;

function windowFor(pref: string | null, date: string, tz: string, dayStart: string, dayEnd: string): Interval | null {
  if (!pref) return null;
  const map: Record<string, [string, string]> = {
    matin: [dayStart, '12:00'],
    'apres-midi': ['12:00', '17:00'],
    soir: ['17:00', dayEnd],
  };
  let range = map[pref];
  if (!range) {
    const m = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(pref);
    if (!m) return null;
    range = [m[1], m[2]];
  }
  return { s: atTime(date, range[0], tz).toMillis(), e: atTime(date, range[1], tz).toMillis() };
}

const overlaps = (a: Interval, b: Interval) => a.s < b.e && b.s < a.e;

function score(o: Occurrence): [number, number, number] {
  return [o.priority, o.dueAt ? Date.parse(o.dueAt) : Number.MAX_SAFE_INTEGER, o.start ? Date.parse(o.start) : Number.MAX_SAFE_INTEGER];
}
function cmp(a: Occurrence, b: Occurrence) {
  const x = score(a), y = score(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

type DayCtx = { win: Interval; busy: Interval[]; buffer: number; date: string };

function isFree(ctx: DayCtx, iv: Interval): boolean {
  if (iv.s < ctx.win.s || iv.e > ctx.win.e) return false;
  for (const b of ctx.busy) {
    const padded = b.label === 'pause' ? b : { s: b.s - ctx.buffer, e: b.e + ctx.buffer };
    if (overlaps(iv, padded)) return false;
  }
  return true;
}

function findSlot(ctx: DayCtx, durMs: number, opts: { pref?: Interval | null; after?: number; due?: number | null }): Interval | null {
  const candidates: { iv: Interval; cost: number }[] = [];
  for (let t = ceilStep(ctx.win.s); t + durMs <= ctx.win.e; t += STEP) {
    const iv = { s: t, e: t + durMs };
    if (!isFree(ctx, iv)) continue;
    let cost = 0;
    if (opts.pref) cost += iv.s >= opts.pref.s && iv.e <= opts.pref.e ? 0 : 1e9 + Math.min(Math.abs(iv.s - opts.pref.s), Math.abs(iv.e - opts.pref.e));
    if (opts.due && iv.e > opts.due) cost += 1e12;
    if (opts.after !== undefined) cost += iv.s >= opts.after ? (iv.s - opts.after) / MIN : 1e6 + (opts.after - iv.s) / MIN;
    else cost += (iv.s - ctx.win.s) / MIN;
    candidates.push({ iv, cost });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.cost - b.cost);
  return candidates[0].iv;
}

function breakIntervals(date: string, tz: string, settings: PlanInput['settings'], keep?: string[]): Interval[] {
  return settings.breaks
    .filter((b) => !keep || keep.includes(b.label))
    .map((b) => ({ s: atTime(date, b.start, tz).toMillis(), e: atTime(date, b.end, tz).toMillis(), label: 'pause' }));
}

const iso = (t: number) => new Date(t).toISOString();

export function planDay(input: PlanInput): PlanResult {
  const { date, tz, settings } = input;
  const nowMs = input.now.getTime();
  const dayStart = input.dayStart || settings.dayStart;
  const dayEnd = input.dayEnd || settings.dayEnd;
  let winS = atTime(date, dayStart, tz).toMillis();
  const winE = atTime(date, dayEnd, tz).toMillis();
  if (nowMs > winS) winS = ceilStep(nowMs);
  const win = { s: winS, e: winE };
  const buffer = (settings.bufferMinutes || 0) * MIN;
  const breaks = breakIntervals(date, tz, settings, input.keepBreaks);

  const busy: Interval[] = [...breaks];
  const movable: Occurrence[] = [];
  for (const o of input.occurrences) {
    if (o.status === 'cancelled' || !o.start || !o.end) continue;
    const iv = { s: Date.parse(o.start), e: Date.parse(o.end) };
    if (o.kind === 'fixed' || o.status === 'done' || iv.s < nowMs) busy.push(iv); // fixes, terminés, passés ou en cours : immobiles
    else movable.push(o);
  }
  const toPlace = input.unscheduled.filter((o) => o.status === 'active' && !o.start);

  const ctx: DayCtx = { win, busy, buffer, date };
  const kept: string[] = [];
  const displaced: Occurrence[] = [];
  for (const o of [...movable].sort(cmp)) {
    const iv = { s: Date.parse(o.start!), e: Date.parse(o.end!) };
    if (isFree(ctx, iv)) {
      busy.push(iv);
      kept.push(o.id);
    } else displaced.push(o);
  }

  const changes: PlanChange[] = [];
  const postponed: PlanPostponed[] = [];
  const queue = [...displaced, ...toPlace].sort(cmp);
  for (const o of queue) {
    const durMs = o.durationMin * MIN;
    const pref = windowFor(o.preferredWindow, date, tz, dayStart, dayEnd);
    const due = o.dueAt ? Date.parse(o.dueAt) : null;
    const slot = findSlot(ctx, durMs, { pref, after: o.start ? Date.parse(o.start) : undefined, due });
    if (slot) {
      busy.push(slot);
      changes.push({
        id: o.id,
        title: o.title,
        kind: o.start ? 'move' : 'schedule',
        from: o.start ? { start: o.start, end: o.end! } : null,
        to: { start: iso(slot.s), end: iso(slot.e) },
        lateForDue: due !== null && slot.e > due,
      });
    } else {
      postponed.push({ id: o.id, title: o.title, durationMin: o.durationMin, reason: 'Pas assez de temps libre aujourd’hui', suggestion: null });
    }
  }

  // Proposer un autre créneau dans les jours suivants
  for (const p of postponed) {
    const o = queue.find((q) => q.id === p.id)!;
    for (const fd of input.futureDays || []) {
      const fBusy: Interval[] = [...breakIntervals(fd.date, tz, settings, input.keepBreaks)];
      for (const x of fd.occurrences) if (x.start && x.end && x.status !== 'cancelled') fBusy.push({ s: Date.parse(x.start), e: Date.parse(x.end) });
      const fctx: DayCtx = {
        win: { s: Math.max(atTime(fd.date, dayStart, tz).toMillis(), ceilStep(nowMs)), e: atTime(fd.date, dayEnd, tz).toMillis() },
        busy: fBusy,
        buffer,
        date: fd.date,
      };
      const slot = findSlot(fctx, o.durationMin * MIN, { pref: windowFor(o.preferredWindow, fd.date, tz, dayStart, dayEnd) });
      if (slot) {
        p.suggestion = { start: iso(slot.s), end: iso(slot.e) };
        fd.occurrences.push({ ...o, start: iso(slot.s), end: iso(slot.e) });
        break;
      }
    }
  }

  // Temps libre total vs temps nécessaire (alerte de surcharge)
  let free = 0;
  const merged = [...input.occurrences.filter((o) => o.kind === 'fixed' && o.start && o.status !== 'cancelled').map((o) => ({ s: Date.parse(o.start!), e: Date.parse(o.end!) })), ...breaks]
    .map((b) => ({ s: Math.max(b.s, win.s), e: Math.min(b.e, win.e) }))
    .filter((b) => b.e > b.s)
    .sort((a, b) => a.s - b.s);
  let cursor = win.s;
  for (const b of merged) {
    if (b.s > cursor) free += b.s - cursor;
    cursor = Math.max(cursor, b.e);
  }
  if (win.e > cursor) free += win.e - cursor;
  const needed = [...movable, ...toPlace].reduce((s, o) => s + o.durationMin, 0);

  return {
    date,
    changes,
    kept,
    postponed,
    freeMinutes: Math.round(free / MIN),
    neededMinutes: needed,
    overloaded: postponed.length > 0 || needed > free / MIN,
    breaks: breaks.map((b, i) => ({ label: (input.keepBreaks ? settings.breaks.filter((x) => input.keepBreaks!.includes(x.label)) : settings.breaks)[i]?.label || 'Pause', start: iso(b.s), end: iso(b.e) })),
  };
}

/** Prépare les données depuis la base et calcule la proposition. */
export function proposePlan(
  userId: string,
  tz: string,
  settings: UserSettings,
  date: string,
  opts: { keepBreaks?: string[]; dayStart?: string; dayEnd?: string; now?: Date } = {},
): PlanResult {
  const { start, end } = dayBounds(date, tz);
  const occurrences = listOccurrences(userId, tz, start, end);
  const unscheduled = listUnscheduled(userId).filter((o) => o.planDate === date || (!o.planDate && o.dueAt && o.dueAt < end));
  const futureDays: { date: string; occurrences: Occurrence[] }[] = [];
  for (let i = 1; i <= 7; i++) {
    const d = DateTime.fromISO(date, { zone: tz }).plus({ days: i }).toISODate()!;
    const b = dayBounds(d, tz);
    futureDays.push({ date: d, occurrences: listOccurrences(userId, tz, b.start, b.end) });
  }
  return planDay({ date, tz, now: opts.now ?? new Date(), settings, keepBreaks: opts.keepBreaks, dayStart: opts.dayStart, dayEnd: opts.dayEnd, occurrences, unscheduled, futureDays });
}
