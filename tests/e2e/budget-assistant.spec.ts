import { test, expect } from '@playwright/test';
import { nav, signup } from './helpers';

test('budget : saisie en une phrase, modifier (crayon), supprimer (poubelle), ajuster une enveloppe', async ({ page }) => {
  await signup(page);
  await nav(page, 'Budget');
  await expect(page.getByTestId('budget-hero')).toContainText('Il te reste');

  // Saisie rapide → vérification → ajout
  await page.getByLabel('Ajouter une dépense').fill('18,40 $ dîner chez Subway');
  await page.getByRole('button', { name: 'Analyser' }).click();
  const review = page.getByTestId('quick-expense-review');
  await expect(review.getByLabel('Montant de la dépense')).toHaveValue('18,40');
  await review.getByLabel('Montant de la dépense').fill('19,40');
  await review.getByRole('button', { name: 'Ajouter la dépense' }).click();
  const row = page.locator('[data-testid=tx-row][data-merchant="Subway"]');
  await expect(row).toContainText('19,40');

  // Crayon : ouvre la modification
  await row.getByRole('button', { name: 'Modifier Subway' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Fermer' }).click();

  // Poubelle : confirmation dans la ligne, puis suppression
  await row.getByRole('button', { name: 'Supprimer Subway' }).click();
  await expect(row).toContainText('Supprimer Subway');
  await row.getByRole('button', { name: 'Supprimer', exact: true }).click();
  await expect(page.locator('[data-testid=tx-row][data-merchant="Subway"]')).toHaveCount(0);

  // Enveloppe : boutons −/+ et reste affiché
  await page.getByRole('button', { name: 'Enveloppes', exact: true }).click();
  await page.getByRole('button', { name: /Ajuster l’enveloppe .*Épicerie/ }).click();
  const amount = page.getByLabel('Montant prévu', { exact: true });
  const before = Number((await amount.inputValue()).replace(/\s/g, '').replace(',', '.'));
  await page.getByRole('button', { name: 'Ajouter 50 $' }).click();
  await expect(amount).toHaveValue(String(before + 50).replace('.', ',') + ',00');
  await expect(page.getByTestId('envelope-left')).toContainText('Il restera');
});

test('tableau de bord : ma journée, assistant (bilan et report à confirmer), événement récurrent', async ({ page }) => {
  await signup(page);
  await expect(page.getByTestId('today-tasks')).toBeVisible();
  const assistant = page.getByTestId('assistant');
  await assistant.getByRole('button', { name: 'Où j’en suis ?' }).click();
  await expect(assistant.locator('.bubble.assistant').last()).toContainText(/terminée|Aucune tâche|Rien n’est prévu/);

  // Une tâche à placer aujourd'hui, puis le report proposé par l'assistant
  await page.getByRole('button', { name: 'Tâche', exact: true }).click();
  await page.getByLabel('Titre').fill('Préparer la présentation');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByTestId('today-tasks')).toContainText('Préparer la présentation');
  await assistant.getByLabel('Message à l’assistant').fill('Reporte la présentation à demain');
  await assistant.getByRole('button', { name: 'Envoyer' }).click();
  const proposal = assistant.getByTestId('proposal').last();
  await expect(proposal).toContainText('Reporter « Préparer la présentation »');
  await expect(page.getByTestId('today-tasks')).toContainText('Préparer la présentation'); // rien n'a bougé
  await proposal.getByRole('button', { name: 'Appliquer' }).click();
  await expect(proposal).toContainText('Fait');
  await expect(page.getByTestId('today-tasks')).not.toContainText('Préparer la présentation');

  // Récurrence visible en un toucher
  await page.getByRole('button', { name: 'Événement', exact: true }).click();
  await page.getByLabel('Titre').fill('Cours de yoga');
  await page.getByRole('radiogroup', { name: 'Répétition' }).getByRole('radio', { name: 'Chaque semaine' }).click();
  await expect(page.getByTestId('recurrence-summary')).toContainText('Chaque semaine le');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByText('Événement ajouté')).toBeVisible();
});

test('assistant : bilan des objectifs enregistrés et progrès noté', async ({ page }) => {
  await signup(page);
  await page.evaluate(() =>
    fetch('/api/goals', { method: 'POST', headers: { 'x-plwr': '1', 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Lire 20 min par jour', metric: 'duration', target: 20, unit: 'min', period: 'daily' }) }),
  );
  await page.reload();
  const assistant = page.getByTestId('assistant');
  await assistant.getByRole('button', { name: 'Mes objectifs' }).click();
  await expect(assistant.locator('.bubble.assistant').last()).toContainText('Lire 20 min par jour : 0 min sur 20 min');
  await assistant.getByLabel('Message à l’assistant').fill('J’ai lu 25 min');
  await assistant.getByRole('button', { name: 'Envoyer' }).click();
  const proposal = assistant.getByTestId('proposal').last();
  await expect(proposal).toContainText('Noter un progrès : Lire 20 min par jour');
  await proposal.getByRole('button', { name: 'Appliquer' }).click();
  await expect(proposal).toContainText('Fait');
  await expect(page.getByTestId('today-goals')).toContainText('25 min / 20 min');
});
