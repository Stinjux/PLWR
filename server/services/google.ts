import crypto from 'node:crypto';
import { DateTime } from 'luxon';
import { all, get, run, uid, nowIso, parseJson, tx } from '../db.ts';
import { config } from '../config.ts';
import { loadUser, signToken, verifyToken, type User } from '../auth.ts';
import type { RRule } from './events.ts';

/**
 * Synchronisation avec Google Agenda (agenda principal de chaque personne).
 *
 * - Chaque personne importe ses propres identifiants OAuth (ID client + code secret, ou le fichier JSON
 *   téléchargé depuis Google Cloud), puis autorise PLWR sur l'écran de consentement de Google.
 *   Si GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET sont définis sur le serveur, ils servent par défaut.
 * - Google → PLWR : les événements (30 jours passés à 365 jours à venir) arrivent dans l'agenda de la personne,
 *   en lecture seule, et sont donc visibles par les personnes avec qui elle partage son agenda.
 * - PLWR → Google : les éléments planifiés créés dans PLWR sont envoyés (option), récurrences comprises.
 * Le secret du client et les jetons sont chiffrés (AES-256-GCM, clé dérivée d'APP_SECRET).
 */

export const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'];
export const redirectUri = () => `${config.appUrl}/api/google/callback`;
const API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

let http: typeof fetch = (input, init) => fetch(input, init);
/** Pour les tests : remplace l'accès réseau. */
export function setGoogleFetch(f: typeof fetch) {
  http = f;
}

