import { serve } from '@hono/node-server';
import { app } from './app.ts';
import { config, pushEnabled } from './config.ts';
import { startScheduler } from './services/reminders.ts';

if (config.isProd && config.appSecret === 'dev-secret-a-remplacer') {
  console.error('APP_SECRET doit être défini en production (variable d’environnement).');
  process.exit(1);
}

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`PLWR démarré sur http://localhost:${info.port}`);
  console.log(`  Lecture d'images : ${config.vision.provider}${config.vision.provider === 'anthropic' && !config.vision.anthropicKey ? ' (ANTHROPIC_API_KEY manquante → saisie manuelle proposée)' : ''}`);
  console.log(`  Données : ${config.dataDir}${process.env.RAILWAY_ENVIRONMENT_NAME && !process.env.RAILWAY_VOLUME_MOUNT_PATH && !process.env.DATA_DIR ? ' ⚠ aucun volume Railway : les données seront perdues au prochain déploiement' : ''}`);
  console.log(`  Notifications push : ${pushEnabled() ? 'activées' : 'désactivées (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY manquantes)'}`);
});
if (process.env.DISABLE_SCHEDULER !== '1') startScheduler();
