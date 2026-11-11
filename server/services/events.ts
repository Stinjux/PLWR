import { DateTime } from 'luxon';
import { all, get, run, uid, nowIso, parseJson, tx } from '../db.ts';
import { toUtcIso } from '../time.ts';

export type RRule = {
  freq: 'daily' | 'weekly' | 'monthly';
  interval?: number;
  byDay?: number[]; // 1 = lundi … 7 = dimanche
  until?: string | null; // YYYY-MM-DD (inclus)
  count?: number | null;
};

export type Occurrence = {
  id: string;
  eventId: string;
  seriesId: string | null;
  recurrenceId: string | null;
  title: string;
  kind: 'fixed' | 'flexible';
  start: string | null;
  end: string | null;
  durationMin: number;
  dueAt: string | null;
  priority: number;
  preferredWindow: string | null;
  planDate: string | null;
  location: string | null;
  notes: string | null;
  rrule: RRule | null;
  status: 'active' | 'done' | 'cancelled';
  focusDate: string | null;
  reminders: number[];
  dueReminders: number[];
  goalIds: string[];
  isRecurring: boolean;
  sample: boolean;
};

const SEP = '::';
export const occId = (masterId: string, recurrenceId: string) => `${masterId}${SEP}${recurrenceId}`;
export function parseOccId(id: string): { eventId: string; recurrenceId: string | null } {
  const i = id.indexOf(SEP);
  if (i < 0) return { eventId: id, recurrenceId: null };
  return { eventId: id.slice(0, i), recurrenceId: id.slice(i + SEP.length) };
}

function goalIdsFor(eventId: string): string[] {
  return all<{ goal_id: string }>('SELECT goal_id FROM goal_links WHERE event_id = ?', eventId).map((r) => r.goal_id);
}

function rowToOcc(row: any, master?: any, recurrenceId?: string | null): Occurrence {
  const baseId = master ? master.id : row.id;
  const rec = recurrenceId ?? row.recurrence_id ?? null;
  return {
    id: rec ? occId(baseId, rec) : row.id,
    eventId: row.id,
    seriesId: master ? master.id : row.series_id,
    recurrenceId: rec,
    title: row.title,
    kind: row.kind,
    start: row.start_at,
    end: row.end_at,
    durationMin: row.duration_min,
    dueAt: row.due_at,
    priority: row.priority,
    preferredWindow: row.preferred_window,
    planDate: row.plan_date,
    location: row.location,
    notes: row.notes,
    rrule: parseJson((master ?? row).rrule, null),
    status: row.status,
    focusDate: row.focus_date,
    reminders: parseJson(row.reminders, []),
    dueReminders: parseJson(row.due_reminders, []),
    goalIds: goalIdsFor(master ? master.id : row.series_id || row.id),
    isRecurring: Boolean(master || row.series_id || row.rrule),
    sample: Boolean(row.sample),
  };
}

/** Génère les débuts d'occurrence (UTC ISO) d'une règle entre from et to, en heure locale (respecte l'heure d'été). */
export function expandRule(startIso: string, rule: RRule, tz: string, fromIso: string, toIso: string): string[] {
  const start = DateTime.fromISO(startIso, { zone: 'utc' }).setZone(tz);
  const from = DateTime.fromISO(fromIso, { zone: 'utc' });
  const to = DateTime.fromISO(toIso, { zone: 'utc' });
  const interval = Math.max(1, rule.interval || 1);
  const until = rule.until ? DateTime.fromISO(rule.until, { zone: tz }).endOf('day') : null;
  const out: string[] = [];
  let count = 0;
  const push = (d: DateTime): boolean => {
    if (until && d > until) return false;
    if (rule.count && count >= rule.count) return false;
    if (d > to) return false;
    count++;
    if (d >= start && d.toUTC() >= from.minus({ days: 1 })) out.push(d.toUTC().toISO()!);
    return true;
  };
  const time = { hour: start.hour, minute: start.minute, second: 0, millisecond: 0 };
  for (let i = 0; i < 2000; i++) {
    if (rule.freq === 'daily') {
      if (!push(start.plus({ days: i * interval }).set(time))) break;
    } else if (rule.freq === 'weekly') {
      const weekStart = start.startOf('week').plus({ weeks: i * interval });
      const days = (rule.byDay && rule.byDay.length ? [...rule.byDay] : [start.weekday]).sort();
      let cont = true;
      for (const wd of days) {
        const d = weekStart.plus({ days: wd - 1 }).set(time);
        if (d < start) continue;
        if (!push(d)) {
          cont = false;
          break;
        }
      }
      if (!cont) break;
    } else {
      const d = start.plus({ months: i * interval }).set(time);
      if (!push(d)) break;
    }
  }
  // filtre final : occurrences qui chevauchent [from, to]
  return out.filter((s) => s < toIso);
}

