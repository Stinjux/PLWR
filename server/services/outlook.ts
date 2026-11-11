import { DateTime } from 'luxon';
import { all, get, run, uid, nowIso, parseJson, tx } from '../db.ts';
import { config } from '../config.ts';
import { loadUser, signToken, verifyToken, type User } from '../auth.ts';
import type { RRule } from './events.ts';
import { plain, seal, unseal } from './google.ts';

/**
 * Synchronisation avec Outlook (Microsoft 365, Outlook.com, Hotmail) par Microsoft Graph — même principe que Google :
 * - chaque personne inscrit sa propre application dans Microsoft Entra et importe ses identifiants
 *   (ID d'application, valeur du secret client, annuaire), ou bien OUTLOOK_CLIENT_ID / OUTLOOK_CLIENT_SECRET du serveur ;
 * - elle accepte l'écran de consentement de Microsoft (Calendars.ReadWrite + accès hors connexion) ;
 * - Outlook → PLWR en lecture seule, PLWR → Outlook en option.
 * Les identifiants « immuables » de Graph (Prefer: IdType="ImmutableId") gardent le lien même si l'événement change de dossier.
 */

export const OUTLOOK_SCOPES = ['offline_access', 'openid', 'email', 'User.Read', 'Calendars.ReadWrite'];
export const outlookRedirectUri = () => `${config.appUrl}/api/outlook/callback`;
const GRAPH = 'https://graph.microsoft.com/v1.0';
const PREFER = 'outlook.timezone="UTC", IdType="ImmutableId"';

let http: typeof fetch = (input, init) => fetch(input, init);
export function setOutlookFetch(f: typeof fetch) {
  http = f;
}

export class OutlookError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------- Compte et identifiants ----------
const account = (userId: string) => get('SELECT * FROM outlook_accounts WHERE user_id = ?', userId);
const ensureRow = (userId: string) => run('INSERT OR IGNORE INTO outlook_accounts (user_id) VALUES (?)', userId);
const resetTokens = 'refresh_token_enc = NULL, access_token_enc = NULL, access_expires_at = NULL, email = NULL, connected_at = NULL';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function outlookCredentials(userId: string): { clientId: string; clientSecret: string; tenant: string; source: 'user' | 'server' } | null {
  const a = account(userId);
  const secret = unseal(a?.client_secret_enc);
  if (a?.client_id && secret) return { clientId: a.client_id, clientSecret: secret, tenant: a.tenant || 'common', source: 'user' };
  if (config.outlook.clientId && config.outlook.clientSecret) return { clientId: config.outlook.clientId, clientSecret: config.outlook.clientSecret, tenant: config.outlook.tenant, source: 'server' };
  return null;
}

export function saveOutlookCredentials(userId: string, clientIdRaw: string, clientSecretRaw: string, tenantRaw?: string) {
  const clientId = String(clientIdRaw || '').trim();
  const clientSecret = String(clientSecretRaw || '').trim();
  const tenant = String(tenantRaw || '').trim().toLowerCase() || 'common';
  if (!GUID.test(clientId)) throw new Error('ID d’application invalide : c’est un identifiant du type 1a2b3c4d-…-…');
  if (GUID.test(clientSecret)) throw new Error('Ceci ressemble à l’« ID du secret » : copie plutôt la colonne « Valeur » du secret client.');
  if (clientSecret.length < 10 || /\s/.test(clientSecret)) throw new Error('Valeur du secret client invalide');
  if (!(['common', 'organizations', 'consumers'].includes(tenant) || GUID.test(tenant) || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(tenant))) {
    throw new Error('Annuaire invalide : laisse « common », ou colle l’ID de l’annuaire (locataire).');
  }
  ensureRow(userId);
  run(`UPDATE outlook_accounts SET client_id = ?, client_secret_enc = ?, tenant = ?, ${resetTokens}, last_error = NULL WHERE user_id = ?`, clientId, seal(clientSecret), tenant, userId);
}