export class GoogleError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------- Chiffrement ----------
const key = () => crypto.createHash('sha256').update(`google:${config.appSecret}`).digest();
export function seal(text: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}
export function unseal(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  try {
    const [iv, tag, enc] = sealed.split('.').map((x) => Buffer.from(x, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch {
    return null; // APP_SECRET a changé : il faudra reconnecter
  }
}

// ---------- Compte et identifiants ----------
const account = (userId: string) => get('SELECT * FROM google_accounts WHERE user_id = ?', userId);
const ensureRow = (userId: string) => run('INSERT OR IGNORE INTO google_accounts (user_id) VALUES (?)', userId);

export function credentialsFor(userId: string): { clientId: string; clientSecret: string; source: 'user' | 'server' } | null {
  const a = account(userId);
  const secret = unseal(a?.client_secret_enc);
  if (a?.client_id && secret) return { clientId: a.client_id, clientSecret: secret, source: 'user' };
  if (config.google.clientId && config.google.clientSecret) return { clientId: config.google.clientId, clientSecret: config.google.clientSecret, source: 'server' };
  return null;
}

const resetTokens = 'refresh_token_enc = NULL, access_token_enc = NULL, access_expires_at = NULL, email = NULL, connected_at = NULL';

export function saveCredentials(userId: string, clientIdRaw: string, clientSecretRaw: string) {
  const clientId = String(clientIdRaw || '').trim();
  const clientSecret = String(clientSecretRaw || '').trim();
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error('ID client invalide : il se termine par « .apps.googleusercontent.com »');
  if (clientSecret.length < 10 || /\s/.test(clientSecret)) throw new Error('Code secret du client invalide');
  ensureRow(userId);
  // De nouveaux identifiants rendent la connexion précédente inutilisable
  run(`UPDATE google_accounts SET client_id = ?, client_secret_enc = ?, ${resetTokens}, last_error = NULL WHERE user_id = ?`, clientId, seal(clientSecret), userId);
}

export function clearCredentials(userId: string) {
  run(`UPDATE google_accounts SET client_id = NULL, client_secret_enc = NULL, ${resetTokens} WHERE user_id = ?`, userId);
}

export function googleStatus(userId: string) {
  const a = account(userId);
  const cred = credentialsFor(userId);
  return {
    redirectUri: redirectUri(),
    scopes: GOOGLE_SCOPES,
    hasCredentials: Boolean(cred),
    credentialsSource: cred?.source || null,
    clientId: cred?.source === 'user' ? cred.clientId : null,
    connected: Boolean(a?.refresh_token_enc),
    email: a?.email || null,
    export: a ? Boolean(a.export) : true,
    lastSyncAt: a?.last_sync_at || null,
    lastError: a?.last_error || null,
    lastResult: parseJson(a?.last_result, null),
    imported: get<{ n: number }>("SELECT COUNT(*) n FROM events WHERE user_id = ? AND source = 'google'", userId)!.n,
    exported: get<{ n: number }>('SELECT COUNT(*) n FROM google_exports WHERE user_id = ?', userId)!.n,
    syncMinutes: config.google.syncMinutes,
  };
}

export function setExport(userId: string, on: boolean) {
  ensureRow(userId);
  run('UPDATE google_accounts SET export = ? WHERE user_id = ?', on ? 1 : 0, userId);
}

// ---------- OAuth ----------
export function authUrl(userId: string): string {
  const cred = credentialsFor(userId);
  if (!cred) throw new Error('Importe d’abord tes identifiants Google (étape 5 du guide)');
  const p = new URLSearchParams({
    client_id: cred.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent', // garantit un jeton de longue durée (refresh_token)
    include_granted_scopes: 'true',
    state: signToken({ g: userId }, 15 * 60_000),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

function explain(data: any, status: number): string {
  const code = data?.error;
  if (code === 'invalid_client') return 'Google refuse les identifiants : vérifie l’ID client et le code secret importés.';
  if (code === 'invalid_grant') return 'L’accès à Google a expiré ou a été retiré : reconnecte Google Agenda.';
  if (code === 'redirect_uri_mismatch') return 'L’URI de redirection ne correspond pas : copie celle du guide dans ton client OAuth.';
  if (code === 'unauthorized_client') return 'Ce client OAuth n’est pas de type « Application Web ».';
  if (status === 403 && /accessNotConfigured|has not been used|disabled/i.test(JSON.stringify(data))) return 'L’API Google Calendar n’est pas activée dans ton projet Google Cloud (étape 2 du guide).';
  return data?.error_description || data?.error?.message || (typeof code === 'string' ? code : '') || `Erreur Google (${status})`;
}

async function tokenRequest(params: Record<string, string>) {
  const r = await http('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new GoogleError(explain(data, r.status), r.status, data?.error);
  return data;
}

function emailFromIdToken(idToken?: string): string | null {
  try {
    return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString()).email || null;
  } catch {
    return null;
  }
}

/** Retour de l'écran de consentement : échange le code contre des jetons. */
export async function handleCallback(userId: string, code: string, state: string) {
  const s = verifyToken<{ g: string }>(state);
  if (!s || s.g !== userId) throw new Error('Connexion refusée : recommence depuis PLWR, dans le même navigateur.');
  const cred = credentialsFor(userId);
  if (!cred) throw new Error('Identifiants Google introuvables : importe-les de nouveau.');
  const t = await tokenRequest({ code, client_id: cred.clientId, client_secret: cred.clientSecret, redirect_uri: redirectUri(), grant_type: 'authorization_code' });
  if (!String(t.scope || '').includes('calendar.events')) {
    throw new Error('L’accès à l’agenda n’a pas été coché sur l’écran de Google. Reconnecte et coche la case de l’agenda.');
  }
  if (!t.refresh_token) {
    throw new Error('Google n’a pas donné d’accès durable : retire PLWR de ton compte Google (Sécurité → Applications tierces), puis reconnecte.');
  }
  ensureRow(userId);
  run(
    `UPDATE google_accounts SET refresh_token_enc = ?, access_token_enc = ?, access_expires_at = ?, email = ?, connected_at = ?, last_error = NULL WHERE user_id = ?`,
    seal(t.refresh_token),
    seal(t.access_token),
    new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000).toISOString(),
    emailFromIdToken(t.id_token),
    nowIso(),
    userId,
  );
  return { email: emailFromIdToken(t.id_token) };
}

async function accessToken(userId: string, force = false): Promise<string> {
  const a = account(userId);
  const refresh = unseal(a?.refresh_token_enc);
  if (!refresh) throw new GoogleError('Google Agenda n’est pas connecté', 401, 'not_connected');
  const current = unseal(a!.access_token_enc);
  if (!force && current && a!.access_expires_at > new Date(Date.now() + 60_000).toISOString()) return current;
  const cred = credentialsFor(userId);
  if (!cred) throw new GoogleError('Identifiants Google introuvables', 401, 'no_credentials');
  try {
    const t = await tokenRequest({ refresh_token: refresh, client_id: cred.clientId, client_secret: cred.clientSecret, grant_type: 'refresh_token' });
    run(
      'UPDATE google_accounts SET access_token_enc = ?, access_expires_at = ? WHERE user_id = ?',
      seal(t.access_token),
      new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000).toISOString(),
      userId,
    );
    return t.access_token;
  } catch (e) {
    if (e instanceof GoogleError && e.code === 'invalid_grant') {
      // Accès retiré (ou jeton expiré : application Google laissée « en test ») → il faut reconnecter
      run(`UPDATE google_accounts SET ${resetTokens}, last_error = ? WHERE user_id = ?`, e.message, userId);
    }
    throw e;
  }
}

async function api(userId: string, method: string, path: string, body?: any, retried = false): Promise<any> {
  const token = await accessToken(userId, retried);
  const r = await http(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && !retried) return api(userId, method, path, body, true);
  if (r.status === 204) return null;
  const data: any = await r.json().catch(() => null);
  if (!r.ok) throw new GoogleError(explain(data, r.status), r.status, data?.error?.status);
  return data;
}

// ---------- Conversion ----------
const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

/** Règle PLWR → RRULE (RFC 5545) comprise par Google. */
export function toGoogleRule(rule: RRule, tz: string): string {
  const parts = [`FREQ=${rule.freq.toUpperCase()}`];
  if (rule.interval && rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.freq === 'weekly' && rule.byDay?.length) parts.push(`BYDAY=${[...rule.byDay].sort().map((d) => DAYS[d - 1]).join(',')}`);
  if (rule.freq === 'monthly' && rule.bySetPos && rule.byDay?.length) parts.push(`BYDAY=${rule.bySetPos}${DAYS[rule.byDay[0] - 1]}`);
  if (rule.until) parts.push(`UNTIL=${DateTime.fromISO(rule.until, { zone: tz }).endOf('day').toUTC().toFormat("yyyyLLdd'T'HHmmss'Z'")}`);
  else if (rule.count) parts.push(`COUNT=${rule.count}`);
  return `RRULE:${parts.join(';')}`;
}

/** Événement PLWR → ressource Google Agenda. */
export function toGoogleEvent(row: any, tz: string) {
  const body: any = {
    summary: row.title,
    location: row.location || undefined,
    description: row.notes || undefined,
    start: { dateTime: row.start_at, timeZone: tz },
    end: { dateTime: row.end_at, timeZone: tz },
    visibility: row.visibility === 'busy' ? 'private' : 'default',
    extendedProperties: { private: { plwrId: row.id } },
  };
  const rule = parseJson<RRule | null>(row.rrule, null);
  if (rule) {
    body.recurrence = [toGoogleRule(rule, tz)];
    // Occurrences supprimées dans PLWR → dates exclues chez Google
    const cancelled = all<{ recurrence_id: string }>("SELECT recurrence_id FROM events WHERE series_id = ? AND status = 'cancelled'", row.id).map((r) => r.recurrence_id);
    if (cancelled.length) body.recurrence.push(`EXDATE;TZID=${tz}:${cancelled.map((c) => DateTime.fromISO(c).setZone(tz).toFormat("yyyyLLdd'T'HHmmss")).join(',')}`);
  }
  return body;
}

/** Texte brut à partir de la description Google (qui peut contenir du HTML). */
export function plain(html?: string): string | null {
  if (!html) return null;
  const t = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
  return t ? t.slice(0, 2000) : null;
}

// ---------- Synchronisation ----------

/** PLWR → Google : envoie les éléments planifiés créés ou modifiés depuis le dernier envoi, efface ceux supprimés. */
export async function exportEvents(user: User) {
  const links = new Map(all('SELECT * FROM google_exports WHERE user_id = ?', user.id).map((l) => [l.event_id as string, l]));
  const rows = all(
    `SELECT e.*, (SELECT MAX(x.updated_at) FROM events x WHERE x.series_id = e.id) AS ex_updated
     FROM events e WHERE e.user_id = ? AND e.source = 'plwr' AND e.series_id IS NULL AND e.start_at IS NOT NULL
     AND e.status != 'cancelled' AND e.sample = 0 AND (e.rrule IS NOT NULL OR e.end_at > ?)`,
    user.id,
    DateTime.now().minus({ days: 30 }).toUTC().toISO()!,
  );
  let pushed = 0, deleted = 0;
  const keep = new Set<string>();
  for (const row of rows) {
    keep.add(row.id);
    const link = links.get(row.id);
    const stamp = [row.updated_at, row.ex_updated].filter(Boolean).sort().pop();
    if (link && link.pushed_at >= stamp) continue;
    const body = toGoogleEvent(row, user.timezone);
    let gid: string | undefined = link?.google_id;
    if (gid) {
      try {
        await api(user.id, 'PUT', `/${encodeURIComponent(gid)}`, body);
      } catch (e) {
        if (e instanceof GoogleError && (e.status === 404 || e.status === 410)) gid = undefined; // effacé chez Google : on le recrée
        else throw e;
      }
    }
    if (!gid) gid = (await api(user.id, 'POST', '', body)).id as string;
    run(
      `INSERT INTO google_exports (event_id, user_id, google_id, pushed_at) VALUES (?,?,?,?)
       ON CONFLICT(event_id) DO UPDATE SET google_id = excluded.google_id, pushed_at = excluded.pushed_at`,
      row.id,
      user.id,
      gid,
      nowIso(),
    );
    pushed++;
  }
  for (const [eventId, l] of links) {
    if (keep.has(eventId)) continue;
    // Seulement ce qui a disparu de PLWR (supprimé, annulé, déplanifié) ; un vieil événement reste chez Google
    const ev = get('SELECT status, start_at FROM events WHERE id = ?', eventId);
    if (ev && ev.status !== 'cancelled' && ev.start_at) continue;
    try {
      await api(user.id, 'DELETE', `/${encodeURIComponent(l.google_id)}`);
    } catch (e) {
      if (!(e instanceof GoogleError && (e.status === 404 || e.status === 410))) throw e;
    }
    run('DELETE FROM google_exports WHERE event_id = ?', eventId);
    deleted++;
  }
  return { pushed, deleted };
}

/** Google → PLWR : importe les événements avec une heure (les journées entières sont ignorées). */
export async function importEvents(user: User) {
  const from = DateTime.now().minus({ days: 30 }).toUTC().toISO()!;
  const to = DateTime.now().plus({ days: 365 }).toUTC().toISO()!;
  const items: any[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({ singleEvents: 'true', timeMin: from, timeMax: to, maxResults: '2500', showDeleted: 'false' });
    if (pageToken) q.set('pageToken', pageToken);
    const r = await api(user.id, 'GET', `?${q}`);
    items.push(...(r?.items || []));
    pageToken = r?.nextPageToken;
  } while (pageToken && items.length < 20000);

  const ours = new Set(all<{ google_id: string }>('SELECT google_id FROM google_exports WHERE user_id = ?', user.id).map((r) => r.google_id));
  const seen = new Set<string>();
  let added = 0, updated = 0, removed = 0;
  tx(() => {
    for (const ev of items) {
      if (ev.status === 'cancelled') continue;
      // Ce que PLWR a lui-même envoyé ne revient pas en double
      if (ev.extendedProperties?.private?.plwrId || ours.has(ev.id) || (ev.recurringEventId && ours.has(ev.recurringEventId))) continue;
      if (!ev.start?.dateTime || !ev.end?.dateTime) continue;
      const start = new Date(ev.start.dateTime).toISOString();
      const end = new Date(ev.end.dateTime).toISOString();
      if (end <= start) continue;
      seen.add(ev.id);
      const cols = {
        title: String(ev.summary || '').trim().slice(0, 200) || '(Sans titre)',
        start_at: start,
        end_at: end,
        duration_min: Math.round((Date.parse(end) - Date.parse(start)) / 60000),
        location: ev.location ? String(ev.location).slice(0, 300) : null,
        notes: plain(ev.description),
        visibility: ev.visibility === 'private' || ev.visibility === 'confidential' ? 'busy' : 'details',
      };
      const ex = get("SELECT * FROM events WHERE user_id = ? AND source = 'google' AND google_id = ?", user.id, ev.id);
      if (ex) {
        if ((Object.keys(cols) as (keyof typeof cols)[]).some((k) => ex[k] !== cols[k])) {
          run(
            'UPDATE events SET title = ?, start_at = ?, end_at = ?, duration_min = ?, location = ?, notes = ?, visibility = ?, updated_at = ? WHERE id = ?',
            cols.title, cols.start_at, cols.end_at, cols.duration_min, cols.location, cols.notes, cols.visibility, nowIso(), ex.id,
          );
          updated++;
        }
      } else {
        const now = nowIso();
        run(
          `INSERT INTO events (id, user_id, title, kind, start_at, end_at, duration_min, location, notes, visibility, status, reminders, due_reminders, source, google_id, created_at, updated_at)
           VALUES (?,?,?,'fixed',?,?,?,?,?,?,'active','[]','[]','google',?,?,?)`,
          uid(), user.id, cols.title, cols.start_at, cols.end_at, cols.duration_min, cols.location, cols.notes, cols.visibility, ev.id, now, now,
        );
        added++;
      }
    }
    // Supprimés (ou déplacés hors de la période) chez Google
    for (const r of all("SELECT id, google_id FROM events WHERE user_id = ? AND source = 'google' AND start_at < ? AND end_at > ?", user.id, to, from)) {
      if (!seen.has(r.google_id)) {
        run('DELETE FROM events WHERE id = ?', r.id);
        removed++;
      }
    }
  });
  return { added, updated, removed };
}

const inflight = new Map<string, Promise<any>>();

/**
 * Synchronise une personne : envoi vers Google (si activé) puis import.
 * Les synchros d'une même personne passent l'une après l'autre (jamais deux en même temps).
 */
export function syncUser(userId: string): Promise<{ pushed: number; deleted: number; added: number; updated: number; removed: number } | null> {
  const prev = inflight.get(userId) || Promise.resolve();
  const p = prev.catch(() => {}).then(() => runSync(userId));
  inflight.set(userId, p);
  p.finally(() => inflight.get(userId) === p && inflight.delete(userId)).catch(() => {});
  return p;
}

async function runSync(userId: string) {
  const a = account(userId);
  if (!a?.refresh_token_enc) return null;
  const user = loadUser(userId);
  if (!user) return null;
  try {
    const out = a.export ? await exportEvents(user) : { pushed: 0, deleted: 0 };
    const inn = await importEvents(user);
    const result = { ...out, ...inn };
    run('UPDATE google_accounts SET last_sync_at = ?, last_error = NULL, last_result = ? WHERE user_id = ?', nowIso(), JSON.stringify(result), userId);
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Erreur Google';
    run('UPDATE google_accounts SET last_error = ?, last_sync_at = ? WHERE user_id = ?', msg, nowIso(), userId);
    console.error(`[google] synchro ${userId} : ${msg}`);
    throw e;
  }
}

/** Déconnexion : révoque l'accès chez Google et retire les événements importés (ceux envoyés restent dans Google). */
export async function disconnect(userId: string) {
  const refresh = unseal(account(userId)?.refresh_token_enc);
  if (refresh) {
    try {
      await http(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, { method: 'POST' });
    } catch {}
  }
  tx(() => {
    run(`UPDATE google_accounts SET ${resetTokens}, last_error = NULL, last_result = NULL, last_sync_at = NULL WHERE user_id = ?`, userId);
    run("DELETE FROM events WHERE user_id = ? AND source = 'google'", userId);
    run('DELETE FROM google_exports WHERE user_id = ?', userId);
  });
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Après une modification dans PLWR : synchro rapide (regroupée) si Google est connecté. */
export function queueSync(userId: string) {
  if (!get('SELECT 1 FROM google_accounts WHERE user_id = ? AND refresh_token_enc IS NOT NULL AND export = 1', userId)) return;
  clearTimeout(timers.get(userId));
  const t = setTimeout(() => {
    timers.delete(userId);
    syncUser(userId).catch(() => {});
  }, 3000);
  t.unref?.();
  timers.set(userId, t);
}

/** Synchro périodique de toutes les personnes connectées. */
export function startGoogleSync() {
  const tick = async () => {
    for (const r of all<{ user_id: string }>('SELECT user_id FROM google_accounts WHERE refresh_token_enc IS NOT NULL')) {
      await syncUser(r.user_id).catch(() => {});
    }
  };
  setInterval(() => void tick(), config.google.syncMinutes * 60_000).unref();
  setTimeout(() => void tick(), 15_000).unref();
}
