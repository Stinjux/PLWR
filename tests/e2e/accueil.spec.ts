import { test, expect } from '@playwright/test';

test('accueil : profil obligatoire, dépenses mensuelles, épargne, puis la cloche et ses tâches', async ({ page }) => {
  await page.goto('/');
  const toggle = page.getByRole('button', { name: 'Créer un compte' });
  if (await toggle.isVisible()) await toggle.click();
  await page.getByLabel('Prénom').fill('Léa');
  await page.getByLabel('Courriel').fill(`accueil${Date.now()}@exemple.ca`);
  await page.getByLabel(/Mot de passe/).fill('motdepasse-solide');
  await page.getByRole('checkbox').uncheck();
  await page.getByRole('button', { name: 'Créer le compte' }).click();

  // Étape 1 : rien n'avance tant que le profil n'est pas complet
  await expect(page.getByRole('heading', { name: 'Faisons connaissance' })).toBeVisible();
  await expect(page.getByLabel('Prénom')).toHaveValue('Léa');
  const next = page.getByRole('button', { name: 'Continuer' });
  await expect(next).toBeDisabled();
  await page.getByLabel('Âge').fill('29');
  await page.getByLabel('Profession').fill('Infirmière');
  await expect(next).toBeDisabled();
  await page.getByLabel('Salaire', { exact: true }).fill('2100');
  await page.getByRole('button', { name: 'Aux 2 sem.' }).click();
  await page.getByRole('button', { name: 'Net (sur ma paie)' }).click();
  await expect(page.getByTestId('salary-monthly')).toContainText('4 550,00');
  await next.click();

  // Étape 2 : dépenses fixes
  await expect(page.getByRole('heading', { name: 'Tes dépenses fixes chaque mois' })).toBeVisible();
  await page.getByRole('button', { name: 'Loyer ou hypothèque' }).click();
  await page.getByLabel('Montant par mois').fill('1250');
  await page.getByRole('button', { name: 'Ajouter cette dépense' }).click();
  await page.getByRole('button', { name: 'Cellulaire' }).click();
  await page.getByLabel('Montant par mois').fill('45');
  await page.getByLabel('Jour du paiement').selectOption('15');
  await page.getByRole('button', { name: 'Ajouter cette dépense' }).click();
  await expect(page.getByTestId('expenses-total')).toContainText('1 295,00');
  // On n'a pas tout : on finira plus tard
  await page.getByRole('button', { name: 'Je finirai plus tard' }).click();

  // Étape 3 : épargne, suggestion à partir du revenu
  await expect(page.getByRole('heading', { name: 'Ton objectif d’épargne' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Suggestion : .*460,00/ })).toBeVisible();
  await page.getByRole('button', { name: 'Plus tard' }).click();

  // Fin : les tâches qui attendent dans la cloche
  await expect(page.getByRole('heading', { name: 'Tout est prêt, Léa' })).toBeVisible();
  await expect(page.getByText('Synchroniser tes agendas')).toBeVisible();
  await expect(page.getByText('Terminer tes dépenses mensuelles')).toBeVisible();
  await page.getByRole('button', { name: 'Commencer' }).click();

  // La cloche en haut à droite : 3 tâches ouvertes, dans l'ordre demandé
  const bell = page.getByTestId('bell');
  await expect(bell).toHaveAccessibleName(/3 en attente/);
  await bell.click();
  const tasks = page.getByTestId('tasks');
  await expect(tasks.locator('[data-task]')).toHaveCount(3);
  await expect(tasks.locator('[data-task]').nth(0)).toContainText('Synchroniser tes agendas');
  await expect(tasks.locator('[data-task]').nth(1)).toContainText('2 ajoutée(s)');

  // Terminer les dépenses depuis la cloche
  await tasks.locator('[data-task=expenses]').getByRole('button', { name: 'Terminer' }).click();
  await page.getByRole('button', { name: 'Assurance habitation' }).click();
  await page.getByLabel('Montant par mois').fill('30');
  await page.getByRole('button', { name: 'Ajouter cette dépense' }).click();
  await page.getByRole('button', { name: 'C’est tout, j’ai terminé' }).click();
  await expect(page.getByText('1 sur 3 terminé')).toBeVisible();

  // Choisir l'objectif d'épargne depuis la cloche
  await tasks.locator('[data-task=savings]').getByRole('button', { name: 'Choisir' }).click();
  await page.getByLabel('Montant par mois').fill('300');
  await page.getByRole('button', { name: 'Créer mon objectif' }).click();
  await expect(page.getByText('2 sur 3 terminés')).toBeVisible();

  // Il reste la synchro des agendas, qui mène aux guides
  await tasks.locator('[data-task=sync]').getByRole('button', { name: 'Outlook' }).click();
  await expect(page).toHaveURL(/\/reglages\/outlook/);
  await expect(bell).toHaveAccessibleName(/1 en attente/);
});
