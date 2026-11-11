import crypto from 'node:crypto';
import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { get, run, nowIso, parseJson } from './db.ts';
import { config } from './config.ts';

export const SESSION_COOKIE = 'plwr_sid';
const SESSION_DAYS = 30;

export type UserSettings = {
  dayStart: string;
  dayEnd: string;
  bufferMinutes: number;
  breaks: { label: string; start: string; end: string }[];
  quietHours: { enabled: boolean; start: string; end: string };
  defaultReminderMinutes: number;
  snoozeMinutes: number;
  keepImages: boolean;
};

export const DEFAULT_SETTINGS: UserSettings = {
  dayStart: '07:00',
  dayEnd: '22:00',
  bufferMinutes: 10,
  breaks: [
    { label: 'Dîner', start: '12:00', end: '12:45' },
    { label: 'Souper', start: '18:00', end: '18:45' },
  ],
  quietHours: { enabled: true, start: '22:00', end: '07:00' },
  defaultReminderMinutes: 10,
  snoozeMinutes: 10,
  keepImages: false,
};

export type User = { id: string; email: string; name: string; timezone: string; settings: UserSettings };

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algo, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function createSession(c: Context, userId: string) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  run(
    'INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?,?,?,?,?)',
    sha256(token),
    userId,
    nowIso(),
    expires.toISOString(),
    (c.req.header('user-agent') || '').slice(0, 200),
  );
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'Lax',
    path: '/',
    expires,
  });
}

export function destroySession(c: Context) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) run('DELETE FROM sessions WHERE id = ?', sha256(token));
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export function rowToUser(row: any): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    timezone: row.timezone,
    settings: { ...DEFAULT_SETTINGS, ...parseJson(row.settings, {}) },
  };
}

export function loadUser(id: string): User | undefined {
  const row = get('SELECT * FROM users WHERE id = ?', id);
  return row ? rowToUser(row) : undefined;
}

export function userFromRequest(c: Context): User | undefined {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return undefined;
  const s = get('SELECT * FROM sessions WHERE id = ?', sha256(token));
  if (!s || s.expires_at < nowIso()) return undefined;
  return loadUser(s.user_id);
}

/** Session glissante : utilisée régulièrement, elle ne expire jamais (prolongée de 30 jours quand il en reste moins de 15). */
function renewSession(c: Context) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return;
  const s = get('SELECT * FROM sessions WHERE id = ?', sha256(token));
  if (!s || s.expires_at > new Date(Date.now() + 15 * 86400_000).toISOString()) return;
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  run('UPDATE sessions SET expires_at = ? WHERE id = ?', expires.toISOString(), s.id);
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: config.cookieSecure, sameSite: 'Lax', path: '/', expires });
}

/** Middleware : exige une session valide et un en-tête anti-CSRF sur les requêtes qui modifient des données. */
export async function requireUser(c: Context, next: Next) {
  const user = userFromRequest(c);
  if (!user) throw new HTTPException(401, { message: 'Connexion requise' });
  renewSession(c);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.req.header('x-plwr') !== '1') {
    throw new HTTPException(403, { message: 'Requête refusée (CSRF)' });
  }
  c.set('user', user);
  await next();
}

/** Limiteur simple en mémoire pour la connexion. */
const attempts = new Map<string, { n: number; until: number }>();
export function rateLimit(key: string, max = 10, windowMs = 15 * 60_000): boolean {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.until < now) {
    attempts.set(key, { n: 1, until: now + windowMs });
    return true;
  }
  a.n += 1;
  return a.n <= max;
}

/** Jeton signé (HMAC) utilisé par l'action « Reporter » d'une notification, sans cookie. */
export function signToken(payload: object, ttlMs = 7 * 86400_000): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString('base64url');
  const sig = crypto.createHmac('sha256', config.appSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken<T = any>(token: string): T | undefined {
  const [body, sig] = (token || '').split('.');
  if (!body || !sig) return undefined;
  const expected = crypto.createHmac('sha256', config.appSecret).update(body).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return undefined;
  const data = parseJson<any>(Buffer.from(body, 'base64url').toString(), null);
  if (!data || data.exp < Date.now()) return undefined;
  return data as T;
}

declare module 'hono' {
  interface ContextVariableMap {
    user: User;
  }
}
