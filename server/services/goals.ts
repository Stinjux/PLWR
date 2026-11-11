import { DateTime } from 'luxon';
import { all, get, run, uid, nowIso } from '../db.ts';
import { today } from '../time.ts';

export type Goal = {
  id: string;
  title: string;
  metric: 'check' | 'quantity' | 'duration' | 'amount';
  target: number;
  unit: string;
  period: 'once' | 'daily' | 'weekly' | 'monthly';
  startDate: string;
  deadline: string | null;
  reminderDays: number | null;
  archived: boolean;
  sample: boolean;
};

export function rowToGoal(r: any): Goal {
  return {
    id: r.id,
    title: r.title,
    metric: r.metric,
    target: r.target,
    unit: r.unit,
    period: r.period,
    startDate: r.start_date,
    deadline: r.deadline,
    reminderDays: r.reminder_days,
    archived: Boolean(r.archived),
    sample: Boolean(r.sample),
  };
}

/** Bornes (dates locales incluses/exclues) de la période courante d'un objectif. */
export function periodBounds(goal: Goal, date: string, tz: string): { from: string; to: string; label: string } {
  const d = DateTime.fromISO(date, { zone: tz }).setLocale('fr-CA');
  switch (goal.period) {
    case 'daily':
      return { from: date, to: d.plus({ days: 1 }).toISODate()!, label: "Aujourd'hui" };
    case 'weekly': {
      const s = d.startOf('week');
      return { from: s.toISODate()!, to: s.plus({ weeks: 1 }).toISODate()!, label: `Semaine du ${s.toFormat('d LLL')}` };
    }
    case 'monthly': {
      const s = d.startOf('month');
      return { from: s.toISODate()!, to: s.plus({ months: 1 }).toISODate()!, label: s.toFormat('LLLL yyyy') };
    }
    default:
      return {
        from: goal.startDate,
        to: goal.deadline ? DateTime.fromISO(goal.deadline).plus({ days: 1 }).toISODate()! : '9999-12-31',
        label: goal.deadline ? `Jusqu'au ${DateTime.fromISO(goal.deadline).setLocale('fr-CA').toFormat('d LLLL yyyy')}` : 'Total',
      };
  }
}

export function goalProgress(goal: Goal, tz: string, date?: string) {
  const ref = date || today(tz);
  const b = periodBounds(goal, ref, tz);
  const done = (get<{ v: number }>('SELECT COALESCE(SUM(value),0) v FROM goal_entries WHERE goal_id = ? AND date >= ? AND date < ?', goal.id, b.from, b.to)?.v) || 0;
  const remaining = Math.max(0, goal.target - done);
  return {
    period: b,
    done,
    target: goal.target,
    remaining,
    percent: goal.target > 0 ? Math.min(100, Math.round((done / goal.target) * 100)) : 0,
    completed: done >= goal.target,
    checkedToday: goal.metric === 'check' ? Boolean(get('SELECT 1 FROM goal_entries WHERE goal_id = ? AND date = ? AND event_id IS NULL', goal.id, ref)) : undefined,
  };
}

/** Historique groupé par semaine ou par mois. */
export function goalHistory(goal: Goal, tz: string, groupBy: 'week' | 'month', periods = 8) {
  const now = DateTime.now().setZone(tz).setLocale('fr-CA');
  const buckets: { key: string; label: string; from: string; to: string; value: number; planned: number }[] = [];
  for (let i = periods - 1; i >= 0; i--) {
    const s = groupBy === 'week' ? now.startOf('week').minus({ weeks: i }) : now.startOf('month').minus({ months: i });
    const e = groupBy === 'week' ? s.plus({ weeks: 1 }) : s.plus({ months: 1 });
    const r = get<{ v: number; p: number }>(
      'SELECT COALESCE(SUM(value),0) v, COALESCE(SUM(planned),0) p FROM goal_entries WHERE goal_id = ? AND date >= ? AND date < ?',
      goal.id,
      s.toISODate(),
      e.toISODate(),
    )!;
    buckets.push({
      key: s.toISODate()!,
      label: groupBy === 'week' ? s.toFormat('d LLL') : s.toFormat('LLL yyyy'),
      from: s.toISODate()!,
      to: e.toISODate()!,
      value: r.v,
      planned: r.p,
    });
  }
  // cible proportionnelle à la période d'affichage
  let target: number | null = null;
  if (goal.period === 'weekly') target = groupBy === 'week' ? goal.target : goal.target * 4.33;
  else if (goal.period === 'monthly') target = groupBy === 'month' ? goal.target : goal.target / 4.33;
  else if (goal.period === 'daily') target = goal.target * (groupBy === 'week' ? 7 : 30);
  return { groupBy, target, buckets };
}

export function listEntries(goalId: string, limit = 50) {
  return all(
    `SELECT ge.*, e.title AS event_title FROM goal_entries ge
     LEFT JOIN events e ON e.id = ge.event_id
     WHERE ge.goal_id = ? ORDER BY ge.date DESC, ge.created_at DESC LIMIT ?`,
    goalId,
    limit,
  ).map((r) => ({ id: r.id, date: r.date, value: r.value, planned: r.planned, note: r.note, eventId: r.event_id, occurrence: r.occurrence, eventTitle: r.event_title }));
}

/** Enregistre (ou remplace) le résultat d'un bloc pour un objectif. Idempotent par (objectif, bloc, occurrence). */
export function upsertBlockEntry(userId: string, goalId: string, eventId: string, occurrence: string, date: string, value: number, planned: number | null, note?: string) {
  const existing = get('SELECT id FROM goal_entries WHERE goal_id = ? AND event_id = ? AND occurrence = ?', goalId, eventId, occurrence);
  if (existing) {
    run('UPDATE goal_entries SET value = ?, planned = ?, date = ?, note = ? WHERE id = ?', value, planned, date, note ?? null, existing.id);
    return existing.id;
  }
  const id = uid();
  run(
    'INSERT INTO goal_entries (id, user_id, goal_id, date, value, planned, event_id, occurrence, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    id,
    userId,
    goalId,
    date,
    value,
    planned,
    eventId,
    occurrence,
    note ?? null,
    nowIso(),
  );
  return id;
}

export function formatGoalValue(goal: Pick<Goal, 'metric' | 'unit'>, v: number): string {
  if (goal.metric === 'duration') {
    const h = Math.floor(v / 60), m = Math.round(v % 60);
    return h ? `${h} h${m ? ` ${String(m).padStart(2, '0')}` : ''}` : `${m} min`;
  }
  if (goal.metric === 'amount') return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(v);
  return `${Number.isInteger(v) ? v : v.toFixed(1)}${goal.unit ? ` ${goal.unit}` : ''}`;
}