export function clearOutlookCredentials(userId: string) {
  run(`UPDATE outlook_accounts SET client_id = NULL, client_secret_enc = NULL, tenant = NULL, ${resetTokens} WHERE user_id = ?`, userId);
}

export function outlookStatus(userId: string) {
  const a = account(userId);
  const cred = outlookCredentials(userId);
  return {
    redirectUri: outlookRedirectUri(),
    scopes: OUTLOOK_SCOPES,
    hasCredentials: Boolean(cred),
    credentialsSource: cred?.source || null,
    clientId: cred?.source === 'user' ? cred.clientId : null,
    tenant: cred?.tenant || null,
    connected: Boolean(a?.refresh_token_enc),
    email: a?.email || null,
    export: a ? Boolean(a.export) : true,
    lastSyncAt: a?.last_sync_at || null,
    lastError: a?.last_error || null,
    lastResult: parseJson(a?.last_result, null),
    imported: get<{ n: number }>("SELECT COUNT(*) n FROM events WHERE user_id = ? AND source = 'outlook'", userId)!.n,
    exported: get<{ n: number }>('SELECT COUNT(*) n FROM outlook_exports WHERE user_id = ?', userId)!.n,
    syncMinutes: config.outlook.syncMinutes,
  };
}

export function setOutlookExport(userId: string, on: boolean) {
  ensureRow(userId);
  run('UPDATE outlook_accounts SET export = ? WHERE user_id = ?', on ? 1 : 0, userId);
}

// ---------- OAuth (plateforme d'identité Microsoft v2.0) ----------
const authority = (tenant: string) => `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`;

export function outlookAuthUrl(userId: string): string {
  const cred = outlookCredentials(userId);
  if (!cred) throw new Error('Importe d’abord tes identifiants Microsoft (étape 5 du guide)');
  const p = new URLSearchParams({
    client_id: cred.clientId,
    response_type: 'code',
    redirect_uri: outlookRedirectUri(),
    response_mode: 'query',
    scope: OUTLOOK_SCOPES.join(' '),
    prompt: 'select_account',
    state: signToken({ o: userId }, 15 * 60_000),
  });
  return `${authority(cred.tenant)}/authorize?${p}`;
}

function explain(data: any, status: number): string {
  const d = String(data?.error_description || '');
  if (/AADSTS7000222/.test(d)) return 'Ton secret client a expiré : crée-en un nouveau (étape 4) et importe sa valeur.';
  if (/AADSTS7000215/.test(d)) return 'Microsoft refuse le secret client : copie la colonne « Valeur » (pas « ID du secret »).';
  if (/AADSTS700016/.test(d)) return 'Application introuvable : vérifie l’ID d’application et l’annuaire, ou le type de comptes pris en charge (étape 2).';
  if (/AADSTS50011/.test(d)) return 'L’URI de redirection ne correspond pas : copie celle du guide dans ton application (étape 2).';
  if (/AADSTS65001|consent/i.test(d)) return 'Le consentement n’a pas été donné : reconnecte Outlook et accepte l’accès à ton calendrier.';
  if (data?.error === 'invalid_grant') return 'L’accès à Outlook a expiré ou a été retiré : reconnecte Outlook.';
  if (data?.error === 'invalid_client') return 'Microsoft refuse les identifiants : vérifie l’ID d’application et le secret client.';
  if (status === 403) return 'Accès refusé par Microsoft : la permission Calendars.ReadWrite manque (étape 3 du guide).';
  return data?.error?.message || d.split(/\r?\n/)[0] || data?.error || `Erreur Microsoft (${status})`;
}

