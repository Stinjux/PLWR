import { serve } from '@hono/node-server';
import { app } from './app.ts';
import { config, pushEnabled, pushState, appSecretSource } from './config.ts';
import { startScheduler } from './services/reminders.ts';
import { startGoogleSync } from './services/google.ts';
import { startOutlookSync } from './services/outlook.ts';
import { startBackups } from './services/backup.ts';
import { storage } from './config.ts';

if (appSecretSource !== 'env' && config.isProd) {
  console.warn('[config] APP_SECRET non défini : un secret a été généré et conservé dans le dossier de données. Définis APP_SECRET pour le fixer.');
}

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`PLWR démarré sur http://localhost:${info.port}`);
  console.log(`  Lecture d'images : ${config.vision.provider}${config.vision.provider === 'anthropic' && !config.vision.anthropicKey ? ' (ANTHROPIC_API_KEY manquante → saisie manuelle proposée)' : ''}`);
  console.log(`  Données : ${config.dataDir}${storage.persistent ? '' : ' ⚠ PAS DE VOLUME RAILWAY : les données seront perdues au prochain déploiement (Settings → Volumes → monter sur /data)'}`);
  console.log(`  Comptes : ${config.maxUsers} au maximum`);
  if (storage.diagnostic.dataDirOverridden) console.warn(`  ⚠ DATA_DIR=${storage.diagnostic.dataDirFromEnv} ignoré : il n'est pas sur le volume Railway. Les données vont dans ${config.dataDir}. Supprime DATA_DIR dans Variables.`);
  if (storage.onRailway) console.log(`  Stockage : volume=${storage.diagnostic.volumeMountPath || 'aucun'} · DATA_DIR=${storage.diagnostic.dataDirFromEnv || '(non défini)'} · disque séparé=${storage.diagnostic.mountedDisk ? 'oui' : 'non'}`);
  console.log(`  Notifications push : ${pushEnabled() ? 'activées' : pushState.error ? 'désactivées (clés VAPID invalides)' : 'désactivées (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY manquantes)'}`);
});
if (process.env.DISABLE_SCHEDULER !== '1') {
  startScheduler();
  startGoogleSync();
  startOutlookSync();
  startBackups();
}
