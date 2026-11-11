import { test, expect, type Page } from '@playwright/test';
import { DateTime } from 'luxon';
import { signup, bankScreenshot, blankImage, nav } from './helpers';

const TZ = 'America/Toronto';
const S = '\\s'; // espace insécable dans « 72,30 $ »

async function newTask(page: Page, title: string, startLocal: string, opts: { reminder?: string; goal?: string } = {}) {
  await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await page.getByRole('button', { name: 'Une tâche' }).click();
  await page.getByLabel('Titre', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'À une heure précise' }).click();
  await page.getByLabel('Début').fill(startLocal);
  await page.getByLabel('Durée').fill('60');
  if (opts.reminder) await page.getByRole('button', { name: opts.reminder, exact: true }).click();
  if (opts.goal) await page.getByRole('button', { name: `Lier à ${opts.goal}` }).click();
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByText('Tâche ajoutée')).toBeVisible();
}

async function openChat(page: Page) {
  await nav(page, "Aujourd'hui");
  await page.getByTestId('add-expense').click();
  // Le champ de saisie est prêt à l'emploi
  await expect(page.getByLabel('Message au chatbot')).toBeFocused();
}

async function say(page: Page, text: string) {
  await page.getByLabel('Message au chatbot').fill(text);
  await page.getByLabel('Message au chatbot').press('Enter');
}

test('1. Déplacer une tâche : son rappel suit le nouvel horaire', async ({ page }) => {
  await signup(page);
  const tomorrow = DateTime.now().setZone(TZ).plus({ days: 1 });
  await newTask(page, 'Révision rappel', `${tomorrow.toISODate()}T10:00`, { reminder: '10 min' });

  await nav(page, 'Agenda');
  await page.getByRole('button', { name: 'Jour', exact: true }).click();
  await page.getByRole('button', { name: 'Suivant' }).click();
  const block = page.locator('[data-testid=block][data-title="Révision rappel"]');
  await block.scrollIntoViewIfNeeded();
  await block.click();
  await expect(page.getByTestId('next-reminder')).toContainText('09h50');
  await page.getByRole('button', { name: 'Fermer' }).click();

  // Glisser la poignée d'une heure vers le bas (1 px = 1 min)
  const grip = block.getByTestId('grip');
  const box = (await grip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 40, { steps: 5 });
  await page.mouse.move(box.x + box.width / 2, box.y + 70, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByText(/Déplacé : 11h00–12h00 · rappel à 10h50/)).toBeVisible();

  await block.click();
  await expect(page.getByTestId('next-reminder')).toContainText('10h50');
  await page.getByRole('button', { name: 'Fermer' }).click();

  // La liste des rappels à venir reflète le nouvel horaire (et plus l'ancien)
  await page.goto('/reglages');
  const upcoming = page.getByTestId('upcoming-reminders');
  await expect(upcoming.locator('li', { hasText: 'Révision rappel' })).toContainText('10h50');
  await expect(upcoming.locator('li', { hasText: 'Révision rappel' })).toHaveCount(1);
});

test('2. Enregistrer un résultat : l’objectif associé progresse', async ({ page }) => {
  await signup(page);
  const today = DateTime.now().setZone(TZ).toISODate();
  await newTask(page, 'Étude CFA test', `${today}T06:00`, { goal: 'Étudier 6 h pour le CFA' });

  await nav(page, "Aujourd'hui");
  await page.getByTestId('today-tasks').getByText('Étude CFA test').click();
  await page.getByRole('button', { name: 'Terminer et saisir le résultat' }).click();
  await expect(page.getByText('sur 60 min prévues')).toBeVisible();
  await page.getByLabel('Résultat pour Étudier 6 h pour le CFA').fill('45');
  await page.getByRole('button', { name: 'Enregistrer le résultat' }).click();
  await expect(page.getByText(/45 min sur 6 h · reste 5 h 15/)).toBeVisible();

  await nav(page, 'Objectifs');
  const card = page.locator('[data-testid=goal-card][data-title="Étudier 6 h pour le CFA"]');
  await expect(card.getByTestId('goal-progress')).toContainText('45 min / 6 h');
  await card.click();
  await expect(page.getByTestId('goal-done')).toHaveText('45 min');
  await expect(page.getByTestId('goal-remaining')).toHaveText('5 h 15');
  await expect(page.getByTestId('goal-entries')).toContainText('45 min sur 1 h prévus');
});

