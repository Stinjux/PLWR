import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import Tesseract from 'tesseract.js';
import { config } from '../config.ts';
import type { OcrLine, OcrResult, OcrWord } from './types.ts';

const require = createRequire(import.meta.url);
let workerPromise: Promise<Tesseract.Worker> | null = null;

/** Prépare un dossier tessdata local (aucun téléchargement au moment de l'exécution). */
function langDir(): string {
  const dir = path.join(config.dataDir, 'tessdata');
  fs.mkdirSync(dir, { recursive: true });
  for (const lang of ['fra', 'eng']) {
    const target = path.join(dir, `${lang}.traineddata.gz`);
    if (!fs.existsSync(target)) {
      const pkg = require(`@tesseract.js-data/${lang}`);
      fs.copyFileSync(path.join(pkg.langPath, `${lang}.traineddata.gz`), target);
    }
  }
  return dir;
}

async function worker() {
  if (!workerPromise) {
    const dir = langDir();
    workerPromise = Tesseract.createWorker(['fra', 'eng'], 1, { langPath: dir, cachePath: dir, gzip: true }).catch((e) => {
      workerPromise = null;
      throw e;
    });
  }
  return workerPromise;
}

/** OCR local (Tesseract) : sert au masquage des numéros de carte et au fournisseur « local ». */
export async function runOcr(image: Buffer): Promise<OcrResult> {
  const w = await worker();
  // Agrandit les petites captures pour améliorer la lecture
  const meta = await sharp(image).metadata();
  const scale = meta.width && meta.width < 1000 ? 2 : 1;
  const input = scale > 1 ? await sharp(image).resize({ width: meta.width! * scale }).toBuffer() : image;
  const r = await w.recognize(input, {}, { blocks: true, text: true });
  const lines: OcrLine[] = [];
  for (const b of r.data.blocks || [])
    for (const p of b.paragraphs)
      for (const l of p.lines) {
        const words: OcrWord[] = l.words.map((wd) => ({
          text: wd.text,
          confidence: wd.confidence,
          bbox: { x0: wd.bbox.x0 / scale, y0: wd.bbox.y0 / scale, x1: wd.bbox.x1 / scale, y1: wd.bbox.y1 / scale },
        }));
        lines.push({ text: words.map((w) => w.text).join(' ').trim() || l.text.trim(), confidence: l.confidence, words });
      }
  return { text: r.data.text, lines, confidence: r.data.confidence };
}

/** Repère les numéros de carte visibles (13 à 19 chiffres, groupés ou non) et renvoie les zones à masquer. */
export function findCardNumberBoxes(ocr: OcrResult): OcrWord['bbox'][] {
  const boxes: OcrWord['bbox'][] = [];
  for (const line of ocr.lines) {
    const ws = line.words;
    for (let i = 0; i < ws.length; i++) {
      let digits = '';
      let j = i;
      const group: OcrWord[] = [];
      while (j < ws.length && /^[\d*xX•·-]{2,}$/.test(ws[j].text.replace(/[-–]/g, ''))) {
        digits += ws[j].text.replace(/[^\d]/g, '');
        group.push(ws[j]);
        j++;
        if (digits.length >= 13) break;
      }
      const single = ws[i].text.replace(/[\s-]/g, '');
      if ((digits.length >= 13 && digits.length <= 19 && group.length >= 1) || /^\d{13,19}$/.test(single)) {
        const g = group.length ? group : [ws[i]];
        boxes.push({
          x0: Math.min(...g.map((w) => w.bbox.x0)) - 4,
          y0: Math.min(...g.map((w) => w.bbox.y0)) - 4,
          x1: Math.max(...g.map((w) => w.bbox.x1)) + 4,
          y1: Math.max(...g.map((w) => w.bbox.y1)) + 4,
        });
        i = j - 1;
      }
    }
  }
  return boxes;
}

export async function redactBoxes(image: Buffer, boxes: OcrWord['bbox'][]): Promise<Buffer> {
  if (!boxes.length) return image;
  const meta = await sharp(image).metadata();
  const W = meta.width!, H = meta.height!;
  const rects = boxes
    .map((b) => ({ x: Math.max(0, Math.floor(b.x0)), y: Math.max(0, Math.floor(b.y0)), w: Math.ceil(b.x1 - b.x0), h: Math.ceil(b.y1 - b.y0) }))
    .map((r) => `<rect x="${r.x}" y="${r.y}" width="${Math.min(r.w, W - r.x)}" height="${Math.min(r.h, H - r.y)}" fill="black"/>`)
    .join('');
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${rects}</svg>`);
  return sharp(image).composite([{ input: svg, top: 0, left: 0 }]).jpeg({ quality: 88 }).toBuffer();
}

/** Masque aussi les numéros de carte dans du texte renvoyé par un fournisseur. */
export function maskCardText(s: string | null): string | null {
  if (!s) return s;
  return s.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => '•••• ' + m.replace(/\D/g, '').slice(-4));
}
