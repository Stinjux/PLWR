import { test, expect } from '@playwright/test';
import { signup } from './helpers';

test('Google Agenda : guide pas à pas, import du fichier JSON et écran de consentement', async ({ page }) => {
  await signup(page);
  await page.goto('/reglages');
  await page.getByRole('button', { name: 'Connecter Google Agenda (guide pas à pas)' }).click();
  await expect(page).toHaveURL(/\/reglages\/google/);
  await expect(page.getByRole('heading', { name: 'Google Agenda', level: 1 })).toBeVisible();
  for (const n of [1, 2, 3, 4, 5, 6, 7]) await expect(page.getByRole('region', { name: new RegExp(`^Étape ${n} :`) })).toBeVisible();
  const redirect = await page.getByTestId('redirect-uri').textContent();
  expect(redirect).toMatch(/\/api\/google\/callback$/);

  // Import du fichier téléchargé depuis Google Cloud
  const file = { web: { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-secret-de-test', redirect_uris: [redirect] } };
  await page.getByLabel('Fichier JSON des identifiants Google').setInputFiles({ name: 'client_secret_123.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
  await expect(page.getByLabel('ID client')).toHaveValue('123-abc.apps.googleusercontent.com');
  await page.getByRole('button', { name: 'Importer mes identifiants' }).click();
  await expect(page.getByTestId('credentials-ok')).toContainText('123-abc.apps.googleusercontent.com');
  await expect(page.getByTestId('google-status')).toContainText('Prêt à connecter');

  // « Connecter » ouvre l'écran de consentement de Google avec le bon client et l'accès durable
  const outgoing = page.waitForRequest((r) => r.url().startsWith('https://accounts.google.com/'));
  await page.getByTestId('google-status').getByRole('button', { name: 'Connecter Google Agenda' }).click();
  const consent = new URL((await outgoing).url());
  expect(consent!.searchParams.get('client_id')).toBe('123-abc.apps.googleusercontent.com');
  expect(consent!.searchParams.get('redirect_uri')).toBe(redirect);
  expect(consent!.searchParams.get('access_type')).toBe('offline');
  expect(consent!.searchParams.get('scope')).toContain('calendar.events');

  // Refus sur l'écran de Google : retour avec un message clair
  await page.goto('/api/google/callback?error=access_denied&state=x');
  await expect(page.getByRole('alert')).toContainText('Tu as refusé l’accès');
});
