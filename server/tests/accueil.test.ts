// Nouvel accueil : trois parcours, une action réelle, mesure de l'adoption ; objectif écrit librement (règles locales).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plwr-accueil-'));
process.env.APP_SECRET = 'secret-de-test';
process.env.ALLOW_SIGNUP = 'true';
delete process.env.ANTHROPIC_API_KEY;
const { app } = await import('../app.ts');
const { interpretWithRules } = await import('../services/goalInterpreter.ts');
const { run, get } = await import('../db.ts');

async function req(method: string, url: string, body?: any, cookie = '') {
  const res = await app.request(url, { method, headers: { 'x-plwr': '1', 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { res, status: res.status, data: text ? JSON.parse(text) : null };
}
async function account(email: string) {
  const r = await req('POST', '/api/auth/register', { email, password: 'motdepasse-solide', name: email.split('@')[0], samples: false });
  const cookie = (r.res.headers.get('set-cookie') || '').split(';')[0];
  return (m: string, u: string, b?: any) => req(m, u, b, cookie);
}
const profile = { name: 'Léa', age: 29, profession: 'Infirmière', salaryCents: 72_000_00, salaryPeriod: 'year', salaryType: 'gross' };
const tomorrowAt = (h: number) => DateTime.now().setZone('America/Toronto').plus({ days: 1 }).set({ hour: h, minute: 0 }).toUTC().toISO()!;

test('objectif écrit librement : règles locales', () => {
  let g = interpretWithRules('Courir 3 fois par semaine');
  assert.deepEqual([g.metric, g.target, g.unit, g.period, g.kind], ['quantity', 3, 'fois', 'weekly', 'personal']);
  g = interpretWithRules('Lire 20 min par jour');
  assert.deepEqual([g.metric, g.target, g.period], ['duration', 20, 'daily']);
  g = interpretWithRules('Mettre 5 000 $ de côté pour un voyage d’ici juin');
  assert.deepEqual([g.metric, g.target, g.unit, g.kind], ['amount', 5000, '$', 'financial']);
  assert.match(g.deadline!, /-06-30$/);
  g = interpretWithRules('Épargner 250 $ par mois');
  assert.deepEqual([g.target, g.period], [250, 'monthly']);
  g = interpretWithRules('Apprendre l’espagnol');
  assert.deepEqual([g.metric, g.target, g.period], ['check', 1, 'once']);
  assert.ok(g.firstStep.title.length > 0);
});

test('parcours « Gérer mes dépenses » : aperçu, correction, confirmation, puis mesure', async () => {
  const call = await account('depense@exemple.ca');
  await call('POST', '/api/track', { name: 'onboarding_started' });
  await call('POST', '/api/track', { name: 'onboarding_started' }); // compté une fois
  assert.equal((await call('POST', '/api/track', { name: 'piratage' })).status, 400);
  await call('POST', '/api/onboarding/path', { path: 'expense' });

  assert.match((await call('POST', '/api/onboarding/expense/preview', { text: 'café ce matin' })).data.error, /montant/);
  const p = (await call('POST', '/api/onboarding/expense/preview', { text: '12,50 $ café ce matin chez Tim Hortons' })).data;
  assert.equal(p.amountCents, 1250);
  assert.equal(p.merchant, 'Tim Hortons');
  assert.ok(p.categories.find((c: any) => c.id === p.categoryId).label.includes('Restaurants'));
  // Correction : la personne change le montant avant de confirmer
  await call('POST', '/api/onboarding/expense', { amountCents: 1375, merchant: p.merchant, date: p.date, categoryId: p.categoryId });
  let st = (await call('GET', '/api/me')).data.onboarding;
  assert.equal(st.firstAction.kind, 'expense');
  assert.match(st.firstAction.label, /Tim Hortons · 13,75/);
  // L'accueil ne se termine pas sans profil
  assert.equal((await call('POST', '/api/onboarding/complete')).status, 400);
  await call('POST', '/api/onboarding/profile', profile);
  st = (await call('POST', '/api/onboarding/complete')).data;
  assert.ok(st.completedAt);
  assert.equal(st.welcomeSeen, false);
  // Deuxième action utile, puis bienvenue lue
  const cats = (await call('GET', '/api/budget/categories')).data.categories;
  await call('POST', '/api/transactions', { date: p.date, merchant: 'IGA', amountCents: 4200, splits: [{ categoryId: cats.find((c: any) => c.name === 'Épicerie').id, amountCents: 4200 }] });
  assert.equal((await call('POST', '/api/onboarding/welcome-seen')).data.welcomeSeen, true);
});

test('parcours « Suivre un objectif » et « Planifier ma semaine », puis tableau d’adoption', async () => {
  const goalUser = await account('objectif@exemple.ca');
  await goalUser('POST', '/api/track', { name: 'onboarding_started' });
  await goalUser('POST', '/api/onboarding/path', { path: 'goal' });
  const g = (await goalUser('POST', '/api/onboarding/goal/interpret', { text: 'Courir 3 fois par semaine' })).data;
  assert.equal(g.source, 'rules');
  const r = await goalUser('POST', '/api/onboarding/goal', { goal: g, step: { title: 'Première course de 20 min', start: tomorrowAt(18), durationMin: 30 } });
  assert.equal(r.status, 201);
  const goals = (await goalUser('GET', '/api/goals')).data;
  assert.equal(goals[0].title, 'Courir 3 fois par semaine');
  assert.equal(goals[0].linkedBlocks, 1, 'la première étape est liée à l’objectif');
  assert.match((await goalUser('GET', '/api/me')).data.onboarding.firstAction.label, /Première course de 20 min · demain à 18 h/);

  const weekUser = await account('semaine@exemple.ca');
  await weekUser('POST', '/api/track', { name: 'onboarding_started' });
  await weekUser('POST', '/api/onboarding/path', { path: 'week' });
  assert.equal((await weekUser('POST', '/api/onboarding/event', { title: '', start: tomorrowAt(14) })).status, 400);
  const ev = (await weekUser('POST', '/api/onboarding/event', { title: 'Dentiste', start: tomorrowAt(14), durationMin: 60 })).data;
  assert.deepEqual(ev.reminders, [], 'pas de rappel tant que la personne ne le demande pas');

  const explorer = await account('explore@exemple.ca');
  await explorer('POST', '/api/track', { name: 'onboarding_started' });
  await explorer('POST', '/api/onboarding/path', { path: 'explore' });

  // Retour à J+1 simulé pour la personne « dépenses » (inscrite hier)
  const dep = get<{ id: string }>("SELECT id FROM users WHERE email = 'depense@exemple.ca'")!;
  const yesterday = DateTime.now().setZone('America/Toronto').minus({ days: 1 });
  run('UPDATE users SET created_at = ? WHERE id = ?', yesterday.toUTC().toISO(), dep.id);
  run('INSERT OR IGNORE INTO activity_days (user_id, day) VALUES (?,?)', dep.id, yesterday.plus({ days: 1 }).toISODate());

  // Tableau réservé au premier compte (« dépenses »)
  assert.equal((await goalUser('GET', '/api/admin/metrics')).status, 403);
  const adminCall = async (u: string) => {
    const row = get<{ id: string }>("SELECT id FROM users WHERE email = 'depense@exemple.ca'")!;
    void row;
    const login = await req('POST', '/api/auth/login', { email: 'depense@exemple.ca', password: 'motdepasse-solide' });
    return req('GET', u, undefined, (login.res.headers.get('set-cookie') || '').split(';')[0]);
  };
  const m = (await adminCall('/api/admin/metrics')).data;
  const by = Object.fromEntries(m.paths.map((p: any) => [p.path, p]));
  assert.equal(m.totalStarted, 4);
  assert.equal(by.expense.firstActionRate, 100);
  assert.equal(by.expense.secondActionRate, 100);
  assert.deepEqual([by.expense.d1Rate, by.expense.d1Eligible], [100, 1]);
  assert.equal(by.goal.firstActionRate, 100);
  assert.equal(by.goal.secondActionRate, 0);
  assert.equal(by.week.firstActionRate, 100);
  assert.equal(by.explore.firstActionRate, 0);
  assert.equal(typeof by.week.medianSecondsToFirstAction, 'number');
});
