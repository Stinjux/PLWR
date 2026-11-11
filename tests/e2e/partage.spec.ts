import { test, expect } from '@playwright/test';
import { nav, signup } from './helpers';

test('agenda partagé : inviter une personne, qui voit et ajoute dans mon agenda', async ({ page, browser }) => {
  // Camille crée son compte (avec exemples) et invite Léa à modifier son agenda
  await signup(page);
  await nav(page, 'Agenda');
  await page.getByRole('button', { name: 'Partager l’agenda' }).click();
  const sheet = page.getByRole('dialog', { name: 'Partager l’agenda' });
  const leaEmail = `lea${Date.now()}@exemple.ca`;
  await sheet.getByLabel('Courriel de la personne à inviter').fill(leaEmail);
  await sheet.getByRole('button', { name: 'Modifier', exact: true }).click();
  await sheet.getByRole('button', { name: 'Inviter', exact: true }).click();
  await expect(sheet.getByTestId('invite-ready')).toContainText(leaEmail);
  await expect(sheet.getByText('En attente · 1')).toBeVisible();
  const sharing = await page.evaluate(() => fetch('/api/sharing').then((r) => r.json()));
  const invitePath = new URL(sharing.invites[0].url).pathname;
  await sheet.getByRole('button', { name: 'Fermer' }).click();

  // Léa ouvre le lien : le courriel est prérempli, elle crée son compte et arrive dans l'agenda
  const lea = await browser.newPage();
  await lea.goto(invitePath);
  await expect(lea.getByRole('heading', { name: /Agenda de Test/ })).toBeVisible();
  await expect(lea.getByLabel('Courriel')).toHaveValue(leaEmail);
  await lea.getByLabel('Prénom').fill('Léa');
  await lea.getByLabel(/Mot de passe/).fill('motdepasse-solide');
  await lea.getByRole('button', { name: 'Créer le compte et rejoindre' }).click();
  await expect(lea).toHaveURL(/\/agenda/);
  const people = lea.getByRole('group', { name: 'Personnes affichées' });
  await expect(people.getByRole('button', { name: 'Test' })).toBeVisible();

  // Léa voit les rendez-vous de Camille (exemples) et peut ajouter dans son agenda
  await expect(lea.locator('[data-testid=block]').first()).toBeVisible();
  await lea.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await lea.getByRole('button', { name: 'Un événement' }).click();
  await lea.getByLabel('Agenda', { exact: true }).selectOption({ label: 'Agenda de Test' });
  await lea.getByLabel('Titre').fill('Souper ensemble');
  await lea.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(lea.getByText('Événement ajouté')).toBeVisible();

  // Masquer Camille cache ses éléments
  await people.getByRole('button', { name: 'Test' }).click();
  await expect(lea.locator('[data-testid=block][data-title="Souper ensemble"]')).toHaveCount(0);
  await people.getByRole('button', { name: 'Test' }).click();

  // Camille voit le nouvel élément dans son agenda et Léa dans ses membres
  await page.reload();
  await expect(page.locator('[data-testid=block][data-title="Souper ensemble"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Partager l’agenda' }).click();
  await expect(page.getByTestId('member')).toContainText('Léa');

  // Camille passe Léa en lecture seule : la fiche devient non modifiable
  await page.getByLabel('Accès de Léa').selectOption('view');
  await expect(page.getByText('Léa : Peut voir')).toBeVisible();
  await lea.reload();
  await lea.locator('[data-testid=block][data-title="Souper ensemble"]').click();
  await expect(lea.getByText(/Tu peux consulter cet élément/)).toBeVisible();
  await expect(lea.getByRole('button', { name: 'Enregistrer' })).toHaveCount(0);
});
