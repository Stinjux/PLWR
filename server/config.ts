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

/**
 * Dossier de données. Sur Railway avec un volume, les données vont TOUJOURS sur le volume : un DATA_DIR qui pointe
 * ailleurs (souvent « ./data » recopié de .env.example) écrirait sur le disque temporaire, effacé à chaque déploiement.
 */
const volumePath = env.RAILWAY_VOLUME_MOUNT_PATH ? path.resolve(env.RAILWAY_VOLUME_MOUNT_PATH) : '';
const isUnder = (dir: string, root: string) => dir === root || dir.startsWith(root + path.sep);
const requestedDataDir = path.resolve(env.DATA_DIR || volumePath || './data');
const dataDirOverridden = Boolean(volumePath) && !isUnder(requestedDataDir, volumePath);

export const config = {
  isProd,
  port: Number(env.PORT || 3000),
  host: env.HOST || '0.0.0.0',
  dataDir: dataDirOverridden ? volumePath : requestedDataDir,
  /** URL publique de l'application (sert aux liens des notifications). */
  appUrl: (env.APP_URL || railwayUrl || 'http://localhost:3000').replace(/\/$/, ''),
  /** Secret pour signer les jetons « Reporter » des notifications (APP_SECRET, sinon généré et conservé dans DATA_DIR). */
  appSecret: '',
  cookieSecure: bool(env.COOKIE_SECURE, isProd),
  allowSignup: bool(env.ALLOW_SIGNUP, false),
  /** Nombre maximal de comptes (inscriptions et invitations comprises). */
  maxUsers: Math.max(1, Number(env.MAX_USERS || 6)),
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
    /** Budget de pixels de l'image envoyée (facturée au pixel) : environ 0,9 mégapixel suffit pour lire un reçu. */
    maxMegapixels: Math.min(1.15, Math.max(0.3, Number(env.VISION_MAX_MEGAPIXELS || 0.9))),
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
  /** Usage de la clé Anthropic pour l'assistant et les objectifs (la lecture d'images a son propre modèle). */
  ai: {
    textModel: clean(env.ANTHROPIC_TEXT_MODEL) || 'claude-opus-5-5',
    /** Appels par personne et par jour (assistant + objectifs) ; au-delà, règles locales. 0 = sans limite. */
    dailyCalls: Math.max(0, Number(env.AI_DAILY_CALLS ?? 30)),
  },
  /** Google Agenda. Facultatif : sans ces variables, chaque personne importe ses propres identifiants dans Réglages. */
  google: {
    clientId: clean(env.GOOGLE_CLIENT_ID),
    clientSecret: clean(env.GOOGLE_CLIENT_SECRET),
    syncMinutes: Math.max(1, Number(env.GOOGLE_SYNC_MINUTES || 5)),
  },
  /** Outlook (Microsoft Graph). Facultatif, comme Google : sinon chaque personne importe ses identifiants. */
  outlook: {
    clientId: clean(env.OUTLOOK_CLIENT_ID),
    clientSecret: clean(env.OUTLOOK_CLIENT_SECRET),
    /** common : comptes professionnels/scolaires et personnels (Outlook.com) ; consumers : personnels seulement. */
    tenant: clean(env.OUTLOOK_TENANT) || 'common',
    syncMinutes: Math.max(1, Number(env.OUTLOOK_SYNC_MINUTES || env.GOOGLE_SYNC_MINUTES || 5)),
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
/**
 * Les données survivent-elles à un redéploiement ? Sur Railway, seulement si le dossier de données est sur un volume.
 * Deux indices : la variable RAILWAY_VOLUME_MOUNT_PATH (le dossier est dessous) ou un disque monté à part
 * (le dossier n'est pas sur le même périphérique que la racine du conteneur). Ailleurs, on suppose un disque persistant.
 */
const onRailway = Boolean(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT);
const underVolume = Boolean(volumePath) && isUnder(config.dataDir, volumePath);
function onMountedDisk(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return fs.statSync(dir).dev !== fs.statSync('/').dev;
  } catch {
    return false;
  }
}
const mountedDisk = onMountedDisk(config.dataDir);
export const storage = {
  onRailway,
  persistent: env.DB_FILE !== ':memory:' && (!onRailway || underVolume || mountedDisk),
  appSecretFromEnv: Boolean((env.APP_SECRET || '').trim()),
  /** Diagnostic affiché à l'administrateur dans Réglages. */
  diagnostic: {
    dataDir: config.dataDir,
    dataDirFromEnv: env.DATA_DIR || null,
    volumeMountPath: env.RAILWAY_VOLUME_MOUNT_PATH || null,
    underVolume,
    mountedDisk,
    /** DATA_DIR ignoré parce qu'il n'était pas sur le volume. */
    dataDirOverridden,
  },
};

const secret = resolveSecret();
config.appSecret = secret.value;
export const appSecretSource = secret.source;

/** Erreur de configuration des notifications (clés VAPID invalides), affichée dans Réglages. */
export const pushState = { error: '' as string };
export const pushEnabled = () => Boolean(config.push.publicKey && config.push.privateKey && !pushState.error);
