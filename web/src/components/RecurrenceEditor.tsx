import { DateTime } from 'luxon';
import { TZ } from '../lib/format';

/** Récurrence façon Outlook : modèle (quotidien, hebdo, mensuel, annuel) + plage (fin jamais / date / N occurrences). */
export type Rec = {
  repeat: 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly';
  interval: number;
  byDay: number[];
  monthMode: 'day' | 'pos';
  end: 'never' | 'until' | 'count';
  until: string;
  count: number;
};

export type Rule = { freq: 'daily' | 'weekly' | 'monthly' | 'yearly'; interval?: number; byDay?: number[]; bySetPos?: number | null; until?: string | null; count?: number | null };

const DAYS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
const DAY_NAMES = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const POS = ['', '1er', '2e', '3e', '4e'];

const local = (startLocal: string) => DateTime.fromISO(startLocal, { zone: TZ });

/** Position du jour dans le mois (1 à 4, ou -1 si c'est le dernier de ce jour de semaine). */
function posOf(d: DateTime): number {
  if (d.day + 7 > d.daysInMonth!) return -1;
  return Math.ceil(d.day / 7);
}

export function recFromRule(rule: Rule | null, startLocal: string): Rec {
  const d = local(startLocal);
  const base: Rec = { repeat: 'none', interval: 1, byDay: [d.weekday], monthMode: 'day', end: 'never', until: '', count: 10 };
  if (!rule) return base;
  const weekdays = rule.freq === 'weekly' && (rule.interval || 1) === 1 && rule.byDay?.length === 5 && [1, 2, 3, 4, 5].every((x) => rule.byDay!.includes(x));
  return {
    ...base,
    repeat: weekdays ? 'weekdays' : rule.freq,
    interval: rule.interval || 1,
    byDay: rule.byDay?.length ? rule.byDay : base.byDay,
    monthMode: rule.freq === 'monthly' && rule.bySetPos ? 'pos' : 'day',
    end: rule.count ? 'count' : rule.until ? 'until' : 'never',
    until: rule.until || '',
    count: rule.count || 10,
  };
}

export function ruleFromRec(r: Rec, startLocal: string): Rule | null {
  if (r.repeat === 'none') return null;
  const d = local(startLocal);
  const end = { until: r.end === 'until' && r.until ? r.until : null, count: r.end === 'count' ? Math.max(1, r.count) : null };
  const interval = Math.max(1, r.interval || 1);
  switch (r.repeat) {
    case 'weekdays':
      return { freq: 'weekly', byDay: [1, 2, 3, 4, 5], ...end };
    case 'weekly':
      return { freq: 'weekly', interval, byDay: r.byDay.length ? [...r.byDay].sort() : [d.weekday], ...end };
    case 'monthly':
      return r.monthMode === 'pos' ? { freq: 'monthly', interval, byDay: [d.weekday], bySetPos: posOf(d), ...end } : { freq: 'monthly', interval, ...end };
    default:
      return { freq: r.repeat, interval, ...end };
  }
}

export function recSummary(r: Rec, startLocal: string): string {
  if (r.repeat === 'none') return 'Ne se répète pas';
  const d = local(startLocal);
  const n = Math.max(1, r.interval || 1);
  let s = '';
  if (r.repeat === 'daily') s = n === 1 ? 'Tous les jours' : `Tous les ${n} jours`;
  if (r.repeat === 'weekdays') s = 'Tous les jours ouvrables (lun.–ven.)';
  if (r.repeat === 'weekly') s = `${n === 1 ? 'Chaque semaine' : `Toutes les ${n} semaines`} le ${[...r.byDay].sort().map((x) => DAY_NAMES[x - 1]).join(', ')}`;
  if (r.repeat === 'monthly') {
    const when = r.monthMode === 'pos' ? `le ${posOf(d) === -1 ? 'dernier' : POS[posOf(d)]} ${DAY_NAMES[d.weekday - 1]}` : `le ${d.day}`;
    s = `${n === 1 ? 'Chaque mois' : `Tous les ${n} mois`} ${when}`;
  }
  if (r.repeat === 'yearly') s = `${n === 1 ? 'Chaque année' : `Tous les ${n} ans`} le ${d.toFormat('d LLLL')}`;
  s += ` à ${d.toFormat("HH'h'mm")}`;
  if (r.end === 'until' && r.until) s += `, jusqu’au ${DateTime.fromISO(r.until).toFormat('d LLLL yyyy')}`;
  if (r.end === 'count') s += `, ${r.count} fois`;
  return s;
}

