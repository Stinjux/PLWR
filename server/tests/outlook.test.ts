// Outlook (Microsoft Graph) : identifiants importés, consentement, import/export, secret expiré — Microsoft simulé.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plwr-outlook-'));
process.env.APP_SECRET = 'secret-de-test';
process.env.APP_URL = 'https://plwr.exemple.ca';
delete process.env.OUTLOOK_CLIENT_ID;
delete process.env.OUTLOOK_CLIENT_SECRET;
const { app } = await import('../app.ts');
const { setOutlookFetch, toOutlookRecurrence, toOutlookEvent } = await import('../services/outlook.ts');
const { run } = await import('../db.ts');

const APP_ID = '1a2b3c4d-1111-2222-3333-444455556666';
const calls: { method: string; url: string; body: any; headers: any }[] = [];
let outlookEvents: any[] = [];
let instances: any[] = [];
let tokenError: any = null;
let n = 0;
const json = (status: number, data: any) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
setOutlookFetch((async (input: any, init: any = {}) => {
  const url = String(input);
  const method = init.method || 'GET';
  const body = typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body;
  calls.push({ method, url, body, headers: init.headers });
  if (url.startsWith('https://login.microsoftonline.com/common/oauth2/v2.0/token')) {
    if (tokenError) return json(400, tokenError);
    const idToken = `x.${Buffer.from(JSON.stringify({ preferred_username: 'camille@outlook.com' })).toString('base64url')}.y`;
    return json(200, { access_token: `acc-${++n}`, refresh_token: `ref-${n}`, expires_in: 3600, scope: 'Calendars.ReadWrite User.Read openid email profile', id_token: idToken });
  }
  if (url.startsWith('https://graph.microsoft.com/v1.0/')) {
    assert.match(init.headers.authorization, /^Bearer acc-/);
    assert.match(init.headers.prefer, /ImmutableId/);
    if (url.includes('/me/calendarView')) return json(200, { value: outlookEvents });
    if (url.includes('/instances')) return json(200, { value: instances });
    if (method === 'POST') return json(201, { id: `o-${++n}` });
    if (method === 'PATCH') return json(200, { id: url.split('/').pop() });
    if (method === 'DELETE') return new Response(null, { status: 204 });
  }
  return json(404, { error: { code: 'NotFound', message: 'inconnu' } });
}) as any);

