import { test, expect, type Page } from '@playwright/test';
import { fillProfile } from './helpers';

async function newAccount(page: Page, name = 'Léa') {
  await page.goto('/');
  const toggle = page.getByRole('button', { name: 'Créer un compte' });
  await expect(toggle.or(page.getByLabel('Prénom'))).toBeVisible();
  if (await toggle.isVisible()) await toggle.click();
  await page.getByLabel('Prénom').fill(name);
  await page.getByLabel('Courriel').fill(`accueil${Date.now()}${Math.round(Math.random() * 1e6)}@exemple.ca`);
  await page.getByLabel(/Mot de passe/).fill('motdepasse-solide');
  await page.getByRole('checkbox').uncheck();
  await page.getByRole('button', { name: 'Créer le compte' }).click();
  await expect(page.getByRole('heading', { name: 'Qu’est-ce que tu veux organiser en premier ?' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Explorer l’app' })).toBeVisible();
}

test('accueil « Gérer mes dépenses » : phrase, montant et catégorie proposés, correction, puis tableau de bord', async ({ page }) => {
  await newAccount(page);
  const next = page.getByRole('button', { name: 'Continuer' });
  await expect(next).toBeDisabled();
  await page.getByRole('radio', { name: /Gérer mes dépenses/ }).click();
  await next.click();

  await page.getByLabel('Ta dépense').fill('12,50 $ café ce matin chez Tim Hortons');
  await page.getByRole('button', { name: 'Analyser' }).click();
  const result = page.getByTestId('expense-result');
  await expect(result.getByLabel('Montant')).toHaveValue('12,50');
  await expect(result.getByLabel('Catégorie')).toHaveValue(/.+/);
  await expect(result.getByLabel('Catégorie').locator('option:checked')).toHaveText(/Restaurants et cafés/);
  await result.getByLabel('Montant').fill('13,75'); // correction
  await page.getByRole('button', { name: 'Confirmer la dépense' }).click();

  // Profil obligatoire : Terminer reste grisé tant qu'il manque une réponse
  await expect(page.getByTestId('first-action-done')).toContainText('Tim Hortons · 13,75');
  await expect(page.getByRole('button', { name: 'Terminer' })).toBeDisabled();
  await page.getByRole('combobox', { name: 'Profession' }).fill('infirm');
  await expect(page.getByRole('option')).toHaveCount(3); // 2 professions + « Autre »
  await page.getByRole('combobox', { name: 'Profession' }).fill('');
  await fillProfile(page, { age: '29', search: 'infirm', profession: 'Infirmier·ère', salary: '72000' });

  // Tableau de bord : bienvenue, résultat visible, prochaine action qui en découle
  const welcome = page.getByTestId('welcome');
  await expect(welcome.getByRole('heading', { name: 'Bienvenue, Léa.' })).toBeVisible();
  await expect(welcome.getByTestId('welcome-result')).toContainText('Dépense enregistrée : Tim Hortons · 13,75');
  await welcome.getByRole('button', { name: 'Voir mes dépenses de la semaine' }).click();
  await expect(page).toHaveURL(/\/budget\?tab=transactions/);
  await expect(page.getByText('Tim Hortons').first()).toBeVisible();
});

test('accueil « Suivre un objectif » : texte libre défini automatiquement, première étape planifiée, rappel', async ({ page }) => {
  await newAccount(page, 'Sam');
  await page.getByRole('radio', { name: /Suivre un objectif/ }).click();
  await page.getByRole('button', { name: 'Continuer' }).click();
  await page.getByRole('button', { name: 'Courir 3 fois par semaine' }).click();
  await page.getByRole('button', { name: 'Définir mon objectif' }).click();
  const goal = page.getByTestId('goal-result');
  await expect(goal.getByLabel('Titre de l’objectif')).toHaveValue('Courir 3 fois par semaine');
  await expect(goal).toContainText('3 fois · par semaine');
  await page.getByRole('group', { name: 'Jour' }).getByRole('button', { name: 'Demain' }).click();
  await page.getByLabel('Heure').selectOption('18:00');
  await page.getByRole('button', { name: 'Planifier la première étape' }).click();
  await fillProfile(page);

  const welcome = page.getByTestId('welcome');
  await expect(welcome.getByTestId('welcome-result')).toContainText(/Première étape : .* · demain à 18 h/);
  // La permission des notifications n'est demandée qu'ici ; sans clés VAPID, le rappel va dans la cloche
  await welcome.getByRole('button', { name: 'Me rappeler la première étape' }).click();
  await expect(welcome.getByRole('status')).toContainText('Rappel programmé');
  await welcome.getByRole('button', { name: 'J’ai compris' }).click();
  await expect(page.getByTestId('welcome')).toHaveCount(0);
});

test('accueil « Planifier ma semaine » : un événement, visible tout de suite, en 3 écrans', async ({ page }) => {
  await newAccount(page, 'Noé');
  await expect(page.getByLabel('Écran 1 sur 3')).toBeVisible();
  await page.getByRole('radio', { name: /Planifier ma semaine/ }).click();
  await page.getByRole('button', { name: 'Continuer' }).click();
  await expect(page.getByLabel('Écran 2 sur 3')).toBeVisible();
  await page.getByLabel('Quoi ?').fill('Dentiste');
  await page.getByRole('group', { name: 'Jour' }).getByRole('button', { name: 'Aujourd’hui' }).click();
  await page.getByLabel('Heure').selectOption('21:30');
  await page.getByRole('button', { name: 'Ajouter à mon agenda' }).click();
  await expect(page.getByLabel('Écran 3 sur 3')).toBeVisible();
  await fillProfile(page);
  await expect(page.getByTestId('welcome-result')).toContainText('Ajouté à ton agenda : Dentiste · aujourd’hui à 21 h 30');
  await page.getByTestId('welcome').getByRole('button', { name: 'Voir ma semaine' }).click();
  await expect(page.locator('[data-testid=block][data-title="Dentiste"]')).toHaveCount(1);
});
