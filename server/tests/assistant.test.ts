// Assistant de la journée (règles locales) et saisie rapide d'une dépense.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plwr-assistant-'));
process.env.APP_SECRET = 'secret-de-test';
process.env.ALLOW_SIGNUP = 'true';
delete process.env.ANTHROPIC_API_KEY;
const { app } = await import('../app.ts');

async function req(method: string, url: string, body?: any, cookie = '') {
  const res = await app.request(url, { method, headers: { 'x-plwr': '1', 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { res, status: res.status, data: text ? JSON.parse(text) : null };
}

test('assistant : bilan, « j’ai fini », déplacer, reporter, réorganiser — rien sans confirmation', async () => {
  const r = await req('POST', '/api/auth/register', { email: 'a@exemple.ca', password: 'motdepasse-solide', name: 'Léa', samples: false });
  const cookie = (r.res.headers.get('set-cookie') || '').split(';')[0];
  const call = (m: string, u: string, b?: any) => req(m, u, b, cookie);
  const tz = 'America/Toronto';
  const late = DateTime.now().setZone(tz).endOf('day').minus({ minutes: 90 }); // plus tard aujourd'hui
  const at = (d: DateTime) => d.toUTC().toISO()!;
  const run = (await call('POST', '/api/events', { title: 'Course au parc', kind: 'flexible', start: at(late), durationMin: 30 })).data;
  await call('POST', '/api/events', { title: 'Appel avec Marc', kind: 'fixed', start: at(late.plus({ minutes: 45 })), durationMin: 30 });
  await call('POST', '/api/events', { title: 'Lire le rapport', kind: 'flexible', start: null, planDate: DateTime.now().setZone(tz).toISODate(), durationMin: 60 });

  // Bilan
  let a = (await call('POST', '/api/assistant', { message: 'Où j’en suis ?' })).data;
  assert.equal(a.source, 'rules');
  assert.match(a.reply, /0 tâche terminée sur 2/);
  assert.match(a.reply, /Prochain : Course au parc/);

  // « J'ai fini » → proposition, rien n'est fait avant d'appliquer
  a = (await call('POST', '/api/assistant', { message: 'J’ai fini la course' })).data;
  assert.equal(a.proposals[0].type, 'complete');
  assert.equal(a.proposals[0].itemId, run.id);
  let day = (await call('GET', '/api/assistant/day')).data;
  assert.equal(day.items.find((i: any) => i.id === run.id).status, 'active');
  const applied = (await call('POST', '/api/assistant/apply', { proposal: a.proposals[0] })).data;
  assert.equal(applied.message, 'Marqué comme fait.');
  assert.match(applied.summary, /1 tâche terminée sur 2/);

  // Déplacer à une heure
  a = (await call('POST', '/api/assistant', { message: 'Déplace l’appel avec Marc à 23 h 15' })).data;
  assert.equal(a.proposals[0].type, 'move');
  assert.equal(DateTime.fromISO(a.proposals[0].start).setZone(tz).toFormat('HH:mm'), '23:15');
  await call('POST', '/api/assistant/apply', { proposal: a.proposals[0] });

  // Reporter à demain une tâche à placer
  a = (await call('POST', '/api/assistant', { message: 'Reporte le rapport à demain' })).data;
  assert.equal(a.proposals[0].type, 'postpone');
  assert.equal(a.proposals[0].start, null);
  await call('POST', '/api/assistant/apply', { proposal: a.proposals[0] });
  day = (await call('GET', '/api/assistant/day')).data;
  assert.ok(!day.items.some((i: any) => i.title === 'Lire le rapport'));

  // Réorganiser : une proposition « plan » (ou rien à déplacer)
  a = (await call('POST', '/api/assistant', { message: 'Réorganise ma journée' })).data;
  assert.ok(a.proposals.length === 0 || a.proposals[0].type === 'plan');

  // Élément inconnu : question, pas de proposition
  a = (await call('POST', '/api/assistant', { message: 'Déplace le yoga à 10 h' })).data;
  assert.equal(a.proposals.length, 0);
  assert.match(a.reply, /Quel élément/);

  // Une proposition forgée sur l'élément d'un autre compte est refusée
  assert.equal((await call('POST', '/api/assistant/apply', { proposal: { type: 'complete', itemId: 'inconnu' } })).status, 404);
});

test('saisie rapide d’une dépense : aperçu puis enregistrement', async () => {
  const r = await req('POST', '/api/auth/register', { email: 'b@exemple.ca', password: 'motdepasse-solide', name: 'Sam', samples: false });
  const cookie = (r.res.headers.get('set-cookie') || '').split(';')[0];
  const call = (m: string, u: string, b?: any) => req(m, u, b, cookie);
  const p = (await call('POST', '/api/expenses/preview', { text: '64 $ épicerie chez IGA hier' })).data;
  assert.equal(p.amountCents, 6400);
  assert.equal(p.merchant, 'IGA');
  const saved = await call('POST', '/api/expenses', { amountCents: 6400, merchant: 'IGA', date: p.date, categoryId: p.categoryId });
  assert.equal(saved.status, 201);
  const txs = (await call('GET', `/api/transactions?month=${p.date.slice(0, 7)}`)).data;
  assert.equal(txs[0].merchant, 'IGA');
  assert.equal((await call('GET', '/api/me')).data.onboarding.firstAction, null, 'la saisie rapide ne compte pas comme action d’accueil');
});
