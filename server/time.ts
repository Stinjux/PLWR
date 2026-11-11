import { DateTime } from 'luxon';

export const LOCALE = 'fr-CA';

export function zNow(tz: string, now?: Date): DateTime {
  return DateTime.fromJSDate(now ?? new Date(), { zone: tz }).setLocale(LOCALE);
}

export function today(tz: string, now?: Date): string {
  return zNow(tz, now).toISODate()!;
}

export function toUtcIso(input: string | Date | DateTime): string {
  if (input instanceof Date) return input.toISOString();
  if (DateTime.isDateTime(input)) return input.toUTC().toISO()!;
  const d = DateTime.fromISO(input, { setZone: true });
  if (!d.isValid) throw new Error(`Date invalide : ${input}`);
  return d.toUTC().toISO()!;
}

export function localDateOf(iso: string, tz: string): string {
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(tz).toISODate()!;
}

/** Début et fin (UTC ISO) d'une journée locale. */
export function dayBounds(date: string, tz: string): { start: string; end: string } {
  const s = DateTime.fromISO(date, { zone: tz }).startOf('day');
  return { start: s.toUTC().toISO()!, end: s.plus({ days: 1 }).toUTC().toISO()! };
}

/** Combine une date locale et une heure « HH:MM » en DateTime local. */
export function atTime(date: string, hhmm: string, tz: string): DateTime {
  const [h, m] = hhmm.split(':').map(Number);
  return DateTime.fromISO(date, { zone: tz }).set({ hour: h, minute: m || 0, second: 0, millisecond: 0 });
}

export function weekStart(date: string, tz: string): string {
  return DateTime.fromISO(date, { zone: tz }).startOf('week').toISODate()!; // lundi
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function formatMoney(cents: number, currency = 'CAD'): string {
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency }).format(cents / 100);
}

export function formatTime(iso: string, tz: string): string {
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(tz).setLocale(LOCALE).toFormat("HH'h'mm");
}

export function formatDayTime(iso: string, tz: string): string {
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(tz).setLocale(LOCALE).toFormat("ccc d LLL, HH'h'mm");
}
