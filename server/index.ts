import { serve } from '@hono/node-server';
import { app } from './app.ts';
import { config, pushEnabled } from './config.ts';
import { startScheduler } from './services/reminders.ts';

if (process.env.NODE_ENV === 'production' && config.appSecret === 'dev-secret-a-remplacer') {
  console.error('APP_SECRET doit être défini en production.');
  process.exit(1);
}

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`PLWR démarré sur http://localhost:${info.port}`);
  console.log(`  Lecture d'images : ${config.vision.provider}${config.vision.provider === 'anthropic' && !config.vision.anthropicKey ? ' (ANTHROPIC_API_KEY manquante → saisie manuelle proposée)' : ''}`);
  console.log(`  Notifications push : ${pushEnabled() ? 'activées' : 'désactivées (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY manquantes)'}`);
});
if (process.env.DISABLE_SCHEDULER !== '1') startScheduler();
