// Économie de jetons : règles d'abord, plafond quotidien, relevé de consommation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plwr-ai-'));
process.env.APP_SECRET = 'secret-de-test';
process.env.ALLOW_SIGNUP = 'true';
process.env.AI_DAILY_CALLS = '2';
delete process.env.ANTHROPIC_API_KEY;
const { app } = await import('../app.ts');
const { aiAllowed, recordUsage, usageSummary, fallbackParams } = await import('../services/aiUsage.ts');
const { interpretGoal } = await import('../services/goalInterpreter.ts');

async function req(method: string, url: string, body?: any, cookie = '') {
  const res = await app.request(url, { method, headers: { 'x-plwr': '1', 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
}

test('repli serveur seulement pour les modèles qui l’acceptent', () => {
  assert.deepEqual(fallbackParams('claude-opus-5-5'), { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  assert.ok(fallbackParams('claude-sonnet-5-5').fallbacks);
  assert.deepEqual(fallbackParams('claude-haiku-5-5'), {});
});

test('plafond quotidien et relevé du mois', () => {
  assert.equal(aiAllowed('u1'), true);
  recordUsage('u1', 'assistant', 'claude-opus-5-5', { input_tokens: 1000, output_tokens: 100 });
  recordUsage('u1', 'vision', 'claude-opus-5-5', { input_tokens: 1200, output_tokens: 300 });
  assert.equal(aiAllowed('u1'), true, 'la lecture d’images ne compte pas dans le plafond');
  recordUsage('u1', 'goal', 'claude-haiku-5-5', { input_tokens: 500, output_tokens: 50 });
  assert.equal(aiAllowed('u1'), false);
  assert.equal(aiAllowed('u2'), true, 'le plafond est par personne');

  const s = usageSummary();
  assert.equal(s.totalCalls, 3);
  assert.equal(s.totalTokens, 3150);
  const a = s.features.find((f: any) => f.feature === 'assistant')!;
  assert.equal(a.costUsd, (1000 * 4 + 100 * 20) / 1e6);
  assert.equal(s.dailyCallsPerPerson, 2);
});

test('objectif chiffré : règles locales, aucun appel', async () => {
  const r = await interpretGoal('Lire 20 minutes par jour', 'America/Toronto', 'u3');
  assert.notEqual(r.metric, 'check');
  assert.equal(usageSummary().totalCalls, 3);
});

test('relevé réservé à l’administration', async () => {
  const reg = async (email: string) => {
    const res = await app.request('/api/auth/register', { method: 'POST', headers: { 'x-plwr': '1', 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'motdepasse-solide', name: 'x', samples: false }) });
    return (res.headers.get('set-cookie') || '').split(';')[0];
  };
  const admin = await reg('admin@exemple.ca');
  const other = await reg('autre@exemple.ca');
  const ok = await req('GET', '/api/admin/ai-usage', undefined, admin);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.totalCalls, 3);
  assert.equal((await req('GET', '/api/admin/ai-usage', undefined, other)).status, 403);
});
