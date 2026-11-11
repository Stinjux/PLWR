import { DateTime, Settings } from 'luxon';

export const TZ = 'America/Toronto';
Settings.defaultZone = TZ;
Settings.defaultLocale = 'fr-CA';

export const money = (cents: number | null | undefined, currency = 'CAD') =>
  cents === null || cents === undefined ? '—' : new Intl.NumberFormat('fr-CA', { style: 'currency', currency }).format(cents / 100);

export const dt = (iso: string) => DateTime.fromISO(iso).setZone(TZ);
export const time = (iso: string | null | undefined) => (iso ? dt(iso).toFormat("HH'h'mm") : '');
export const dayLabel = (date: string) => {
  const d = DateTime.fromISO(date, { zone: TZ });
  const t = DateTime.now().setZone(TZ).startOf('day');
  const diff = Math.round(d.startOf('day').diff(t, 'days').days);
  if (diff === 0) return "Aujourd'hui";
  if (diff === -1) return 'Hier';
  if (diff === 1) return 'Demain';
  return d.toFormat('ccc d LLL');
};
export const longDate = (date: string) => {
  const s = DateTime.fromISO(date, { zone: TZ }).toFormat('cccc d LLLL');
  return s.charAt(0).toUpperCase() + s.slice(1);
};
export const todayIso = () => DateTime.now().setZone(TZ).toISODate()!;
export const monthLabel = (month: string) => {
  const s = DateTime.fromISO(month + '-01', { zone: TZ }).toFormat('LLLL yyyy');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Saisie « 72,30 » ou « 72.30 » → cents. */
export const parseMoney = (s: string): number | null => {
  const clean = String(s).replace(/[\s$ ]/g, '').replace(',', '.');
  if (!clean) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
export const centsToInput = (c: number | null | undefined) => (c === null || c === undefined ? '' : (c / 100).toFixed(2).replace('.', ','));

export const duration = (min: number) => {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? `${h} h${m ? ` ${String(m).padStart(2, '0')}` : ''}` : `${m} min`;
};

export const goalValue = (g: { metric: string; unit: string }, v: number) => {
  if (g.metric === 'duration') return duration(v);
  if (g.metric === 'amount') return money(Math.round(v * 100));
  if (g.metric === 'check') return v >= 1 ? 'fait' : 'à faire';
  return `${Number.isInteger(v) ? v : v.toFixed(1)}${g.unit ? ` ${g.unit}` : ''}`;
};

/** Valeur « datetime-local » (heure de Toronto) ↔ ISO. */
export const toLocalInput = (iso: string | null | undefined) => (iso ? dt(iso).toFormat("yyyy-LL-dd'T'HH:mm") : '');
export const fromLocalInput = (v: string) => (v ? DateTime.fromISO(v, { zone: TZ }).toUTC().toISO()! : null);

export const PRIORITY_LABEL: Record<number, string> = { 1: 'Haute', 2: 'Moyenne', 3: 'Basse' };
export const WINDOW_LABEL: Record<string, string> = { matin: 'Matin', 'apres-midi': 'Après-midi', soir: 'Soir' };
