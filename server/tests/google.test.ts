// Google Agenda : identifiants importés, consentement OAuth, import/export et suppression — Google simulé.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plwr-google-'));
process.env.APP_SECRET = 'secret-de-test';
process.env.APP_URL = 'https://plwr.exemple.ca';
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
const { app } = await import('../app.ts');
const { setGoogleFetch, toGoogleRule } = await import('../services/google.ts');
const { run } = await import('../db.ts');

// ---------- Faux Google ----------
const calls: { method: string; url: string; body: any }[] = [];
let googleEvents: any[] = [];
let tokenError: string | null = null;
let n = 0;
const json = (status: number, data: any) => new Response(data === null ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
setGoogleFetch((async (input: any, init: any = {}) => {
  const url = String(input);
  const method = init.method || 'GET';
  const body = typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body;
  calls.push({ method, url, body });
  if (url.startsWith('https://oauth2.googleapis.com/token')) {
    if (tokenError) return json(400, { error: tokenError });
    const idToken = `x.${Buffer.from(JSON.stringify({ email: 'camille@gmail.com' })).toString('base64url')}.y`;
    return json(200, { access_token: `acc-${++n}`, expires_in: 3600, refresh_token: 'ref-1', scope: 'openid email https://www.googleapis.com/auth/calendar.events', id_token: idToken });
  }
  if (url.startsWith('https://oauth2.googleapis.com/revoke')) return json(200, {});
  if (url.startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events')) {
    assert.match(init.headers.authorization, /^Bearer acc-/);
    if (method === 'GET') return json(200, { items: googleEvents });
    if (method === 'POST') return json(200, { id: `g-${++n}` });
    if (method === 'PUT') return json(200, { id: url.split('/').pop() });
    if (method === 'DELETE') return new Response(null, { status: 204 });
  }
  return json(404, { error: 'inconnu' });
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

test('RRULE : hebdomadaire, 2e mardi, fin de série', () => {
  assert.equal(toGoogleRule({ freq: 'weekly', byDay: [3, 1] }, 'America/Toronto'), 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE');
  assert.equal(toGoogleRule({ freq: 'monthly', byDay: [2], bySetPos: 2 }, 'America/Toronto'), 'RRULE:FREQ=MONTHLY;BYDAY=2TU');
  assert.equal(toGoogleRule({ freq: 'daily', interval: 2, until: '2026-12-31' }, 'America/Toronto'), 'RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20270101T045959Z');
  assert.equal(toGoogleRule({ freq: 'yearly', count: 5 }, 'America/Toronto'), 'RRULE:FREQ=YEARLY;COUNT=5');
});

test('Google Agenda : identifiants importés, consentement, import et envoi', async () => {
  const reg = await req('POST', '/api/auth/register', { email: 'camille@exemple.ca', password: 'motdepasse-solide', name: 'Camille', samples: false });
  const cookie = (reg.res.headers.get('set-cookie') || '').split(';')[0];
  const call = (m: string, u: string, b?: any) => req(m, u, b, cookie);

  let st = (await call('GET', '/api/google/status')).data;
  assert.equal(st.hasCredentials, false);
  assert.equal(st.redirectUri, 'https://plwr.exemple.ca/api/google/callback');
  assert.equal((await call('GET', '/api/google/connect')).status, 400, 'pas de connexion sans identifiants');

  // Identifiants importés
  assert.equal((await call('PUT', '/api/google/credentials', { clientId: 'pas-un-id', clientSecret: 'GOCSPX-abcdefghijkl' })).status, 400);
  st = (await call('PUT', '/api/google/credentials', { clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-abcdefghijkl' })).data;
  assert.equal(st.credentialsSource, 'user');
  assert.equal(st.clientId, '123-abc.apps.googleusercontent.com');

  // Écran de consentement : bonne adresse, accès durable demandé
  const connect = await call('GET', '/api/google/connect');
  assert.equal(connect.status, 302);
  const auth = new URL(connect.res.headers.get('location')!);
  assert.equal(auth.host, 'accounts.google.com');
  assert.equal(auth.searchParams.get('client_id'), '123-abc.apps.googleusercontent.com');
  assert.equal(auth.searchParams.get('redirect_uri'), 'https://plwr.exemple.ca/api/google/callback');
  assert.equal(auth.searchParams.get('access_type'), 'offline');
  assert.match(auth.searchParams.get('scope')!, /calendar\.events/);
  const state = auth.searchParams.get('state')!;

  // Un état falsifié est refusé
  const forged = await call('GET', `/api/google/callback?code=abc&state=${encodeURIComponent(state + 'x')}`);
  assert.match(forged.res.headers.get('location')!, /erreur=/);

  // Google renvoie un événement avec heure, une journée entière, et un événement envoyé par PLWR
  googleEvents = [
    { id: 'g-dentiste', status: 'confirmed', summary: 'Dentiste', location: 'Clinique', description: '<p>Apporter <b>carte</b></p>', start: { dateTime: at('14:00') }, end: { dateTime: at('15:00') } },
    { id: 'g-prive', status: 'confirmed', summary: 'Rendez-vous perso', visibility: 'private', start: { dateTime: at('16:00') }, end: { dateTime: at('16:30') } },
    { id: 'g-allday', status: 'confirmed', summary: 'Congé', start: { date: day }, end: { date: day } },
    { id: 'g-echo', status: 'confirmed', summary: 'Déjà dans PLWR', extendedProperties: { private: { plwrId: 'x' } }, start: { dateTime: at('09:00') }, end: { dateTime: at('10:00') } },
  ];
  const cb = await call('GET', `/api/google/callback?code=abc&state=${encodeURIComponent(state)}`);
  assert.equal(cb.res.headers.get('location'), '/reglages/google?ok=1');
  st = (await call('GET', '/api/google/status')).data;
  assert.equal(st.connected, true);
  assert.equal(st.email, 'camille@gmail.com');

  // Un événement PLWR (récurrent) part vers Google
  const created = await call('POST', '/api/events', { title: 'Course', kind: 'fixed', start: at('07:00'), durationMin: 30, rrule: { freq: 'weekly', byDay: [1, 3] } });
  assert.equal(created.status, 201);
  const sync = await call('POST', '/api/google/sync');
  assert.equal(sync.status, 200, JSON.stringify(sync.data));
  const post = calls.find((c) => c.method === 'POST' && c.url.includes('/calendar/v3/'))!;
  assert.equal(post.body.summary, 'Course');
  assert.equal(post.body.extendedProperties.private.plwrId, created.data.eventId);
  assert.deepEqual(post.body.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE']);

  // Import : seulement les événements avec heure venant de Google, en lecture seule
  const from = encodeURIComponent(at('00:00')), to = encodeURIComponent(at('23:59'));
  let list = (await call('GET', `/api/events?from=${from}&to=${to}`)).data.occurrences;
  const dentiste = list.find((o: any) => o.title === 'Dentiste');
  assert.ok(dentiste);
  assert.equal(dentiste.source, 'google');
  assert.equal(dentiste.canEdit, false);
  assert.equal(dentiste.notes, 'Apporter carte');
  assert.equal(list.find((o: any) => o.title === 'Rendez-vous perso').visibility, 'busy');
  assert.ok(!list.some((o: any) => o.title === 'Congé' || o.title === 'Déjà dans PLWR'));
  assert.equal((await call('PATCH', `/api/events/${dentiste.id}`, { title: 'X' })).status, 403);

  // Pas de nouvel envoi si rien n'a changé ; modification → PUT
  calls.length = 0;
  await call('POST', '/api/google/sync');
  assert.ok(!calls.some((c) => ['POST', 'PUT'].includes(c.method) && c.url.includes('/calendar/v3/')));
  await call('PATCH', `/api/events/${encodeURIComponent(created.data.id)}?scope=all`, { title: 'Course matinale' });
  await call('POST', '/api/google/sync');
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 1);

  // Supprimé chez Google → retiré de PLWR ; supprimé dans PLWR → effacé chez Google
  googleEvents = googleEvents.filter((e) => e.id !== 'g-dentiste');
  await call('DELETE', `/api/events/${encodeURIComponent(created.data.id)}?scope=all`);
  calls.length = 0;
  const r = (await call('POST', '/api/google/sync')).data.result;
  assert.equal(r.removed, 1);
  assert.equal(r.deleted, 1);
  assert.ok(calls.some((c) => c.method === 'DELETE'));
  list = (await call('GET', `/api/events?from=${from}&to=${to}`)).data.occurrences;
  assert.ok(!list.some((o: any) => o.title === 'Dentiste'));

  // Jeton expiré : renouvelé automatiquement ; accès retiré chez Google : déconnexion propre
  run("UPDATE google_accounts SET access_expires_at = '2000-01-01T00:00:00Z'");
  calls.length = 0;
  await call('POST', '/api/google/sync');
  assert.ok(calls.some((c) => c.url.includes('oauth2.googleapis.com/token') && String(c.body).includes('grant_type=refresh_token')));
  run("UPDATE google_accounts SET access_expires_at = '2000-01-01T00:00:00Z'");
  tokenError = 'invalid_grant';
  assert.equal((await call('POST', '/api/google/sync')).status, 400);
  st = (await call('GET', '/api/google/status')).data;
  assert.equal(st.connected, false);
  assert.match(st.lastError, /reconnecte/);
  tokenError = null;

  // Déconnexion : les événements importés disparaissent
  await call('POST', '/api/google/disconnect');
  list = (await call('GET', `/api/events?from=${from}&to=${to}`)).data.occurrences;
  assert.ok(!list.some((o: any) => o.source === 'google'));
});