/** Liste les occurrences (séries développées + exceptions) dont l'intervalle chevauche [from, to). */
export function listOccurrences(
  userId: string,
  tz: string,
  fromIso: string,
  toIso: string,
  opts: { includeCancelled?: boolean } = {},
): Occurrence[] {
  const out: Occurrence[] = [];
  // Événements simples
  const singles = all(
    `SELECT * FROM events WHERE user_id = ? AND rrule IS NULL AND series_id IS NULL AND start_at IS NOT NULL
     AND start_at < ? AND end_at > ?`,
    userId,
    toIso,
    fromIso,
  );
  for (const r of singles) if (opts.includeCancelled || r.status !== 'cancelled') out.push(rowToOcc(r));

  // Séries
  const masters = all(`SELECT * FROM events WHERE user_id = ? AND rrule IS NOT NULL AND series_id IS NULL AND start_at IS NOT NULL`, userId);
  for (const m of masters) {
    const rule = parseJson<RRule | null>(m.rrule, null);
    if (!rule) continue;
    const durMs = DateTime.fromISO(m.end_at).toMillis() - DateTime.fromISO(m.start_at).toMillis();
    const exceptions = new Map<string, any>(
      all('SELECT * FROM events WHERE series_id = ?', m.id).map((e) => [e.recurrence_id, e]),
    );
    const fromWide = DateTime.fromISO(fromIso).minus({ milliseconds: durMs }).toUTC().toISO()!;
    for (const s of expandRule(m.start_at, rule, tz, fromWide, toIso)) {
      const ex = exceptions.get(s);
      if (ex) continue; // traité plus bas
      const e = DateTime.fromISO(s).plus({ milliseconds: durMs }).toUTC().toISO()!;
      if (e <= fromIso || s >= toIso) continue;
      const occ = rowToOcc({ ...m, start_at: s, end_at: e }, m, s);
      if (opts.includeCancelled || occ.status !== 'cancelled') out.push(occ);
    }
    for (const ex of exceptions.values()) {
      if (!ex.start_at || ex.start_at >= toIso || ex.end_at <= fromIso) continue;
      if (!opts.includeCancelled && ex.status === 'cancelled') continue;
      out.push(rowToOcc(ex, m, ex.recurrence_id));
    }
  }
  out.sort((a, b) => (a.start! < b.start! ? -1 : a.start! > b.start! ? 1 : 0));
  return out;
}

/** Tâches non planifiées pour une date (ou en retard). */
export function listUnscheduled(userId: string, date?: string): Occurrence[] {
  const rows = date
    ? all(
        `SELECT * FROM events WHERE user_id = ? AND start_at IS NULL AND series_id IS NULL AND status != 'cancelled'
         AND (plan_date = ? OR (plan_date IS NULL AND status = 'active'))`,
        userId,
        date,
      )
    : all(`SELECT * FROM events WHERE user_id = ? AND start_at IS NULL AND series_id IS NULL AND status != 'cancelled'`, userId);
  return rows.map((r) => rowToOcc(r));
}

export function getOccurrence(userId: string, id: string): Occurrence | undefined {
  const { eventId, recurrenceId } = parseOccId(id);
  const row = get('SELECT * FROM events WHERE id = ? AND user_id = ?', eventId, userId);
  if (!row) return undefined;
  if (!recurrenceId) return rowToOcc(row);
  const ex = get('SELECT * FROM events WHERE series_id = ? AND recurrence_id = ?', eventId, recurrenceId);
  if (ex) return rowToOcc(ex, row, recurrenceId);
  const durMs = DateTime.fromISO(row.end_at).toMillis() - DateTime.fromISO(row.start_at).toMillis();
  const end = DateTime.fromISO(recurrenceId).plus({ milliseconds: durMs }).toUTC().toISO()!;
  return rowToOcc({ ...row, start_at: recurrenceId, end_at: end }, row, recurrenceId);
}

export type EventInput = Partial<{
  title: string;
  kind: 'fixed' | 'flexible';
  start: string | null;
  end: string | null;
  durationMin: number;
  dueAt: string | null;
  priority: number;
  preferredWindow: string | null;
  planDate: string | null;
  location: string | null;
  notes: string | null;
  rrule: RRule | null;
  status: 'active' | 'done' | 'cancelled';
  focusDate: string | null;
  reminders: number[];
  dueReminders: number[];
  goalIds: string[];
}>;