export function RecurrenceEditor({ value, onChange, startLocal }: { value: Rec; onChange: (r: Rec) => void; startLocal: string }) {
  const set = (p: Partial<Rec>) => onChange({ ...value, ...p });
  const d = local(startLocal);
  const unit = { daily: 'jour(s)', weekly: 'semaine(s)', monthly: 'mois', yearly: 'an(s)' } as Record<string, string>;
  const pos = posOf(d);
  return (
    <div className="stack" style={{ gap: 8 }} data-testid="recurrence">
      <div className="field-label">Répétition</div>
      <div className="row wrap" role="radiogroup" aria-label="Répétition" style={{ gap: 6 }}>
        {(
          [
            ['none', 'Une seule fois'],
            ['daily', 'Chaque jour'],
            ['weekdays', 'Lun. au ven.'],
            ['weekly', 'Chaque semaine'],
            ['monthly', 'Chaque mois'],
            ['yearly', 'Chaque année'],
          ] as [Rec['repeat'], string][]
        ).map(([v, l]) => (
          <button key={v} type="button" role="radio" aria-checked={value.repeat === v} className={`pill${value.repeat === v ? ' on' : ''}`} onClick={() => set({ repeat: v })}>
            {l}
          </button>
        ))}
      </div>
      {value.repeat !== 'none' && (
        <div className="rec-box">
          {value.repeat !== 'weekdays' && (
            <label className="row small" style={{ marginBottom: 8 }}>
              Tous les
              <input className="input" type="number" min={1} max={99} style={{ width: 72 }} value={value.interval} onChange={(e) => set({ interval: Number(e.target.value) || 1 })} aria-label="Intervalle" />
              {unit[value.repeat]}
            </label>
          )}
          {value.repeat === 'weekly' && (
            <div className="row" role="group" aria-label="Jours de la semaine" style={{ marginBottom: 8 }}>
              {DAYS.map((x, i) => {
                const on = value.byDay.includes(i + 1);
                return (
                  <button
                    key={i}
                    type="button"
                    className={`day-chip${on ? ' on' : ''}`}
                    aria-pressed={on}
                    aria-label={DAY_NAMES[i]}
                    onClick={() => set({ byDay: on ? value.byDay.filter((y) => y !== i + 1) : [...value.byDay, i + 1] })}
                  >
                    {x}
                  </button>
                );
              })}
            </div>
          )}
          {value.repeat === 'monthly' && (
            <div className="seg full" style={{ marginBottom: 8 }}>
              <button type="button" className={value.monthMode === 'day' ? 'on' : ''} onClick={() => set({ monthMode: 'day' })}>
                Le {d.day}
              </button>
              <button type="button" className={value.monthMode === 'pos' ? 'on' : ''} onClick={() => set({ monthMode: 'pos' })}>
                Le {pos === -1 ? 'dernier' : POS[pos]} {DAY_NAMES[d.weekday - 1]}
              </button>
            </div>
          )}
          <div className="small muted" style={{ fontWeight: 600, marginBottom: 4 }}>
            Fin
          </div>
          <div className="seg full" role="group" aria-label="Fin de la récurrence">
            <button type="button" className={value.end === 'never' ? 'on' : ''} onClick={() => set({ end: 'never' })}>
              Jamais
            </button>
            <button type="button" className={value.end === 'until' ? 'on' : ''} onClick={() => set({ end: 'until', until: value.until || d.plus({ months: 3 }).toISODate()! })}>
              Le…
            </button>
            <button type="button" className={value.end === 'count' ? 'on' : ''} onClick={() => set({ end: 'count' })}>
              Après…
            </button>
          </div>
          {value.end === 'until' && <input className="input" style={{ marginTop: 6 }} type="date" min={d.toISODate()!} value={value.until} onChange={(e) => set({ until: e.target.value })} aria-label="Date de fin" />}
          {value.end === 'count' && (
            <label className="row small" style={{ marginTop: 6 }}>
              <input className="input" type="number" min={1} max={999} style={{ width: 80 }} value={value.count} onChange={(e) => set({ count: Number(e.target.value) || 1 })} aria-label="Nombre d’occurrences" />
              occurrences
            </label>
          )}
          <div className="small" style={{ marginTop: 10, color: 'var(--link)', fontWeight: 600 }} data-testid="recurrence-summary">
            {recSummary(value, startLocal)}
          </div>
        </div>
      )}
    </div>
  );
}