test('3. Dépense en une phrase, puis deux dépenses dans le même message', async ({ page }) => {
  await signup(page);
  await openChat(page);
  await say(page, 'J’ai mis 72,30 $ d’essence hier chez Shell');
  const card = page.getByTestId('draft-card').last();
  await expect(card.getByTestId('draft-summary')).toHaveText(new RegExp(`72,30${S}\\$ CAD · Shell · Transport / Essence · Hier · Personnel`));
  await card.getByRole('button', { name: 'Confirmer' }).click();
  await expect(card).toContainText(new RegExp(`Il reste 107,70${S}\\$ dans Transport / Essence`));

  await say(page, '12 $ chez Tim Hortons ce matin et 45,60 $ chez Costco pour MONDAIX');
  await expect(page.getByText('J’ai trouvé 2 dépenses.')).toBeVisible();
  // Catégorie inconnue dans le budget MONDAIX : une seule question ciblée
  await expect(page.getByText(/Dans quelle catégorie dois-je classer 45,60.*Costco/)).toBeVisible();
  await page.getByRole('button', { name: 'Produits / Inventaire' }).click();
  const pending = page.locator('[data-testid=draft-card].pending');
  await expect(pending).toHaveCount(2);
  await expect(pending.nth(0)).toContainText('Tim Hortons');
  await expect(pending.nth(1)).toContainText(/Costco · Produits \/ Inventaire · Aujourd'hui · MONDAIX/);
  await page.getByRole('button', { name: 'Tout confirmer (2)' }).click();
  await expect(page.locator('[data-testid=draft-card].confirmed')).toHaveCount(3);
});

test('4. Dépense sans montant : le chatbot demande le montant', async ({ page }) => {
  await signup(page);
  await openChat(page);
  await say(page, 'J’ai fait le plein chez Esso ce matin');
  await expect(page.getByTestId('msg-assistant').last()).toHaveText('Quel est le montant payé chez Esso ?');
  const card = page.getByTestId('draft-card').last();
  await expect(card.getByRole('button', { name: 'Confirmer' })).toBeDisabled();
  await say(page, '58,10');
  const ready = page.getByTestId('draft-card').last();
  await expect(ready.getByTestId('draft-summary')).toHaveText(new RegExp(`58,10${S}\\$ CAD · Esso · Transport / Essence · Aujourd'hui · Personnel`));
  await expect(ready.getByRole('button', { name: 'Confirmer' })).toBeEnabled();
});

test('5 et 6. Import d’une capture : correction, seules les lignes confirmées entrent ; réimport et double confirmation sans doublon', async ({ page }) => {
  await signup(page);
  const img = await bankScreenshot();
  await nav(page, 'Budget');
  await page.getByTestId('budget-file').setInputFiles({ name: 'capture.png', mimeType: 'image/png', buffer: img });
  await expect(page.getByRole('dialog', { name: 'Vérifier l’import' })).toBeVisible();
  await expect(page.getByText(/1 numéro\(s\) de carte masqué\(s\)/)).toBeVisible();
  const cards = page.getByTestId('draft-card');
  await expect(cards).toHaveCount(3);

  // Corriger la ligne IGA (montant) et retirer la ligne Canva
  const iga = cards.filter({ hasText: 'IGA' });
  await iga.getByRole('button', { name: 'Modifier' }).click();
  await iga.getByLabel('Montant').fill('60,00');
  await iga.getByRole('button', { name: 'Enregistrer les modifications' }).click();
  await expect(iga.getByTestId('draft-summary')).toContainText(new RegExp(`60,00${S}\\$ CAD`));
  await cards.filter({ hasText: 'CANVA' }).getByRole('button', { name: 'Retirer' }).click();
  await expect(cards.filter({ hasText: 'CANVA' })).toContainText('Retirée');
  await page.getByTestId('confirm-selected').click();
  await expect(page.getByText('2 ligne(s) confirmée(s)')).toBeVisible();
  await page.getByRole('button', { name: 'Fermer' }).click();

  await page.getByRole('button', { name: 'Transactions' }).click();
  const txs = page.getByTestId('tx-row');
  await expect(txs.filter({ hasText: 'SHELL' })).toHaveCount(1);
  await expect(txs.filter({ hasText: 'IGA EXTRA' })).toContainText(new RegExp(`60,00${S}\\$`));
  await expect(txs.filter({ hasText: 'CANVA' })).toHaveCount(0);

  // 6a. Réimporter la même image : signalée, rien n'est présélectionné
  await page.getByTestId('budget-file').setInputFiles({ name: 'capture-encore.png', mimeType: 'image/png', buffer: img });
  await expect(page.getByText(/Cette image a déjà été importée/).first()).toBeVisible();
  await expect(page.getByTestId('confirm-selected')).toHaveText('Confirmer la sélection (0)');
  await expect(page.getByTestId('confirm-selected')).toBeDisabled();
  const shell = page.getByTestId('draft-card').filter({ hasText: 'SHELL' });
  await expect(shell.getByTestId('duplicate-warning')).toBeVisible();
  await shell.getByRole('button', { name: 'Confirmer' }).click();
  await expect(page.getByText('Cette dépense ressemble à')).toBeVisible();
  await page.getByRole('button', { name: 'Ne pas enregistrer' }).click();
  await page.getByRole('button', { name: 'Fermer' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Transactions' }).click();
  await expect(page.getByTestId('tx-row').filter({ hasText: 'SHELL' })).toHaveCount(1);

  // 6b. Double pression sur Confirmer dans le chatbot : une seule transaction
  await openChat(page);
  await say(page, '18,75 $ chez Subway');
  const card = page.getByTestId('draft-card').last();
  await card.getByRole('button', { name: 'Confirmer' }).dblclick();
  await expect(card).toContainText('Confirmée');
  // Et deux requêtes simultanées sur une même fiche (réseau lent, deux appareils)
  await say(page, '9,99 $ chez Pizza Pizza');
  const pizza = page.getByTestId('draft-card').filter({ hasText: 'Pizza Pizza' });
  await expect(pizza).toBeVisible();
  const draftId = await pizza.getAttribute('data-draft-id');
  const ids = await page.evaluate(async (id) => {
    const call = () => fetch(`/api/drafts/${id}/confirm`, { method: 'POST', headers: { 'x-plwr': '1', 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json());
    const [a, b] = await Promise.all([call(), call()]);
    return [a.transactionId, b.transactionId];
  }, draftId);
  expect(ids[0]).toBeTruthy();
  expect(ids[0]).toBe(ids[1]);
  await page.getByRole('button', { name: 'Fermer' }).click();
  await nav(page, 'Budget');
  await page.getByRole('button', { name: 'Transactions' }).click();
  await expect(page.getByTestId('tx-row').filter({ hasText: 'Subway' })).toHaveCount(1);
  await expect(page.getByTestId('tx-row').filter({ hasText: 'Pizza Pizza' })).toHaveCount(1);
});

test('7. Erreur de lecture simulée : la saisie manuelle permet de terminer', async ({ page }) => {
  await signup(page);
  await page.goto('/reglages');
  await page.getByTestId('simulate-error').check();
  await nav(page, 'Budget');
  await page.getByTestId('budget-file').setInputFiles({ name: 'recu.png', mimeType: 'image/png', buffer: await bankScreenshot() });
  await expect(page.getByTestId('import-error')).toContainText('Erreur simulée du fournisseur de lecture');
  const form = page.getByTestId('manual-form');
  await form.getByLabel('Montant').fill('23,45');
  await form.getByLabel('Commerçant').fill('Pharmaprix');
  await form.getByRole('button', { name: 'Créer la fiche' }).click();
  const card = page.getByTestId('draft-card').filter({ hasText: 'Pharmaprix' });
  await expect(card).toContainText('Santé / Santé et pharmacie');
  await card.getByRole('button', { name: 'Confirmer' }).click();
  await expect(card).toContainText('Confirmée');
  await page.getByRole('button', { name: 'Fermer' }).click();
  await page.getByRole('button', { name: 'Transactions' }).click();
  await expect(page.getByTestId('tx-row').filter({ hasText: 'Pharmaprix' })).toHaveCount(1);

  // Image illisible envoyée dans le chatbot (sans simulation) : saisie manuelle proposée
  await page.goto('/reglages');
  await page.getByTestId('simulate-error').uncheck();
  await openChat(page);
  await page.getByTestId('chat-file').setInputFiles({ name: 'flou.png', mimeType: 'image/png', buffer: await blankImage() });
  await expect(page.getByText(/Je n’ai pas pu lire cette image/)).toBeVisible();
  await page.getByRole('button', { name: 'Saisir manuellement' }).click();
  await expect(page.getByTestId('manual-form')).toBeVisible();
});

test('Exemple : une rencontre se prolonge de 45 min, le bloc CFA et la gym sont replacés, les fixes restent', async ({ page }) => {
  await signup(page);
  const d = DateTime.now().setZone(TZ).plus({ days: 1 }).toISODate();
  const at = (hhmm: string) => DateTime.fromISO(`${d}T${hhmm}`, { zone: TZ }).toUTC().toISO();
  await page.evaluate(async (items) => {
    for (const it of items) await fetch('/api/events', { method: 'POST', headers: { 'x-plwr': '1', 'content-type': 'application/json' }, body: JSON.stringify(it) });
  }, [
    { title: 'Rencontre test', kind: 'fixed', start: at('13:00'), durationMin: 60 },
    { title: 'Bloc CFA test', kind: 'flexible', start: at('14:15'), durationMin: 60, priority: 1, preferredWindow: 'apres-midi', reminders: [5] },
    { title: 'Appel test', kind: 'fixed', start: at('15:30'), durationMin: 30 },
    { title: 'Gym test', kind: 'flexible', start: at('16:00'), durationMin: 60, preferredWindow: '16:00-21:00' },
  ]);
  await nav(page, 'Agenda');
  await page.getByRole('button', { name: 'Suivant' }).click();
  await page.locator('[data-testid=block][data-title="Rencontre test"]').click();
  await page.getByRole('button', { name: '+45' }).click();
  const changes = page.getByTestId('plan-changes');
  await expect(changes).toContainText('Bloc CFA test');
  await expect(changes).toContainText('Gym test');
  await expect(changes).not.toContainText('Rencontre test');
  await expect(changes).not.toContainText('Appel test');
  await page.getByTestId('apply-plan').click();
  await expect(page.getByText('Nouvel horaire appliqué · rappels mis à jour')).toBeVisible();
  const startOf = (t: string) => page.locator(`[data-testid=block][data-title="${t}"]`).getAttribute('data-start');
  await expect(page.locator('[data-testid=block][data-title="Bloc CFA test"]')).not.toHaveAttribute('data-start', at('14:15')!);
  expect(await startOf('Rencontre test')).toBe(at('13:00'));
  expect(await startOf('Appel test')).toBe(at('15:30'));
  // Aucun chevauchement avec la rencontre prolongée (13 h–14 h 45) ni l'appel (15 h 30–16 h)
  for (const t of ['Bloc CFA test', 'Gym test']) {
    const s = (await startOf(t))!;
    const e = DateTime.fromISO(s).plus({ minutes: 60 }).toUTC().toISO()!;
    for (const [fs, fe] of [[at('13:00')!, at('14:45')!], [at('15:30')!, at('16:00')!]]) expect(e <= fs || s >= fe, `${t} chevauche un rendez-vous fixe`).toBeTruthy();
  }
});

test('Rappel envoyé par le serveur à l’heure prévue, puis « Reporter »', async ({ page }) => {
  test.setTimeout(150_000);
  await signup(page);
  await page.evaluate(() => fetch('/api/me/settings', { method: 'PATCH', headers: { 'x-plwr': '1', 'content-type': 'application/json' }, body: JSON.stringify({ quietHours: { enabled: false } }) }));
  // Rendez-vous dans 2 minutes, rappel 1 minute avant
  const start = DateTime.now().plus({ minutes: 2 }).startOf('minute').toUTC().toISO();
  await page.evaluate((s) => fetch('/api/events', { method: 'POST', headers: { 'x-plwr': '1', 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Appel imminent', kind: 'fixed', start: s, durationMin: 15, reminders: [1] }) }), start);
  await expect
    .poll(async () => (await page.evaluate(() => fetch('/api/notifications').then((r) => r.json()))).map((n: any) => n.title), { timeout: 120_000, intervals: [3000] })
    .toContain('📅 Appel imminent');
  await page.goto('/reglages');
  await page.getByRole('link', { name: 'Reporter' }).first().click();
  await page.getByRole('button', { name: '10 min' }).click();
  await expect(page.getByText(/Rappel reporté à/)).toBeVisible();
});

test('Agenda : cliquer-glisser une plage (comme Outlook) et régler la récurrence', async ({ page }) => {
  await signup(page);
  await nav(page, 'Agenda');
  // Vue jour, demain : glisser de 7 h à 8 h 30
  await page.getByRole('button', { name: 'Jour', exact: true }).click();
  await page.getByRole('button', { name: 'Suivant' }).click();
  const tomorrow = DateTime.now().setZone(TZ).plus({ days: 1 });
  const col = page.getByTestId(`col-${tomorrow.toISODate()}`);
  await page.locator('.timeline-wrap').evaluate((e) => (e.scrollTop = 6 * 60));
  const box = (await col.boundingBox())!;
  const yAt = (min: number) => box.y + min; // 1 px = 1 min, haut de colonne = minuit
  await page.mouse.move(box.x + box.width / 2, yAt(7 * 60 + 2));
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, yAt(8 * 60), { steps: 4 });
  await page.mouse.move(box.x + box.width / 2, yAt(8 * 60 + 30), { steps: 4 });
  await expect(page.getByTestId('selection')).toContainText('07h00–08h30');
  await page.mouse.up();
  await expect(page.getByRole('spinbutton', { name: 'Durée' })).toHaveValue('90');
  await expect(page.getByTestId('computed-end')).toHaveText('Fin : 08h30');
  await page.getByLabel('Titre', { exact: true }).fill('Lecture du matin');
  // Récurrence mensuelle « le Ne jour » puis tous les 2 jours, 5 fois
  await page.getByLabel('Répétition').selectOption('monthly');
  await page.getByRole('button', { name: /^Le (1er|2e|3e|4e|dernier) / }).click();
  await expect(page.getByTestId('recurrence-summary')).toContainText(/Chaque mois le (1er|2e|3e|4e|dernier) \w+ à 07h00/);
  await page.getByLabel('Répétition').selectOption('daily');
  await page.getByLabel('Intervalle').fill('2');
  await page.getByRole('button', { name: 'Après…' }).click();
  await page.getByLabel('Nombre d’occurrences').fill('5');
  await expect(page.getByTestId('recurrence-summary')).toHaveText('Tous les 2 jours à 07h00, 5 fois');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.locator('[data-testid=block][data-title="Lecture du matin"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Suivant' }).click();
  await expect(page.locator('[data-testid=block][data-title="Lecture du matin"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Suivant' }).click();
  await expect(page.locator('[data-testid=block][data-title="Lecture du matin"]')).toHaveCount(1);

  // Vue semaine (semaine prochaine) : glisser du lundi au mercredi de 6 h à 7 h → hebdomadaire sur ces 3 jours
  await page.getByRole('button', { name: 'Semaine', exact: true }).click();
  await page.getByRole('button', { name: 'Suivant' }).click();
  const shownMonday = await page.getByTestId(/^col-/).first().getAttribute('data-testid');
  const mon = page.getByTestId(shownMonday!);
  const wed = page.getByTestId(`col-${DateTime.fromISO(shownMonday!.slice(4)).plus({ days: 2 }).toISODate()}`);
  await page.locator('.timeline-wrap').evaluate((e) => (e.scrollTop = 5 * 60));
  const b1 = (await mon.boundingBox())!, b3 = (await wed.boundingBox())!;
  await page.mouse.move(b1.x + b1.width / 2, b1.y + 6 * 60 + 2);
  await page.mouse.down();
  await page.mouse.move(b3.x + b3.width / 2, b3.y + 6 * 60 + 30, { steps: 5 });
  await page.mouse.move(b3.x + b3.width / 2, b3.y + 7 * 60, { steps: 5 });
  await expect(page.getByTestId('selection')).toHaveCount(3);
  await page.mouse.up();
  await expect(page.getByTestId('recurrence-summary')).toHaveText('Chaque semaine le lundi, mardi, mercredi à 06h00');
  await page.getByLabel('Titre', { exact: true }).fill('Course matinale');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.locator('[data-testid=block][data-title="Course matinale"]')).toHaveCount(3);
});
