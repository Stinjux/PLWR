import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';

const PORT = 3200;
const exe = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  workers: 1,
  reporter: [['list']],
  use: {
    ...devices['Pixel 7'],
    baseURL: `http://localhost:${PORT}`,
    locale: 'fr-CA',
    timezoneId: 'America/Toronto',
    launchOptions: exe ? { executablePath: exe } : {},
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `rm -rf tests/.data && npm run build && node server/index.ts`,
    url: `http://localhost:${PORT}/api/auth/status`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PORT: String(PORT),
      DATA_DIR: 'tests/.data',
      VISION_PROVIDER: 'local',
      ALLOW_SIGNUP: 'true',
      SCHEDULER_INTERVAL_MS: '3000',
      APP_SECRET: 'secret-de-test',
    },
  },
});
