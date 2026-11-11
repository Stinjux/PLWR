// Accueil : profil obligatoire, dépenses mensuelles, objectif d'épargne, cloche (tâches et alertes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plwr-onboarding-'));
process.env.APP_SECRET = 'secret-de-test';
const { app } = await import('../app.ts');
const { nextMonthlyDate } = await import('../services/onboarding.ts');
const { run, uid, nowIso, get } = await import('../db.ts');

async function req(method: string, url: string, body?: any, cookie = '') {
  const res = await app.request(url, { method, headers: { 'x-plwr': '1', 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { res, status: res.status, data: text ? JSON.parse(text) : null };
}

test('prochaine date mensuelle : aujourd’hui compris, mois courts', () => {
  const tz = 'America/Toronto';
  const from = DateTime.fromISO('2026-11-11T12:00', { zone: tz });
  assert.equal(nextMonthlyDate(11, tz, from), '2026-11-11');
  assert.equal(nextMonthlyDate(1, tz, from), '2026-12-01');
  assert.equal(nextMonthlyDate(31, tz, from), '2026-11-30');
  assert.equal(nextMonthlyDate(31, tz, DateTime.fromISO('2027-02-10T12:00', { zone: tz })), '2027-02-28');
});

test('accueil : profil obligatoire, étapes facultatives, puis tâches dans la cloche', async () => {
  const reg = await req('POST', '/api/auth/register', { email: 'lea@exemple.ca', password: 'motdepasse-solide', name: 'Léa', samples: false });
  const cookie = (reg.res.headers.get('set-cookie') || '').split(';')[0];
  const call = (m: string, u: string, b?: any) => req(m, u, b, cookie);

  let me = (await call('GET', '/api/me')).data;
  assert.equal(me.onboarding.profile, false);
  assert.equal(me.onboarding.completedAt, null);
  assert.equal((await call('POST', '/api/onboarding/complete')).status, 400, 'impossible de terminer sans profil');

  // Profil : chaque champ est validé
  const base = { name: 'Léa', age: 29, profession: 'Infirmière', salaryCents: 2_100_00, salaryPeriod: 'biweekly', salaryType: 'net' };
  assert.match((await call('POST', '/api/onboarding/profile', { ...base, age: 9 })).data.error, /âge/);
  assert.match((await call('POST', '/api/onboarding/profile', { ...base, profession: '' })).data.error, /profession/);
  assert.match((await call('POST', '/api/onboarding/profile', { ...base, salaryCents: 0 })).data.error, /salaire/);
  const nextPay = DateTime.now().plus({ days: 5 }).toISODate();
  const st = (await call('POST', '/api/onboarding/profile', { ...base, nextPayDate: nextPay })).data;
  assert.equal(st.profile, true);
  assert.equal(st.monthlySalaryCents, Math.round((2_100_00 * 26) / 12));
  // La paie nette devient un revenu récurrent
  const pay = get("SELECT * FROM recurring WHERE kind = 'income' AND name = 'Salaire'")!;
  assert.equal(pay.frequency, 'biweekly');
  assert.equal(pay.next_date, nextPay);

  // Dépenses mensuelles : catégorie existante (Loyer) ou créée (Garderie)
  const loyer = (await call('POST', '/api/onboarding/expenses', { preset: 'loyer', amountCents: 1_250_00, day: 1 })).data;
  assert.equal(loyer.name, 'Loyer ou hypothèque');
  await call('POST', '/api/onboarding/expenses', { preset: 'garderie', amountCents: 200_00, day: 15 });
  assert.equal((await call('POST', '/api/onboarding/expenses', { name: 'Netflix', amountCents: -5 })).status, 400);
  const cats = (await call('GET', '/api/budget/categories')).data.categories.map((c: any) => c.label);
  assert.ok(cats.includes('Famille / Garderie'));
  let ob = (await call('GET', '/api/onboarding')).data;
  assert.equal(ob.expenses.items.length, 2);
  assert.equal(ob.expenses.totalMonthlyCents, 1_450_00);

  // On remet les dépenses et l'épargne à plus tard, puis on termine
  await call('POST', '/api/onboarding/step', { step: 'expenses', state: 'skipped' });
  me = (await call('POST', '/api/onboarding/complete')).data;
  assert.ok(me.completedAt);
  assert.equal(me.savings, 'skipped');

  // Cloche : les premières tâches sont la synchro des agendas et les dépenses mensuelles
  let box = (await call('GET', '/api/inbox')).data;
  assert.deepEqual(box.tasks.map((t: any) => t.id), ['sync', 'expenses', 'savings']);
  assert.deepEqual(box.tasks.filter((t: any) => !t.done).map((t: any) => t.id), ['sync', 'expenses', 'savings']);
  assert.match(box.tasks[1].detail, /2 ajoutée\(s\)/);
  assert.equal(box.openTasks, 3);

  // Terminer les dépenses, créer l'objectif d'épargne
  await call('POST', '/api/onboarding/step', { step: 'expenses', state: 'done' });
  assert.equal((await call('POST', '/api/onboarding/savings', { kind: 'target', title: 'Fonds d’urgence', amountCents: 4_000_00 })).status, 400, 'date requise');
  const goal = (await call('POST', '/api/onboarding/savings', { kind: 'target', title: 'Fonds d’urgence', amountCents: 4_000_00, deadline: '2027-06-30' })).data;
  const goals = (await call('GET', '/api/goals')).data;
  assert.equal(goals.find((g: any) => g.id === goal.id).target, 4000);
  box = (await call('GET', '/api/inbox')).data;
  assert.deepEqual(box.tasks.filter((t: any) => !t.done).map((t: any) => t.id), ['sync']);

  // Alertes : facture due bientôt, rappel non lu → lu
  const leaId = (await call('GET', '/api/me')).data.user.id;
  run("UPDATE recurring SET next_date = ? WHERE name = 'Loyer ou hypothèque'", DateTime.now().setZone('America/Toronto').plus({ days: 1 }).toISODate());
  run('INSERT INTO notifications (id, user_id, dedupe_key, kind, title, body, fire_at, sent_at) VALUES (?,?,?,?,?,?,?,?)', uid(), leaId, 'k1', 'event', '📅 Dentiste', 'Commence dans 10 min', nowIso(), nowIso());
  box = (await call('GET', '/api/inbox')).data;
  assert.ok(box.alerts.some((a: any) => a.kind === 'bill' && /Loyer/.test(a.title) && /demain/.test(a.body)));
  assert.ok(box.alerts.some((a: any) => a.kind === 'notification' && a.unread));
  const before = box.badge;
  box = (await call('POST', '/api/inbox/read')).data;
  assert.equal(box.badge, before - 1);
});
