// Limite de comptes, sauvegardes, session qui reste ouverte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plwr-admin-'));
process.env.APP_SECRET = 'secret-de-test';
process.env.ALLOW_SIGNUP = 'true';
process.env.MAX_USERS = '3';
const { app } = await import('../app.ts');
const { run, get } = await import('../db.ts');
const { backupNow, listBackups } = await import('../services/backup.ts');

async function req(method: string, url: string, body?: any, cookie = '') {
  const res = await app.request(url, { method, headers: { 'x-plwr': '1', 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const buf = Buffer.from(await res.arrayBuffer());
  let data: any = null;
  try {
    data = JSON.parse(buf.toString());
  } catch {}
  return { res, status: res.status, data, buf };
}
const register = async (email: string) => {
  const r = await req('POST', '/api/auth/register', { email, password: 'motdepasse-solide', name: email.split('@')[0], samples: false });
  return { r, cookie: (r.res.headers.get('set-cookie') || '').split(';')[0] };
};

test('limite de comptes, sauvegardes et session glissante', async () => {
  const admin = await register('admin@exemple.ca');
  const b = await register('b@exemple.ca');
  let st = (await req('GET', '/api/auth/status')).data;
  assert.deepEqual([st.users, st.maxUsers, st.full, st.signupOpen], [2, 3, false, true]);
  assert.equal(st.persistent, false, 'base en mémoire (tests) : rien ne survit, et l’app le signale');
  await register('c@exemple.ca');

  // Limite atteinte : plus d'inscription, plus d'invitation pour un nouveau courriel
  st = (await req('GET', '/api/auth/status')).data;
  assert.deepEqual([st.full, st.signupOpen], [true, false]);
  const d = await register('d@exemple.ca');
  assert.equal(d.r.status, 403);
  assert.match(d.r.data.error, /limité à 3 comptes/);
  const inv = await req('POST', '/api/sharing/invites', { email: 'nouveau@exemple.ca', role: 'view' }, admin.cookie);
  assert.match(inv.data.error, /limité à 3 comptes/);
  // …mais on peut toujours inviter quelqu'un qui a déjà un compte
  assert.equal((await req('POST', '/api/sharing/invites', { email: 'b@exemple.ca', role: 'view' }, admin.cookie)).status, 201);

  // Sauvegardes : réservées au premier compte
  assert.equal((await req('GET', '/api/me', undefined, admin.cookie)).data.isAdmin, true);
  assert.equal((await req('GET', '/api/me', undefined, b.cookie)).data.isAdmin, false);
  assert.equal((await req('GET', '/api/admin/storage', undefined, b.cookie)).status, 403);
  assert.equal((await req('GET', '/api/admin/backup/download', undefined, b.cookie)).status, 403);
  const dl = await req('GET', '/api/admin/backup/download', undefined, admin.cookie);
  assert.equal(dl.status, 200);
  assert.match(dl.res.headers.get('content-disposition')!, /attachment; filename="plwr-.*\.sqlite"/);
  assert.equal(dl.buf.subarray(0, 15).toString(), 'SQLite format 3');
  backupNow();
  backupNow(); // même jour : remplacée, pas dupliquée
  assert.equal(listBackups().length, 1);
  const storage = (await req('GET', '/api/admin/storage', undefined, admin.cookie)).data;
  assert.equal(storage.backups.length, 1);
  assert.equal(storage.users, 3);

  // Session glissante : bientôt expirée, elle est prolongée à l'utilisation
  run("UPDATE sessions SET expires_at = ?", new Date(Date.now() + 2 * 86400_000).toISOString());
  const me = await req('GET', '/api/me', undefined, b.cookie);
  assert.match(me.res.headers.get('set-cookie') || '', /plwr_sid=/);
  const s = get<{ expires_at: string }>('SELECT expires_at FROM sessions ORDER BY expires_at DESC LIMIT 1')!;
  assert.ok(s.expires_at > new Date(Date.now() + 25 * 86400_000).toISOString());
});