function normalizeTimes(input: EventInput, current?: { start: string | null; durationMin: number }) {
  const out: { start_at?: string | null; end_at?: string | null; duration_min?: number } = {};
  if (input.start !== undefined) {
    if (input.start === null) {
      out.start_at = null;
      out.end_at = null;
    } else {
      out.start_at = toUtcIso(input.start);
      let dur = input.durationMin ?? current?.durationMin ?? 30;
      if (input.end) {
        dur = Math.round((Date.parse(toUtcIso(input.end)) - Date.parse(out.start_at)) / 60000);
      }
      if (dur <= 0) throw new Error('La fin doit être après le début');
      out.duration_min = dur;
      out.end_at = new Date(Date.parse(out.start_at) + dur * 60000).toISOString();
    }
  } else if (input.durationMin !== undefined || input.end !== undefined) {
    const start = current?.start;
    let dur = input.durationMin ?? current?.durationMin ?? 30;
    if (input.end && start) dur = Math.round((Date.parse(toUtcIso(input.end)) - Date.parse(start)) / 60000);
    if (dur <= 0) throw new Error('La durée doit être positive');
    out.duration_min = dur;
    if (start) out.end_at = new Date(Date.parse(start) + dur * 60000).toISOString();
  }
  return out;
}

function columnsFrom(input: EventInput): Record<string, any> {
  const c: Record<string, any> = {};
  if (input.title !== undefined) c.title = String(input.title).trim().slice(0, 200) || 'Sans titre';
  if (input.kind !== undefined) c.kind = input.kind === 'fixed' ? 'fixed' : 'flexible';
  if (input.dueAt !== undefined) c.due_at = input.dueAt ? toUtcIso(input.dueAt) : null;
  if (input.priority !== undefined) c.priority = Math.min(3, Math.max(1, Number(input.priority) || 2));
  if (input.preferredWindow !== undefined) c.preferred_window = input.preferredWindow || null;
  if (input.planDate !== undefined) c.plan_date = input.planDate || null;
  if (input.location !== undefined) c.location = input.location || null;
  if (input.notes !== undefined) c.notes = input.notes || null;
  if (input.status !== undefined) c.status = input.status;
  if (input.focusDate !== undefined) c.focus_date = input.focusDate || null;
  if (input.reminders !== undefined) c.reminders = JSON.stringify((input.reminders || []).map(Number).filter((n) => n >= 0));
  if (input.dueReminders !== undefined) c.due_reminders = JSON.stringify((input.dueReminders || []).map(Number).filter((n) => n >= 0));
  return c;
}

function setGoalLinks(eventId: string, goalIds: string[] | undefined, userId: string) {
  if (goalIds === undefined) return;
  run('DELETE FROM goal_links WHERE event_id = ?', eventId);
  for (const g of goalIds) {
    if (get('SELECT 1 FROM goals WHERE id = ? AND user_id = ?', g, userId)) {
      run('INSERT OR IGNORE INTO goal_links (event_id, goal_id) VALUES (?,?)', eventId, g);
    }
  }
}

export function createEvent(userId: string, input: EventInput, sample = false): Occurrence {
  const id = uid();
  const now = nowIso();
  const times = normalizeTimes({ durationMin: input.durationMin ?? 30, ...input, start: input.start ?? null });
  const cols: Record<string, any> = {
    title: 'Sans titre',
    kind: 'flexible',
    priority: 2,
    reminders: '[]',
    due_reminders: '[]',
    status: 'active',
    duration_min: input.durationMin ?? 30,
    ...columnsFrom(input),
    ...times,
    rrule: input.rrule && times.start_at ? JSON.stringify(input.rrule) : null,
  };
  if (cols.start_at) cols.plan_date = null;
  const keys = Object.keys(cols);
  tx(() => {
    run(
      `INSERT INTO events (id, user_id, ${keys.join(', ')}, sample, created_at, updated_at) VALUES (?, ?, ${keys.map(() => '?').join(', ')}, ?, ?, ?)`,
      id,
      userId,
      ...keys.map((k) => (cols as any)[k]),
      sample ? 1 : 0,
      now,
      now,
    );
    setGoalLinks(id, input.goalIds, userId);
  });
  return getOccurrence(userId, id)!;
}

