// Génère des images de test : capture bancaire (plusieurs transactions + numéro de carte), reçu et image illisible.
import sharp from 'sharp';
import path from 'node:path';
import fs from 'node:fs';

const out = process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), 'generated');
fs.mkdirSync(out, { recursive: true });

const rows = [
  ['9 nov.', 'SHELL C12345 MONTREAL', '-72,30 $'],
  ['8 nov.', 'IGA EXTRA 8812', '-54,18 $'],
  ['7 nov.', 'CANVA PRO', '-16,99 $'],
];
const text = (x, y, s, extra = '') => `<text x="${x}" y="${y}" font-family="DejaVu Sans, Arial" font-size="28" word-spacing="6" ${extra}>${s}</text>`;
const bank = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="420"><rect width="100%" height="100%" fill="white"/>
${text(30, 50, 'Transactions récentes', 'font-weight="bold"')}
${rows.map((r, i) => text(30, 120 + i * 70, r[0]) + text(150, 120 + i * 70, r[1]) + text(770, 120 + i * 70, r[2], 'text-anchor="end"')).join('')}
${text(30, 360, 'Carte 4520 1234 5678 9012', 'fill="#555"')}</svg>`;
await sharp(Buffer.from(bank)).png().toFile(path.join(out, 'capture-bancaire.png'));

const blank = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="100%" height="100%" fill="#d8d8d8"/><circle cx="300" cy="200" r="120" fill="#bbb"/></svg>`;
await sharp(Buffer.from(blank)).png().toFile(path.join(out, 'illisible.png'));
console.log('Images générées dans', out);