async function tokenRequest(tenant: string, params: Record<string, string>) {
  const r = await http(`${authority(tenant)}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new OutlookError(explain(data, r.status), r.status, data?.error);
  return data;
}

function emailFromIdToken(idToken?: string): string | null {
  try {
    const p = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString());
    return p.email || p.preferred_username || null;
  } catch {
    return null;
  }
}

function storeTokens(userId: string, t: any) {
  run(
    `UPDATE outlook_accounts SET access_token_enc = ?, access_expires_at = ?${t.refresh_token ? ', refresh_token_enc = ?' : ''} WHERE user_id = ?`,
    seal(t.access_token),
    new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000).toISOString(),
    ...(t.refresh_token ? [seal(t.refresh_token)] : []),
    userId,
  );
}

export async function handleOutlookCallback(userId: string, code: string, state: string) {
  const s = verifyToken<{ o: string }>(state);
  if (!s || s.o !== userId) throw new Error('Connexion refusée : recommence depuis PLWR, dans le même navigateur.');
  const cred = outlookCredentials(userId);
  if (!cred) throw new Error('Identifiants Microsoft introuvables : importe-les de nouveau.');
  const t = await tokenRequest(cred.tenant, {
    client_id: cred.clientId,
    client_secret: cred.clientSecret,
    code,
    redirect_uri: outlookRedirectUri(),
    grant_type: 'authorization_code',
    scope: OUTLOOK_SCOPES.join(' '),
  });
  if (!/Calendars\.ReadWrite/i.test(String(t.scope || ''))) throw new Error('L’accès au calendrier n’a pas été accordé : ajoute la permission Calendars.ReadWrite (étape 3), puis reconnecte.');
  if (!t.refresh_token) throw new Error('Microsoft n’a pas donné d’accès durable (offline_access) : ajoute cette permission (étape 3), puis reconnecte.');
  ensureRow(userId);
  const email = emailFromIdToken(t.id_token);
  storeTokens(userId, t);
  run('UPDATE outlook_accounts SET email = ?, connected_at = ?, last_error = NULL WHERE user_id = ?', email, nowIso(), userId);
  return { email };
}

async function accessToken(userId: string, force = false): Promise<string> {
  const a = account(userId);
  const refresh = unseal(a?.refresh_token_enc);
  if (!refresh) throw new OutlookError('Outlook n’est pas connecté', 401, 'not_connected');
  const current = unseal(a!.access_token_enc);
  if (!force && current && a!.access_expires_at > new Date(Date.now() + 60_000).toISOString()) return current;
  const cred = outlookCredentials(userId);
  if (!cred) throw new OutlookError('Identifiants Microsoft introuvables', 401, 'no_credentials');
  try {
    // Microsoft renvoie un nouveau jeton de renouvellement à chaque fois : on le garde
    const t = await tokenRequest(cred.tenant, { client_id: cred.clientId, client_secret: cred.clientSecret, refresh_token: refresh, grant_type: 'refresh_token', scope: OUTLOOK_SCOPES.join(' ') });
    storeTokens(userId, t);
    return t.access_token;
  } catch (e) {
    if (e instanceof OutlookError && (e.code === 'invalid_grant' || /expiré/.test(e.message))) {
      run(`UPDATE outlook_accounts SET ${resetTokens}, last_error = ? WHERE user_id = ?`, e.message, userId);
    }
    throw e;
  }
}

async function graph(userId: string, method: string, pathOrUrl: string, body?: any, retried = false): Promise<any> {
  const token = await accessToken(userId, retried);
  const r = await http(pathOrUrl.startsWith('https://') ? pathOrUrl : `${GRAPH}${pathOrUrl}`, {
    method,
    headers: { authorization: `Bearer ${token}`, prefer: PREFER, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && !retried) return graph(userId, method, pathOrUrl, body, true);
  if (r.status === 204 || r.status === 202) return null;
  const data: any = await r.json().catch(() => null);
  if (!r.ok) throw new OutlookError(explain(data, r.status), r.status, data?.error?.code);
  return data;
}

// ---------- Conversion ----------

/** Fuseaux IANA → noms Windows attendus par Outlook pour les récurrences. */
const WINDOWS_ZONES: Record<string, string> = {
  'America/Toronto': 'Eastern Standard Time',
  'America/Montreal': 'Eastern Standard Time',
  'America/New_York': 'Eastern Standard Time',
  'America/Halifax': 'Atlantic Standard Time',
  'America/Moncton': 'Atlantic Standard Time',
  'America/St_Johns': 'Newfoundland Standard Time',
  'America/Winnipeg': 'Central Standard Time',
  'America/Chicago': 'Central Standard Time',
  'America/Regina': 'Canada Central Standard Time',
  'America/Edmonton': 'Mountain Standard Time',
  'America/Denver': 'Mountain Standard Time',
  'America/Vancouver': 'Pacific Standard Time',
  'America/Los_Angeles': 'Pacific Standard Time',
  'Europe/Paris': 'Romance Standard Time',
  'Europe/Brussels': 'Romance Standard Time',
  'Europe/London': 'GMT Standard Time',
  UTC: 'UTC',
};
export const windowsZone = (tz: string) => WINDOWS_ZONES[tz] || 'UTC';

const NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const INDEX: Record<string, string> = { '1': 'first', '2': 'second', '3': 'third', '4': 'fourth', '-1': 'last' };

/** Règle PLWR → récurrence Outlook (patternedRecurrence). */
export function toOutlookRecurrence(rule: RRule, startIso: string, tz: string) {
  const wtz = windowsZone(tz);
  const start = DateTime.fromISO(startIso).setZone(wtz === 'UTC' ? 'utc' : tz);
  const interval = Math.max(1, rule.interval || 1);
  let pattern: any;
  if (rule.freq === 'daily') pattern = { type: 'daily', interval };
  else if (rule.freq === 'weekly') pattern = { type: 'weekly', interval, daysOfWeek: (rule.byDay?.length ? [...rule.byDay] : [start.weekday]).sort().map((d) => NAMES[d - 1]), firstDayOfWeek: 'monday' };
  else if (rule.freq === 'monthly' && rule.bySetPos && rule.byDay?.length) pattern = { type: 'relativeMonthly', interval, daysOfWeek: [NAMES[rule.byDay[0] - 1]], index: INDEX[String(rule.bySetPos)] || 'first' };
  else if (rule.freq === 'monthly') pattern = { type: 'absoluteMonthly', interval, dayOfMonth: start.day };
  else pattern = { type: 'absoluteYearly', interval, dayOfMonth: start.day, month: start.month };
  const range: any = { startDate: start.toISODate(), recurrenceTimeZone: wtz };
  if (rule.until) Object.assign(range, { type: 'endDate', endDate: rule.until });
  else if (rule.count) Object.assign(range, { type: 'numbered', numberOfOccurrences: rule.count });
  else range.type = 'noEnd';
  return { pattern, range };
}

/** Événement PLWR → ressource Outlook (heures locales + fuseau Windows, pour que les récurrences suivent l'heure d'été). */
export function toOutlookEvent(row: any, tz: string) {
  const wtz = windowsZone(tz);
  const local = (iso: string) => DateTime.fromISO(iso).setZone(wtz === 'UTC' ? 'utc' : tz).toFormat("yyyy-LL-dd'T'HH:mm:ss");
  const rule = parseJson<RRule | null>(row.rrule, null);
  return {
    subject: row.title,
    body: { contentType: 'text', content: row.notes || '' },
    location: { displayName: row.location || '' },
    start: { dateTime: local(row.start_at), timeZone: wtz },
    end: { dateTime: local(row.end_at), timeZone: wtz },
    sensitivity: row.visibility === 'busy' ? 'private' : 'normal',
    recurrence: rule ? toOutlookRecurrence(rule, row.start_at, tz) : null,
  };
}

/** Heure UTC renvoyée par Graph (« 2026-11-12T19:00:00.0000000 ») → ISO. */
const graphUtc = (s: string) => new Date(`${s.replace(/\.\d+$/, '')}Z`).toISOString();

// ---------- Synchronisation ----------

/** Occurrences supprimées dans PLWR → supprimées chez Outlook. */
async function deleteCancelledInstances(userId: string, outlookId: string, seriesId: string) {
  const cancelled = all<{ recurrence_id: string }>("SELECT recurrence_id FROM events WHERE series_id = ? AND status = 'cancelled'", seriesId).map((r) => Date.parse(r.recurrence_id));
  if (!cancelled.length) return;
  const from = new Date(Math.min(...cancelled) - 86400_000).toISOString();
  const to = new Date(Math.max(...cancelled) + 86400_000).toISOString();
  const r = await graph(userId, 'GET', `/me/events/${encodeURIComponent(outlookId)}/instances?${new URLSearchParams({ startDateTime: from, endDateTime: to, $select: 'id,start' })}`);
  for (const inst of r?.value || []) {
    if (cancelled.includes(Date.parse(graphUtc(inst.start.dateTime)))) {
      await graph(userId, 'DELETE', `/me/events/${encodeURIComponent(inst.id)}`).catch((e) => {
        if (!(e instanceof OutlookError && (e.status === 404 || e.status === 410))) throw e;
      });
    }
  }
}

export async function exportToOutlook(user: User) {
  const links = new Map(all('SELECT * FROM outlook_exports WHERE user_id = ?', user.id).map((l) => [l.event_id as string, l]));
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
    const body = toOutlookEvent(row, user.timezone);
    let oid: string | undefined = link?.outlook_id;
    if (oid) {
      try {
        await graph(user.id, 'PATCH', `/me/events/${encodeURIComponent(oid)}`, body);
      } catch (e) {
        if (e instanceof OutlookError && (e.status === 404 || e.status === 410)) oid = undefined; // effacé chez Outlook : on le recrée
        else throw e;
      }
    }
    if (!oid) oid = (await graph(user.id, 'POST', '/me/events', body)).id as string;
    if (row.rrule) await deleteCancelledInstances(user.id, oid, row.id);
    run(
      `INSERT INTO outlook_exports (event_id, user_id, outlook_id, pushed_at) VALUES (?,?,?,?)
       ON CONFLICT(event_id) DO UPDATE SET outlook_id = excluded.outlook_id, pushed_at = excluded.pushed_at`,
      row.id,
      user.id,
      oid,
      nowIso(),
    );
    pushed++;
  }
  for (const [eventId, l] of links) {
    if (keep.has(eventId)) continue;
    const ev = get('SELECT status, start_at FROM events WHERE id = ?', eventId);
    if (ev && ev.status !== 'cancelled' && ev.start_at) continue; // vieil événement : il reste chez Outlook
    try {
      await graph(user.id, 'DELETE', `/me/events/${encodeURIComponent(l.outlook_id)}`);
    } catch (e) {
      if (!(e instanceof OutlookError && (e.status === 404 || e.status === 410))) throw e;
    }
    run('DELETE FROM outlook_exports WHERE event_id = ?', eventId);
    deleted++;
  }
  return { pushed, deleted };
}

export async function importFromOutlook(user: User) {
  const from = DateTime.now().minus({ days: 30 }).toUTC().toISO()!;
  const to = DateTime.now().plus({ days: 365 }).toUTC().toISO()!;
  const items: any[] = [];
  let next: string | undefined = `/me/calendarView?${new URLSearchParams({
    startDateTime: from,
    endDateTime: to,
    $top: '500',
    $select: 'id,subject,start,end,isAllDay,isCancelled,location,bodyPreview,sensitivity,seriesMasterId,type',
  })}`;
  while (next && items.length < 20000) {
    const r: any = await graph(user.id, 'GET', next);
    items.push(...(r?.value || []));
    next = r?.['@odata.nextLink'];
  }
  const ours = new Set(all<{ outlook_id: string }>('SELECT outlook_id FROM outlook_exports WHERE user_id = ?', user.id).map((r) => r.outlook_id));
  const seen = new Set<string>();
  let added = 0, updated = 0, removed = 0;
  tx(() => {
    for (const ev of items) {
      if (ev.isCancelled || ev.isAllDay) continue;
      if (ours.has(ev.id) || (ev.seriesMasterId && ours.has(ev.seriesMasterId))) continue; // envoyé par PLWR
      if (!ev.start?.dateTime || !ev.end?.dateTime) continue;
      const start = graphUtc(ev.start.dateTime);
      const end = graphUtc(ev.end.dateTime);
      if (end <= start) continue;
      seen.add(ev.id);
      const cols = {
        title: String(ev.subject || '').trim().slice(0, 200) || '(Sans titre)',
        start_at: start,
        end_at: end,
        duration_min: Math.round((Date.parse(end) - Date.parse(start)) / 60000),
        location: ev.location?.displayName ? String(ev.location.displayName).slice(0, 300) : null,
        notes: plain(ev.bodyPreview),
        visibility: ev.sensitivity === 'private' || ev.sensitivity === 'confidential' ? 'busy' : 'details',
      };
      const ex = get("SELECT * FROM events WHERE user_id = ? AND source = 'outlook' AND outlook_id = ?", user.id, ev.id);
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
          `INSERT INTO events (id, user_id, title, kind, start_at, end_at, duration_min, location, notes, visibility, status, reminders, due_reminders, source, outlook_id, created_at, updated_at)
           VALUES (?,?,?,'fixed',?,?,?,?,?,?,'active','[]','[]','outlook',?,?,?)`,
          uid(), user.id, cols.title, cols.start_at, cols.end_at, cols.duration_min, cols.location, cols.notes, cols.visibility, ev.id, now, now,
        );
        added++;
      }
    }
    for (const r of all("SELECT id, outlook_id FROM events WHERE user_id = ? AND source = 'outlook' AND start_at < ? AND end_at > ?", user.id, to, from)) {
      if (!seen.has(r.outlook_id)) {
        run('DELETE FROM events WHERE id = ?', r.id);
        removed++;
      }
    }
  });
  return { added, updated, removed };
}

const inflight = new Map<string, Promise<any>>();
export function syncOutlook(userId: string): Promise<{ pushed: number; deleted: number; added: number; updated: number; removed: number } | null> {
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
    const out = a.export ? await exportToOutlook(user) : { pushed: 0, deleted: 0 };
    const inn = await importFromOutlook(user);
    const result = { ...out, ...inn };
    run('UPDATE outlook_accounts SET last_sync_at = ?, last_error = NULL, last_result = ? WHERE user_id = ?', nowIso(), JSON.stringify(result), userId);
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Erreur Microsoft';
    run('UPDATE outlook_accounts SET last_error = ?, last_sync_at = ? WHERE user_id = ?', msg, nowIso(), userId);
    console.error(`[outlook] synchro ${userId} : ${msg}`);
    throw e;
  }
}

/** Déconnexion : oublie les jetons (Microsoft n'offre pas de révocation simple côté application) et retire les événements importés. */
export function disconnectOutlook(userId: string) {
  tx(() => {
    run(`UPDATE outlook_accounts SET ${resetTokens}, last_error = NULL, last_result = NULL, last_sync_at = NULL WHERE user_id = ?`, userId);
    run("DELETE FROM events WHERE user_id = ? AND source = 'outlook'", userId);
    run('DELETE FROM outlook_exports WHERE user_id = ?', userId);
  });
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
export function queueOutlookSync(userId: string) {
  if (!get('SELECT 1 FROM outlook_accounts WHERE user_id = ? AND refresh_token_enc IS NOT NULL AND export = 1', userId)) return;
  clearTimeout(timers.get(userId));
  const t = setTimeout(() => {
    timers.delete(userId);
    syncOutlook(userId).catch(() => {});
  }, 3000);
  t.unref?.();
  timers.set(userId, t);
}

export function startOutlookSync() {
  const tick = async () => {
    for (const r of all<{ user_id: string }>('SELECT user_id FROM outlook_accounts WHERE refresh_token_enc IS NOT NULL')) {
      await syncOutlook(r.user_id).catch(() => {});
    }
  };
  setInterval(() => void tick(), config.outlook.syncMinutes * 60_000).unref();
  setTimeout(() => void tick(), 20_000).unref();
}