function updateRow(id: string, cols: Record<string, any>) {
  const keys = Object.keys(cols);
  if (!keys.length) return;
  run(`UPDATE events SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => cols[k]), nowIso(), id);
}

/**
 * Modifie une occurrence. scope = 'this' (cette occurrence seulement) ou 'all' (toute la série).
 * Pour une occurrence de série avec scope 'this', une exception est créée.
 */
export function updateOccurrence(userId: string, id: string, input: EventInput, scope: 'this' | 'all' = 'this'): Occurrence {
  const occ = getOccurrence(userId, id);
  if (!occ) throw new Error('Élément introuvable');
  const { eventId, recurrenceId } = parseOccId(id);
  return tx(() => {
    if (!recurrenceId) {
      const cols: Record<string, any> = { ...columnsFrom(input), ...normalizeTimes(input, occ) };
      if (input.rrule !== undefined) cols.rrule = input.rrule && (cols.start_at ?? occ.start) ? JSON.stringify(input.rrule) : null;
      if (cols.start_at) cols.plan_date = null;
      updateRow(eventId, cols);
      setGoalLinks(eventId, input.goalIds, userId);
      return getOccurrence(userId, id)!;
    }
    const master = get('SELECT * FROM events WHERE id = ?', eventId)!;
    if (scope === 'all') {
      const cols: Record<string, any> = columnsFrom(input);
      if (input.start !== undefined && input.start) {
        // Décale la série du même écart que l'occurrence modifiée
        const delta = Date.parse(toUtcIso(input.start)) - Date.parse(occ.start!);
        const newStart = new Date(Date.parse(master.start_at) + delta).toISOString();
        Object.assign(cols, normalizeTimes({ ...input, start: newStart, end: undefined, durationMin: input.end ? Math.round((Date.parse(toUtcIso(input.end)) - Date.parse(toUtcIso(input.start))) / 60000) : input.durationMin }, { start: master.start_at, durationMin: master.duration_min }));
      } else {
        Object.assign(cols, normalizeTimes({ durationMin: input.durationMin, end: undefined }, { start: master.start_at, durationMin: master.duration_min }));
      }
      if (input.rrule !== undefined) cols.rrule = input.rrule ? JSON.stringify(input.rrule) : null;
      if (input.status !== undefined) delete cols.status; // le statut reste par occurrence
      updateRow(eventId, cols);
      setGoalLinks(eventId, input.goalIds, userId);
      return getOccurrence(userId, input.start ? occId(eventId, recurrenceId) : id) ?? occ;
    }
    // scope this → exception
    let ex = get('SELECT * FROM events WHERE series_id = ? AND recurrence_id = ?', eventId, recurrenceId);
    if (!ex) {
      const exId = uid();
      const now = nowIso();
      run(
        `INSERT INTO events (id, user_id, title, kind, start_at, end_at, duration_min, due_at, priority, preferred_window, plan_date, location, notes,
          rrule, series_id, recurrence_id, status, focus_date, reminders, due_reminders, sample, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?)`,
        exId,
        userId,
        master.title,
        master.kind,
        occ.start,
        occ.end,
        master.duration_min,
        master.due_at,
        master.priority,
        master.preferred_window,
        null,
        master.location,
        master.notes,
        eventId,
        recurrenceId,
        'active',
        null,
        master.reminders,
        master.due_reminders,
        master.sample,
        now,
        now,
      );
      ex = get('SELECT * FROM events WHERE id = ?', exId)!;
    }
    const cols: Record<string, any> = { ...columnsFrom(input), ...normalizeTimes(input, { start: ex.start_at, durationMin: ex.duration_min }) };
    if (cols.start_at === null) delete cols.start_at; // une occurrence ne peut pas être « déplanifiée »
    updateRow(ex.id, cols);
    return getOccurrence(userId, id)!;
  });
}

export function deleteOccurrence(userId: string, id: string, scope: 'this' | 'all' = 'this') {
  const { eventId, recurrenceId } = parseOccId(id);
  const row = get('SELECT * FROM events WHERE id = ? AND user_id = ?', eventId, userId);
  if (!row) throw new Error('Élément introuvable');
  if (!recurrenceId || scope === 'all') {
    if (row.series_id && scope !== 'all') {
      run("UPDATE events SET status = 'cancelled', updated_at = ? WHERE id = ?", nowIso(), eventId);
      return;
    }
    run('DELETE FROM events WHERE id = ?', row.series_id || eventId);
    return;
  }
  updateOccurrence(userId, id, { status: 'cancelled' }, 'this');
}
