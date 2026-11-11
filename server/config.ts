import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const env = process.env;

/** Nettoie une valeur collée dans un tableau de bord (espaces, guillemets, retours de ligne). */
function clean(v: string | undefined): string {
  return (v || '').trim().replace(/^["']|["']$/g, '').replace(/\s+/g, '');
}

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'oui'].includes(v.toLowerCase());
}

// Sur Railway : volume persistant et domaine public détectés automatiquement.
const railwayUrl = env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '';
const isProd = env.NODE_ENV === 'production' || Boolean(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT);

export const config = {
  isProd,
  port: Number(env.PORT || 3000),
  host: env.HOST || '0.0.0.0',
  dataDir: path.resolve(env.DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || './data'),
  /** URL publique de l'application (sert aux liens des notifications). */
  appUrl: (env.APP_URL || railwayUrl || 'http://localhost:3000').replace(/\/$/, ''),
  /** Secret pour signer les jetons « Reporter » des notifications (APP_SECRET, sinon généré et conservé dans DATA_DIR). */
  appSecret: '',
  cookieSecure: bool(env.COOKIE_SECURE, isProd),
  allowSignup: bool(env.ALLOW_SIGNUP, false),
  defaultTimezone: env.DEFAULT_TIMEZONE || 'America/Toronto',
  defaultCurrency: 'CAD',

  vision: {
    /** anthropic (par défaut) | local | mock-error */
    provider: (env.VISION_PROVIDER || 'anthropic').toLowerCase(),
    anthropicKey: env.ANTHROPIC_API_KEY || '',
    anthropicModel: env.ANTHROPIC_VISION_MODEL || 'claude-opus-5-5',
    /** Masquer automatiquement les numéros de carte (OCR local) avant l'envoi au fournisseur. */
    redactCardNumbers: bool(env.REDACT_CARD_NUMBERS, true),
    maxUploadBytes: Number(env.MAX_UPLOAD_MB || 12) * 1024 * 1024,
    timeoutMs: Number(env.VISION_TIMEOUT_MS || 60000),
  },
  images: {
    /** Supprimer l'image dès que toutes ses lignes sont validées ou retirées. */
    deleteAfterValidation: bool(env.DELETE_IMAGES_AFTER_VALIDATION, true),
    /** Suppression de sécurité des images non traitées après N heures. */
    maxRetentionHours: Number(env.IMAGE_MAX_RETENTION_HOURS || 72),
  },
  push: {
    publicKey: clean(env.VAPID_PUBLIC_KEY),
    privateKey: clean(env.VAPID_PRIVATE_KEY),
    subject: clean(env.VAPID_SUBJECT) || 'mailto:admin@example.com',
  },
  schedulerIntervalMs: Number(env.SCHEDULER_INTERVAL_MS || 30000),
};

/**
 * Sans APP_SECRET, on génère un secret aléatoire conservé dans le dossier de données
 * (au lieu d'empêcher l'app de démarrer). Sans volume, il change à chaque déploiement.
 */
function resolveSecret(): { value: string; source: 'env' | 'file' | 'generated' } {
  const fromEnv = (env.APP_SECRET || '').trim();
  if (fromEnv) return { value: fromEnv, source: 'env' };
  const file = path.join(config.dataDir, '.app-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return { value: existing, source: 'file' };
  } catch {}
  const value = crypto.randomBytes(32).toString('base64url');
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file, value, { mode: 0o600 });
  } catch {}
  return { value, source: 'generated' };
}
const secret = resolveSecret();
config.appSecret = secret.value;
export const appSecretSource = secret.source;

/** Erreur de configuration des notifications (clés VAPID invalides), affichée dans Réglages. */
export const pushState = { error: '' as string };
export const pushEnabled = () => Boolean(config.push.publicKey && config.push.privateKey && !pushState.error);
