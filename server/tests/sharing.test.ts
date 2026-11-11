// Agenda partagé : invitations, rôles, visibilité « Occupé », participants.
// Parcours bout à bout sur l'API (base en mémoire, inscriptions fermées comme en production).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plwr-sharing-'));
process.env.APP_SECRET = 'secret-de-test';
process.env.ALLOW_SIGNUP = 'false';
const { app } = await import('../app.ts');

type Client = { cookie: string; call: (method: string, url: string, body?: any) => Promise<{ status: number; data: any }> };

async function raw(method: string, url: string, body?: any, cookie = '') {
  const res = await app.request(url, {
    method,
    headers: { 'x-plwr': '1', 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { res, status: res.status, data: text ? JSON.parse(text) : null };
}

async function register(email: string, name: string, invite?: string): Promise<Client> {
  const r = await raw('POST', '/api/auth/register', { email, password: 'motdepasse-solide', name, samples: false, invite });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const cookie = (r.res.headers.get('set-cookie') || '').split(';')[0];
  return { cookie, call: (m, u, b) => raw(m, u, b, cookie) };
}

const tokenOf = (url: string) => url.split('/invitation/')[1];
const day = '2026-11-12';
const at = (hhmm: string) => new Date(`${day}T${hhmm}:00-05:00`).toISOString();
const range = `/api/events?from=${encodeURIComponent(at('00:00'))}&to=${encodeURIComponent(new Date(`2026-11-13T00:00:00-05:00`).toISOString())}`;

test('agenda partagé : invitation, rôles, « Occupé » et participants', async () => {
  const camille = await register('camille@exemple.ca', 'Camille');

  // Inscriptions fermées sans invitation
  const closed = await raw('POST', '/api/auth/register', { email: 'x@exemple.ca', password: 'motdepasse-solide' });
  assert.equal(closed.status, 403);

  // Invitation par courriel (peut modifier)
  const inv = await camille.call('POST', '/api/sharing/invites', { email: 'lea@exemple.ca', role: 'edit' });
  assert.equal(inv.status, 201);
  const token = tokenOf(inv.data.url);
  const pub = await raw('GET', `/api/invites/${token}`);
  assert.equal(pub.data.ownerName, 'Camille');
  assert.equal(pub.data.role, 'edit');
  assert.equal((await raw('GET', `/api/invites/${token}x`)).status, 404, 'jeton falsifié refusé');

  // L'invitation est liée au courriel invité
  const wrong = await raw('POST', '/api/auth/register', { email: 'autre@exemple.ca', password: 'motdepasse-solide', invite: token });
  assert.equal(wrong.status, 400);
  const lea = await register('lea@exemple.ca', 'Léa', token);
  assert.equal((await raw('GET', `/api/invites/${token}`)).status, 404, 'invitation par courriel à usage unique');

  // Camille ajoute un rendez-vous visible et un autre « occupé seulement »
  const open = await camille.call('POST', '/api/events', { title: 'Réunion d’équipe', kind: 'fixed', start: at('09:30'), durationMin: 60, location: 'Salle Érable' });
  assert.equal(open.status, 201);
  const priv = await camille.call('POST', '/api/events', { title: 'Médecin', kind: 'fixed', start: at('14:00'), durationMin: 60, visibility: 'busy' });
  assert.equal(priv.data.visibility, 'busy');

  // Léa (peut modifier) voit tout, même l'élément « occupé seulement »
  let seen = await lea.call('GET', range);
  assert.deepEqual(seen.data.occurrences.map((o: any) => o.title).sort(), ['Médecin', 'Réunion d’équipe']);
  assert.ok(seen.data.people.some((p: any) => p.name === 'Camille' && p.access === 'edit'));

  // Léa ajoute un rendez-vous dans l'agenda de Camille et le modifie
  const added = await lea.call('POST', '/api/events', { title: 'Dîner', kind: 'fixed', start: at('12:00'), durationMin: 60, ownerId: (await camille.call('GET', '/api/me')).data.user.id });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  assert.equal((await lea.call('PATCH', `/api/events/${added.data.id}`, { title: 'Dîner avec Léa' })).status, 200);

  // Camille passe Léa en lecture seule : plus de modification, et « Occupé » remplace le titre privé
  const leaId = (await lea.call('GET', '/api/me')).data.user.id;
  assert.equal((await camille.call('PATCH', `/api/sharing/members/${leaId}`, { role: 'view' })).status, 200);
  assert.equal((await lea.call('PATCH', `/api/events/${added.data.id}`, { title: 'Piraté' })).status, 403);
  assert.equal((await lea.call('DELETE', `/api/events/${open.data.id}`)).status, 403);
  seen = await lea.call('GET', range);
  const titles = seen.data.occurrences.map((o: any) => o.title).sort();
  assert.deepEqual(titles, ['Dîner avec Léa', 'Occupé', 'Réunion d’équipe']);
  const busy = seen.data.occurrences.find((o: any) => o.title === 'Occupé');
  assert.equal(busy.location, null);
  assert.equal(busy.redacted, true);
  assert.equal((await lea.call('GET', `/api/events/${priv.data.id}`)).data.title, 'Occupé');

  // Rôle « occupé seulement » : tout devient « Occupé »
  await camille.call('PATCH', `/api/sharing/members/${leaId}`, { role: 'busy' });
  seen = await lea.call('GET', range);
  assert.ok(seen.data.occurrences.every((o: any) => o.title === 'Occupé'));

  // Lien d'invitation (lecture) : n'importe quel courriel, réutilisable, révocable
  const link = await camille.call('POST', '/api/sharing/link', { enabled: true });
  const thomas = await register('thomas@exemple.ca', 'Thomas', tokenOf(link.data.link));
  const thomasId = (await thomas.call('GET', '/api/me')).data.user.id;
  assert.equal((await raw('GET', `/api/invites/${tokenOf(link.data.link)}`)).status, 200, 'lien réutilisable');

  // Participant : voit les détails d'un élément « occupé seulement » auquel il est invité
  const appt = await camille.call('POST', '/api/events', { title: 'Garage', kind: 'fixed', start: at('16:00'), durationMin: 30, visibility: 'busy', participantIds: [thomasId, 'inconnu'] });
  assert.deepEqual(appt.data.participantIds, [thomasId], 'participants inconnus ignorés');
  seen = await thomas.call('GET', range);
  assert.ok(seen.data.occurrences.some((o: any) => o.title === 'Garage'));
  assert.ok(seen.data.occurrences.some((o: any) => o.title === 'Occupé'), 'Médecin reste privé');

  // Retirer Thomas : il ne voit plus rien de l'agenda de Camille, invitations comprises
  await camille.call('DELETE', `/api/sharing/members/${thomasId}`);
  seen = await thomas.call('GET', range);
  assert.equal(seen.data.occurrences.length, 0);

  // Couper le lien : il ne fonctionne plus
  await camille.call('POST', '/api/sharing/link', { enabled: false });
  assert.equal((await raw('GET', `/api/invites/${tokenOf(link.data.link)}`)).status, 404);

  // Léa quitte l'agenda de Camille
  await lea.call('DELETE', `/api/sharing/shared/${(await camille.call('GET', '/api/me')).data.user.id}`);
  assert.equal((await lea.call('GET', range)).data.occurrences.length, 0);
});
