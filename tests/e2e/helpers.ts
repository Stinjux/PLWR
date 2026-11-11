import { expect, type Page } from '@playwright/test';
import sharp from 'sharp';

let n = 0;
/** Crée un compte neuf (avec exemples) pour isoler chaque parcours. */
export async function signup(page: Page) {
  await page.goto('/');
  const email = `test${Date.now()}${n++}@exemple.ca`;
  const submit = page.getByRole('button', { name: 'Créer le compte' });
  const toggle = page.getByRole('button', { name: 'Créer un compte' });
  await expect(submit.or(toggle)).toBeVisible();
  if (await toggle.isVisible()) await toggle.click();
  await page.getByLabel('Prénom').fill('Test');
  await page.getByLabel('Courriel').fill(email);
  await page.getByLabel(/Mot de passe/).fill('motdepasse-solide');
  await page.getByRole('button', { name: 'Créer le compte' }).click();
  await finishOnboarding(page);
  await expect(page.getByText('Mes 3 priorités')).toBeVisible();
  return email;
}

/** Accueil : profil obligatoire, puis dépenses et épargne remises à plus tard. */
export async function finishOnboarding(page: Page) {
  await expect(page.getByRole('heading', { name: 'Faisons connaissance' })).toBeVisible();
  await page.getByLabel('Âge').fill('34');
  await page.getByLabel('Profession').fill('Analyste');
  await page.getByLabel('Salaire', { exact: true }).fill('62000');
  await page.getByRole('button', { name: 'Continuer' }).click();
  await page.getByRole('button', { name: 'Je finirai plus tard' }).click();
  await page.getByRole('button', { name: 'Plus tard' }).click();
  await page.getByRole('button', { name: 'Commencer' }).click();
}

/** Capture bancaire synthétique : trois transactions d'aujourd'hui + un numéro de carte visible. */
export async function bankScreenshot(): Promise<Buffer> {
  const rows = [
    ["Aujourd'hui", 'SHELL C12345 MONTREAL', '-72,30 $'],
    ["Aujourd'hui", 'IGA EXTRA 8812', '-54,18 $'],
    ["Aujourd'hui", 'CANVA PRO', '-16,99 $'],
  ];
  const t = (x: number, y: number, s: string, extra = '') => `<text x="${x}" y="${y}" font-family="DejaVu Sans, Arial" font-size="28" word-spacing="6" ${extra}>${s}</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="860" height="420"><rect width="100%" height="100%" fill="white"/>
  ${t(30, 50, 'Transactions récentes', 'font-weight="bold"')}
  ${rows.map((r, i) => t(30, 120 + i * 70, r[0]) + t(230, 120 + i * 70, r[1]) + t(830, 120 + i * 70, r[2], 'text-anchor="end"')).join('')}
  ${t(30, 360, 'Carte 4520 1234 5678 9012', 'fill="#555"')}</svg>`;
  return sharp(Buffer.from(svg.replace(/'/g, '&#39;'))).png().toBuffer();
}

export async function blankImage(): Promise<Buffer> {
  return sharp({ create: { width: 500, height: 400, channels: 3, background: '#cccccc' } }).png().toBuffer();
}

export const nav = (page: Page, name: string) => page.locator('.bottom-nav').getByRole('link', { name }).click();
