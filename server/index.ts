import { serve } from '@hono/node-server';
import { app } from './app.ts';
import { config, pushEnabled, pushState, appSecretSource } from './config.ts';
import { startScheduler } from './services/reminders.ts';

if (appSecretSource !== 'env' && config.isProd) {
  console.warn('[config] APP_SECRET non défini : un secret a été généré et conservé dans le dossier de données. Définis APP_SECRET pour le fixer.');
}

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`PLWR démarré sur http://localhost:${info.port}`);
  console.log(`  Lecture d'images : ${config.vision.provider}${config.vision.provider === 'anthropic' && !config.vision.anthropicKey ? ' (ANTHROPIC_API_KEY manquante → saisie manuelle proposée)' : ''}`);
  console.log(`  Données : ${config.dataDir}${process.env.RAILWAY_ENVIRONMENT_NAME && !process.env.RAILWAY_VOLUME_MOUNT_PATH && !process.env.DATA_DIR ? ' ⚠ aucun volume Railway : les données seront perdues au prochain déploiement' : ''}`);
  console.log(`  Notifications push : ${pushEnabled() ? 'activées' : pushState.error ? 'désactivées (clés VAPID invalides)' : 'désactivées (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY manquantes)'}`);
});
if (process.env.DISABLE_SCHEDULER !== '1') startScheduler();
