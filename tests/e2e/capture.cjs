// Captures d'écran de démonstration (node tests/e2e/capture.cjs <url> <dossier>)
const { chromium, devices } = require('playwright');
const fs = require('fs');
const sharp = require('sharp');
(async () => {
  const [base, dir] = process.argv.slice(2);
  const b = await chromium.launch(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
  const p = await (await b.newContext({ ...devices['Pixel 7'], timezoneId: 'America/Toronto', locale: 'fr-CA' })).newPage();
  await p.goto(base);
  await p.getByLabel('Prénom').fill('Justin');
  await p.getByLabel('Courriel').fill('demo@exemple.ca');
  await p.getByLabel(/Mot de passe/).fill('motdepasse-solide');
  await p.getByRole('button', { name: 'Créer le compte' }).click();
  await p.getByText('Mes 3 priorités').waitFor();
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${dir}/1-aujourdhui.png` });
  await p.locator('.bottom-nav').getByRole('link', { name: 'Agenda' }).click();
  await p.locator('[data-testid=block]').first().waitFor();
  await p.locator('.timeline-wrap').evaluate((e) => (e.scrollTop = 12 * 60));
  await p.screenshot({ path: `${dir}/2-agenda.png` });
  await p.getByRole('button', { name: 'Réorganiser' }).click();
  await p.getByText('Pauses à garder').waitFor();
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${dir}/3-reorganiser.png` });
  await p.getByRole('button', { name: 'Fermer' }).click();
  await p.locator('.bottom-nav').getByRole('link', { name: 'Budget' }).click();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="860" height="420"><rect width="100%" height="100%" fill="white"/><text x="30" y="50" font-family="DejaVu Sans" font-size="28" font-weight="bold">Transactions récentes</text>
  ${[['SHELL C12345 MONTREAL','-72,30 $'],['IGA EXTRA 8812','-54,18 $'],['CANVA PRO','-16,99 $']].map((r,i)=>`<text x="30" y="${120+i*70}" font-family="DejaVu Sans" font-size="28" word-spacing="6">Aujourd&#39;hui</text><text x="230" y="${120+i*70}" font-family="DejaVu Sans" font-size="28" word-spacing="6">${r[0]}</text><text x="830" y="${120+i*70}" font-family="DejaVu Sans" font-size="28" text-anchor="end">${r[1]}</text>`).join('')}
  <text x="30" y="360" font-family="DejaVu Sans" font-size="28" word-spacing="6" fill="#555">Carte 4520 1234 5678 9012</text></svg>`;
  await p.getByTestId('budget-file').setInputFiles({ name: 'capture.png', mimeType: 'image/png', buffer: await sharp(Buffer.from(svg)).png().toBuffer() });
  await p.getByTestId('draft-card').first().waitFor();
  await p.waitForTimeout(500);
  await p.screenshot({ path: `${dir}/4-import.png` });
  await p.getByRole('button', { name: 'Fermer' }).click();
  await p.locator('.bottom-nav').getByRole('link', { name: "Aujourd'hui" }).click();
  await p.getByTestId('add-expense').click();
  await p.getByLabel('Message au chatbot').fill('12 $ chez Tim Hortons ce matin et 45,60 $ chez Costco pour MONDAIX');
  await p.getByLabel('Message au chatbot').press('Enter');
  await p.getByText(/Dans quelle catégorie/).waitFor();
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${dir}/5-chatbot.png` });
  await b.close();
})();