async function req(method: string, url: string, body?: any, cookie = '') {
  const res = await app.request(url, { method, headers: { 'x-plwr': '1', 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return { res, status: res.status, data };
}

const day = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
const at = (hhmm: string) => new Date(`${day}T${hhmm}:00-05:00`).toISOString();
const graphTime = (iso: string) => iso.replace('Z', '').replace(/\.\d+$/, '') + '.0000000';

test('récurrences Outlook : hebdomadaire, 2e mardi, fin de série, heure d’été', () => {
  const start = '2026-11-10T14:00:00.000Z'; // mardi 9 h à Toronto
  assert.deepEqual(toOutlookRecurrence({ freq: 'weekly', byDay: [3, 1] }, start, 'America/Toronto'), {
    pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday', 'wednesday'], firstDayOfWeek: 'monday' },
    range: { startDate: '2026-11-10', recurrenceTimeZone: 'Eastern Standard Time', type: 'noEnd' },
  });
  assert.deepEqual(toOutlookRecurrence({ freq: 'monthly', byDay: [2], bySetPos: 2, count: 6 }, start, 'America/Toronto').pattern, { type: 'relativeMonthly', interval: 1, daysOfWeek: ['tuesday'], index: 'second' });
  assert.deepEqual(toOutlookRecurrence({ freq: 'daily', interval: 2, until: '2026-12-31' }, start, 'America/Toronto').range, { startDate: '2026-11-10', recurrenceTimeZone: 'Eastern Standard Time', type: 'endDate', endDate: '2026-12-31' });
  const ev = toOutlookEvent({ title: 'Course', start_at: start, end_at: '2026-11-10T14:30:00.000Z', visibility: 'busy', notes: null, location: null, rrule: null }, 'America/Toronto');
  assert.deepEqual(ev.start, { dateTime: '2026-11-10T09:00:00', timeZone: 'Eastern Standard Time' });
  assert.equal(ev.sensitivity, 'private');
});

test('Outlook : identifiants importés, consentement Microsoft, import et envoi', async () => {
  const reg = await req('POST', '/api/auth/register', { email: 'camille@exemple.ca', password: 'motdepasse-solide', name: 'Camille', samples: false });
  const cookie = (reg.res.headers.get('set-cookie') || '').split(';')[0];
  const call = (m: string, u: string, b?: any) => req(m, u, b, cookie);

  let st = (await call('GET', '/api/outlook/status')).data;
  assert.equal(st.hasCredentials, false);
  assert.equal(st.redirectUri, 'https://plwr.exemple.ca/api/outlook/callback');

  // Erreurs courantes à l'import : ID du secret au lieu de la valeur, mauvais ID
  const wrongSecret = await call('PUT', '/api/outlook/credentials', { clientId: APP_ID, clientSecret: '9f8e7d6c-1111-2222-3333-444455556666' });
  assert.match(wrongSecret.data.error, /Valeur/);
  assert.equal((await call('PUT', '/api/outlook/credentials', { clientId: 'abc', clientSecret: 'Abc8Q~valeur-du-secret' })).status, 400);
  st = (await call('PUT', '/api/outlook/credentials', { clientId: APP_ID, clientSecret: 'Abc8Q~valeur-du-secret', tenant: '' })).data;
  assert.equal(st.tenant, 'common');

  // Écran de connexion et de consentement Microsoft
  const connect = await call('GET', '/api/outlook/connect');
  assert.equal(connect.status, 302);
  const auth = new URL(connect.res.headers.get('location')!);
  assert.equal(auth.origin + auth.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  assert.equal(auth.searchParams.get('client_id'), APP_ID);
  assert.equal(auth.searchParams.get('redirect_uri'), 'https://plwr.exemple.ca/api/outlook/callback');
  assert.match(auth.searchParams.get('scope')!, /offline_access.*Calendars\.ReadWrite/);
  const state = auth.searchParams.get('state')!;

  // Refus sur l'écran de Microsoft
  const denied = await call('GET', '/api/outlook/callback?error=access_denied&error_description=refus');
  assert.match(decodeURIComponent(denied.res.headers.get('location')!), /refusé l’accès/);

  outlookEvents = [
    { id: 'o-dentiste', subject: 'Dentiste', start: { dateTime: graphTime(at('14:00')) }, end: { dateTime: graphTime(at('15:00')) }, location: { displayName: 'Clinique' }, bodyPreview: 'Apporter la carte', sensitivity: 'normal', type: 'singleInstance' },
    { id: 'o-prive', subject: 'Perso', start: { dateTime: graphTime(at('16:00')) }, end: { dateTime: graphTime(at('16:30')) }, sensitivity: 'private' },
    { id: 'o-allday', subject: 'Congé', isAllDay: true, start: { dateTime: `${day}T00:00:00.0000000` }, end: { dateTime: `${day}T00:00:00.0000000` } },
    { id: 'o-annule', subject: 'Annulé', isCancelled: true, start: { dateTime: graphTime(at('11:00')) }, end: { dateTime: graphTime(at('12:00')) } },
  ];
  const cb = await call('GET', `/api/outlook/callback?code=abc&state=${encodeURIComponent(state)}`);
  assert.equal(cb.res.headers.get('location'), '/reglages/outlook?ok=1');
  st = (await call('GET', '/api/outlook/status')).data;
  assert.equal(st.connected, true);
  assert.equal(st.email, 'camille@outlook.com');

  // Un rendez-vous récurrent PLWR part vers Outlook ; une occurrence supprimée y est supprimée aussi
  const created = await call('POST', '/api/events', { title: 'Course', kind: 'fixed', start: at('07:00'), durationMin: 30, rrule: { freq: 'daily' } });
  let sync = await call('POST', '/api/outlook/sync');
  assert.equal(sync.status, 200, JSON.stringify(sync.data));
  const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/me/events'))!;
  assert.equal(post.body.subject, 'Course');
  assert.equal(post.body.start.timeZone, 'Eastern Standard Time');
  assert.equal(post.body.recurrence.pattern.type, 'daily');
  const { get } = await import('../db.ts');
  const exported = get<{ outlook_id: string }>('SELECT outlook_id FROM outlook_exports')!.outlook_id;
  // Outlook renvoie aussi les occurrences de notre propre série : elles ne doivent pas revenir en double
  outlookEvents.push({ id: 'o-echo-1', subject: 'Course', type: 'occurrence', seriesMasterId: exported, start: { dateTime: graphTime(at('07:00')) }, end: { dateTime: graphTime(at('07:30')) } });
  await call('POST', '/api/outlook/sync');

  // Import : lecture seule, privé → « Occupé seulement », journées entières et annulés ignorés
  const from = encodeURIComponent(at('00:00')), to = encodeURIComponent(at('23:59'));
  let list = (await call('GET', `/api/events?from=${from}&to=${to}`)).data.occurrences;
  const dentiste = list.find((o: any) => o.title === 'Dentiste');
  assert.equal(dentiste.source, 'outlook');
  assert.equal(dentiste.canEdit, false);
  assert.equal(dentiste.location, 'Clinique');
  assert.equal(list.find((o: any) => o.title === 'Perso').visibility, 'busy');
  assert.ok(!list.some((o: any) => o.title === 'Congé' || o.title === 'Annulé'));
  assert.equal(list.filter((o: any) => o.title === 'Course').length, 1, 'pas de doublon de notre série');
  assert.match((await call('PATCH', `/api/events/${dentiste.id}`, { title: 'X' })).data.error, /Outlook/);

  // Occurrence supprimée dans PLWR → instance supprimée chez Outlook
  const occ = list.find((o: any) => o.title === 'Course');
  instances = [{ id: 'inst-1', start: { dateTime: graphTime(occ.start) } }, { id: 'inst-2', start: { dateTime: graphTime(new Date(Date.parse(occ.start) + 86400_000).toISOString()) } }];
  await call('DELETE', `/api/events/${encodeURIComponent(occ.id)}?scope=this`);
  calls.length = 0;
  await call('POST', '/api/outlook/sync');
  assert.ok(calls.some((c) => c.method === 'PATCH'));
  assert.deepEqual(calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('/').pop()), ['inst-1']);

  // Supprimé chez Outlook → retiré de PLWR
  outlookEvents = outlookEvents.filter((e) => e.id !== 'o-dentiste');
  sync = await call('POST', '/api/outlook/sync');
  assert.equal(sync.data.result.removed, 1);

  // Microsoft fait tourner le jeton de renouvellement : le nouveau est gardé
  run("UPDATE outlook_accounts SET access_expires_at = '2000-01-01T00:00:00Z'");
  calls.length = 0;
  await call('POST', '/api/outlook/sync');
  const refreshCall = calls.find((c) => c.url.includes('/token'))!;
  assert.match(String(refreshCall.body), /grant_type=refresh_token/);
  run("UPDATE outlook_accounts SET access_expires_at = '2000-01-01T00:00:00Z'");
  calls.length = 0;
  await call('POST', '/api/outlook/sync');
  const previous = new URLSearchParams(String(refreshCall.body)).get('refresh_token');
  const now = new URLSearchParams(String(calls.find((c) => c.url.includes('/token'))!.body)).get('refresh_token');
  assert.notEqual(previous, now);

  // Secret client expiré : message clair, il faut en créer un nouveau
  run("UPDATE outlook_accounts SET access_expires_at = '2000-01-01T00:00:00Z'");
  tokenError = { error: 'invalid_client', error_description: 'AADSTS7000222: The provided client secret keys are expired.' };
  assert.equal((await call('POST', '/api/outlook/sync')).status, 400);
  st = (await call('GET', '/api/outlook/status')).data;
  assert.match(st.lastError, /secret client a expiré/);
  tokenError = null;

  // Déconnexion : les événements importés disparaissent
  await call('POST', '/api/outlook/disconnect');
  list = (await call('GET', `/api/events?from=${from}&to=${to}`)).data.occurrences;
  assert.ok(!list.some((o: any) => o.source === 'outlook'));
});
