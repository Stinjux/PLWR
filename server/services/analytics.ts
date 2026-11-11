import { DateTime } from 'luxon';
import { all, db, get, run, uid, nowIso, parseJson } from '../db.ts';
import type { User } from '../auth.ts';

/**
 * Mesure de l'adoption, stockée seulement dans la base de l'app (aucun service tiers).
 * - first_action : la première action réelle de l'accueil (événement, étape d'objectif, dépense) ;
 * - useful_action : chaque action utile ensuite (événement, objectif, progrès, dépense, paiement récurrent) ;
 * - activity_days : un jour d'utilisation par personne → retours à J+1 et J+7.
 * Les tableaux ne montrent que des totaux par parcours, jamais le détail d'une personne.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  props TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analytics_user ON analytics_events(user_id, name, created_at);
CREATE TABLE IF NOT EXISTS activity_days (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  PRIMARY KEY (user_id, day)
);
`);

export const PATHS = ['week', 'goal', 'expense', 'explore'] as const;
export type Path = (typeof PATHS)[number];

/** Événements que l'interface peut envoyer elle-même. */
export const CLIENT_EVENTS = ['onboarding_started', 'explore_clicked', 'next_action_clicked', 'reminder_permission', 'welcome_dismissed'];

export function track(userId: string, name: string, props: Record<string, unknown> = {}) {
  run('INSERT INTO analytics_events (id, user_id, name, props, created_at) VALUES (?,?,?,?,?)', uid(), userId, name, JSON.stringify(props).slice(0, 1000), nowIso());
}

export function trackOnce(userId: string, name: string, props: Record<string, unknown> = {}) {
  if (!get('SELECT 1 FROM analytics_events WHERE user_id = ? AND name = ?', userId, name)) track(userId, name, props);
}

export const useful = (userId: string, kind: string) => track(userId, 'useful_action', { kind });

/** Un jour d'utilisation (à chaque ouverture de l'app). */
export function touch(user: User) {
  run('INSERT OR IGNORE INTO activity_days (user_id, day) VALUES (?,?)', user.id, DateTime.now().setZone(user.timezone).toISODate());
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};

/** Tableau d'adoption par parcours d'accueil. */
export function adoptionMetrics() {
  const users = all('SELECT id, created_at, timezone, settings FROM users');
  const today = (tz: string) => DateTime.now().setZone(tz).startOf('day');
  type Row = { path: string; started: number; firstAction: number; secondsToFirst: number[]; d1Eligible: number; d1: number; d7Eligible: number; d7: number; second: number; nextAction: number };
  const rows = new Map<string, Row>();
  const row = (p: string) => rows.get(p) || (rows.set(p, { path: p, started: 0, firstAction: 0, secondsToFirst: [], d1Eligible: 0, d1: 0, d7Eligible: 0, d7: 0, second: 0, nextAction: 0 }), rows.get(p)!);

  for (const u of users) {
    const ob = parseJson<any>(u.settings, {}).onboarding || {};
    const started = get<{ created_at: string }>("SELECT created_at FROM analytics_events WHERE user_id = ? AND name = 'onboarding_started' ORDER BY created_at LIMIT 1", u.id);
    if (!started && !ob.path) continue; // compte créé avant la mesure
    const r = row(ob.path || 'sans choix');
    r.started++;
    const first = get<{ created_at: string }>("SELECT created_at FROM analytics_events WHERE user_id = ? AND name = 'first_action' ORDER BY created_at LIMIT 1", u.id);
    if (first) {
      r.firstAction++;
      if (started) r.secondsToFirst.push(Math.max(0, Math.round((Date.parse(first.created_at) - Date.parse(started.created_at)) / 1000)));
    }
    // Deuxième action utile : après la première action (ou après l'accueil pour « Explorer »)
    const after = first?.created_at || ob.completedAt;
    if (after && get("SELECT 1 FROM analytics_events WHERE user_id = ? AND name = 'useful_action' AND created_at > ?", u.id, after)) r.second++;
    if (get("SELECT 1 FROM analytics_events WHERE user_id = ? AND name = 'next_action_clicked'", u.id)) r.nextAction++;
    // Retours : jour d'inscription + 1 et + 7 (fuseau de la personne)
    const tz = u.timezone || 'America/Toronto';
    const signup = DateTime.fromISO(u.created_at).setZone(tz).startOf('day');
    const ageDays = Math.round(today(tz).diff(signup, 'days').days);
    const activeOn = (n: number) => Boolean(get('SELECT 1 FROM activity_days WHERE user_id = ? AND day = ?', u.id, signup.plus({ days: n }).toISODate()));
    if (ageDays >= 1) {
      r.d1Eligible++;
      if (activeOn(1)) r.d1++;
    }
    if (ageDays >= 7) {
      r.d7Eligible++;
      if (activeOn(7)) r.d7++;
    }
  }
  const out = [...rows.values()].map((r) => ({
    path: r.path,
    started: r.started,
    firstActionRate: pct(r.firstAction, r.started),
    medianSecondsToFirstAction: median(r.secondsToFirst),
    d1Rate: pct(r.d1, r.d1Eligible),
    d1Eligible: r.d1Eligible,
    d7Rate: pct(r.d7, r.d7Eligible),
    d7Eligible: r.d7Eligible,
    secondActionRate: pct(r.second, r.started),
    nextActionRate: pct(r.nextAction, r.started),
  }));
  return { paths: out.sort((a, b) => b.started - a.started), totalStarted: out.reduce((s, r) => s + r.started, 0) };
}
