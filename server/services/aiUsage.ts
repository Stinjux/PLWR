import { DateTime } from 'luxon';
import { all, db, get, run, uid, nowIso } from '../db.ts';
import { config } from '../config.ts';

/**
 * Consommation de la clé Anthropic : chaque appel enregistre ses jetons (entrée, sortie, cache) ;
 * un plafond quotidien d'appels par personne garde la dépense prévisible (au-delà : règles locales).
 */
db.exec(`
CREATE TABLE IF NOT EXISTS ai_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  feature TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage(user_id, created_at);
`);

/** Prix publics par million de jetons (entrée, sortie, lecture du cache), en $ US. */
const PRICES: Record<string, [number, number, number]> = {
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-sonnet-5-5': [2, 10, 0.1],
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
};

export type Feature = 'assistant' | 'goal' | 'vision';

/** Les modèles qui acceptent le repli automatique côté serveur en cas de refus (pas Claude Haiku 5.5). */
export function fallbackParams(model: string): { betas?: string[]; fallbacks?: 'default' } {
  return /^claude-(opus-5|sonnet-5-5|fable-5)/.test(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {};
}

const startOfDay = (tz = config.defaultTimezone) => DateTime.now().setZone(tz).startOf('day').toUTC().toISO()!;

/** Encore des appels permis aujourd'hui pour cette personne (assistant et objectifs). */
export function aiAllowed(userId: string, tz?: string): boolean {
  if (config.ai.dailyCalls <= 0) return true;
  const n = get<{ n: number }>("SELECT COUNT(*) n FROM ai_usage WHERE user_id = ? AND feature != 'vision' AND created_at >= ?", userId, startOfDay(tz))!.n;
  return n < config.ai.dailyCalls;
}

export function recordUsage(userId: string | null, feature: Feature, model: string, usage: any) {
  if (!usage) return;
  run(
    'INSERT INTO ai_usage (id, user_id, feature, model, input_tokens, output_tokens, cache_read_tokens, created_at) VALUES (?,?,?,?,?,?,?,?)',
    uid(), userId, feature, model, Number(usage.input_tokens) || 0, Number(usage.output_tokens) || 0, Number(usage.cache_read_input_tokens) || 0, nowIso(),
  );
}

/** Totaux du mois en cours, par fonction, avec un coût estimé. */
export function usageSummary() {
  const from = DateTime.now().setZone(config.defaultTimezone).startOf('month').toUTC().toISO()!;
  const rows = all('SELECT feature, model, COUNT(*) calls, SUM(input_tokens) input, SUM(output_tokens) output, SUM(cache_read_tokens) cached FROM ai_usage WHERE created_at >= ? GROUP BY feature, model', from);
  const byFeature = new Map<string, { feature: string; calls: number; input: number; output: number; costUsd: number }>();
  for (const r of rows) {
    const [pi, po, pc] = PRICES[r.model] || PRICES['claude-opus-5-5'];
    const cost = ((r.input || 0) * pi + (r.output || 0) * po + (r.cached || 0) * pc) / 1_000_000;
    const f = byFeature.get(r.feature) || { feature: r.feature, calls: 0, input: 0, output: 0, costUsd: 0 };
    f.calls += r.calls;
    f.input += r.input || 0;
    f.output += r.output || 0;
    f.costUsd += cost;
    byFeature.set(r.feature, f);
  }
  const features = [...byFeature.values()].map((f) => ({ ...f, costUsd: Math.round(f.costUsd * 10000) / 10000 }));
  return {
    month: DateTime.now().setZone(config.defaultTimezone).toFormat('yyyy-LL'),
    features,
    totalCalls: features.reduce((s, f) => s + f.calls, 0),
    totalTokens: features.reduce((s, f) => s + f.input + f.output, 0),
    totalCostUsd: Math.round(features.reduce((s, f) => s + f.costUsd, 0) * 10000) / 10000,
    dailyCallsPerPerson: config.ai.dailyCalls,
    textModel: config.ai.textModel,
    visionModel: config.vision.anthropicModel,
  };
}
