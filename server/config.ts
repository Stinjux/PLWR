import path from 'node:path';

const env = process.env;

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
  /** Secret pour signer les jetons « Reporter » des notifications. Obligatoire en production. */
  appSecret: env.APP_SECRET || 'dev-secret-a-remplacer',
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
    publicKey: env.VAPID_PUBLIC_KEY || '',
    privateKey: env.VAPID_PRIVATE_KEY || '',
    subject: env.VAPID_SUBJECT || 'mailto:admin@example.com',
  },
  schedulerIntervalMs: Number(env.SCHEDULER_INTERVAL_MS || 30000),
};

export const pushEnabled = () => Boolean(config.push.publicKey && config.push.privateKey);
