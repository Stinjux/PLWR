import { test, expect } from '@playwright/test';
import { signup } from './helpers';

test('Outlook : guide pas à pas, import des variables et écran de consentement Microsoft', async ({ page }) => {
  await signup(page);
  await page.goto('/reglages');
  await page.getByRole('button', { name: 'Connecter Outlook (guide pas à pas)' }).click();
  await expect(page).toHaveURL(/\/reglages\/outlook/);
  await expect(page.getByRole('heading', { name: 'Outlook', level: 1 })).toBeVisible();
  for (const n of [1, 2, 3, 4, 5, 6, 7]) await expect(page.getByRole('region', { name: new RegExp(`^Étape ${n} :`) })).toBeVisible();
  const redirect = await page.getByTestId('redirect-uri').textContent();
  expect(redirect).toMatch(/\/api\/outlook\/callback$/);

  // Erreur fréquente : coller l'« ID du secret » au lieu de la « Valeur »
  await page.getByLabel('ID d’application (client)').fill('1a2b3c4d-1111-2222-3333-444455556666');
  await page.getByLabel('Valeur du secret client').fill('9f8e7d6c-1111-2222-3333-444455556666');
  await page.getByRole('button', { name: 'Importer mes identifiants' }).click();
  await expect(page.getByText(/copie plutôt la colonne « Valeur »/)).toBeVisible();
  await page.getByLabel('Valeur du secret client').fill('Abc8Q~valeur-du-secret-de-test');
  await page.getByRole('button', { name: 'Importer mes identifiants' }).click();
  await expect(page.getByTestId('credentials-ok')).toContainText('annuaire common');
  await expect(page.getByTestId('outlook-status')).toContainText('Prêt à connecter');

  // « Connecter » ouvre la connexion et le consentement Microsoft avec le bon client
  const outgoing = page.waitForRequest((r) => r.url().startsWith('https://login.microsoftonline.com/'));
  await page.getByTestId('outlook-status').getByRole('button', { name: 'Connecter Outlook' }).click();
  const consent = new URL((await outgoing).url());
  expect(consent.pathname).toBe('/common/oauth2/v2.0/authorize');
  expect(consent.searchParams.get('client_id')).toBe('1a2b3c4d-1111-2222-3333-444455556666');
  expect(consent.searchParams.get('redirect_uri')).toBe(redirect);
  expect(consent.searchParams.get('scope')).toContain('Calendars.ReadWrite');
  expect(consent.searchParams.get('scope')).toContain('offline_access');

  await page.goto('/api/outlook/callback?error=access_denied');
  await expect(page.getByRole('alert')).toContainText('Tu as refusé l’accès');
});
