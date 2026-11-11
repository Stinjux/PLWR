import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { all, get, run, uid, nowIso } from '../db.ts';
import { config } from '../config.ts';
import type { User } from '../auth.ts';
import { today } from '../time.ts';
import { runOcr, findCardNumberBoxes, redactBoxes, maskCardText } from '../vision/ocr.ts';
import { getProvider } from '../vision/providers.ts';
import { VisionError, type ExtractionResult, type OcrResult } from '../vision/types.ts';
import { createDraft } from './drafts.ts';
import { findBudget } from './expenseParser.ts';

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif', 'image/avif'];

/** Empreinte perceptuelle (dHash 64 bits) : reconnaît une même image réencodée ou redimensionnée. */
async function dHash(buf: Buffer): Promise<string> {
  const px = await sharp(buf).grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += px[y * 9 + x] > px[y * 9 + x + 1] ? '1' : '0';
  return BigInt('0b' + bits).toString(16).padStart(16, '0');
}
function hamming(a: string, b: string): number {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

export function serializeImport(r: any) {
  return {
    id: r.id,
    source: r.source,
    status: r.status,
    provider: r.provider,
    error: r.error,
    redactions: r.redactions,
    duplicateOf: r.duplicate_of,
    hasImage: Boolean(r.file_path),
    imageDeletedAt: r.image_deleted_at,
    createdAt: r.created_at,
  };
}

export async function processImport(user: User, file: { bytes: Buffer; mime: string; name?: string }, source: 'chat' | 'budget') {
  if (!ACCEPTED.includes(file.mime)) throw new VisionError('unreadable', 'Format non pris en charge (JPEG, PNG, WebP ou HEIC)');
  if (file.bytes.length > config.vision.maxUploadBytes) throw new VisionError('unreadable', 'Image trop lourde');

  // Normalisation : orientation, suppression des métadonnées (GPS…), taille raisonnable, JPEG.
  let normalized: Buffer;
  try {
    normalized = await sharp(file.bytes).rotate().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
  } catch {
    throw new VisionError('unreadable', 'Image illisible ou corrompue');
  }
  const fileHash = crypto.createHash('sha256').update(file.bytes).digest('hex');
  const phash = await dHash(normalized);

  // Même image déjà importée ? (empreinte exacte ou perceptuelle très proche)
  const previous = all('SELECT id, file_hash, phash FROM imports WHERE user_id = ? ORDER BY created_at DESC LIMIT 500', user.id).find(
    (p) => p.file_hash === fileHash || (p.phash && hamming(p.phash, phash) <= 3),
  );

  const id = uid();
  const dir = path.join(config.dataDir, 'uploads', user.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // OCR local puis masquage des numéros de carte avant tout envoi externe
  let ocr: OcrResult | null = null;
  let redacted = normalized;
  let redactions = 0;
  const provider = getProvider(user.settings && (user.settings as any).simulateVisionError ? 'mock-error' : undefined);
  if (config.vision.redactCardNumbers || provider.name === 'local') {
    try {
      ocr = await runOcr(normalized);
      const boxes = findCardNumberBoxes(ocr);
      redactions = boxes.length;
      redacted = await redactBoxes(normalized, boxes);
    } catch (e) {
      console.warn('[import] OCR local indisponible :', (e as Error).message);
    }
  }
  const filePath = path.join(dir, `${id}.jpg`);
  fs.writeFileSync(filePath, redacted, { mode: 0o600 });
  run(
    `INSERT INTO imports (id, user_id, source, file_hash, phash, file_path, status, provider, redactions, duplicate_of, created_at)
     VALUES (?,?,?,?,?,?,'processing',?,?,?,?)`,
    id,
    user.id,
    source,
    fileHash,
    phash,
    filePath,
    provider.name,
    redactions,
    previous?.id ?? null,
    nowIso(),
  );

  let result: ExtractionResult;
  try {
    result = await provider.extract(redacted, { mime: 'image/jpeg', today: today(user.timezone), ocr });
  } catch (e: any) {
    const msg = e instanceof VisionError ? e.message : 'Lecture impossible';
    run("UPDATE imports SET status = 'failed', error = ? WHERE id = ?", msg, id);
    return { import: serializeImport(get('SELECT * FROM imports WHERE id = ?', id)), drafts: [], error: msg, manualEntry: true };
  }
  if (!result.readable || !result.transactions.length) {
    const msg = result.reason || 'Aucune transaction lisible';
    run("UPDATE imports SET status = 'failed', error = ? WHERE id = ?", msg, id);
    return { import: serializeImport(get('SELECT * FROM imports WHERE id = ?', id)), drafts: [], error: msg, manualEntry: true };
  }

  const drafts = result.transactions.map((t, i) => {
    const unc = new Set<string>(t.uncertainFields || []);
    if (!t.amount) unc.add('amount');
    if (!t.date) unc.add('date');
    if (!t.merchant) unc.add('merchant');
    const currency = (t.currency || 'CAD').toUpperCase();
    const merchant = maskCardText(t.merchant)?.trim() || null;
    return createDraft(
      user,
      {
        date: t.date || today(user.timezone),
        merchant,
        amountCents: t.amount ? Math.round(Math.abs(t.amount) * 100) : null,
        currency,
        type: t.direction === 'credit' ? 'refund' : 'expense',
        budgetKey: (findBudget(`${merchant || ''} ${t.rawText || ''}`) as any) || undefined,
        rawText: maskCardText(t.rawText) ?? undefined,
        hint: `${merchant || ''} ${t.categoryHint || ''} ${t.rawText || ''}`,
      },
      { source: 'import', importId: id, lineIndex: i, uncertain: [...unc] },
    );
  });
  run("UPDATE imports SET status = 'done' WHERE id = ?", id);
  return { import: serializeImport(get('SELECT * FROM imports WHERE id = ?', id)), drafts, error: null, manualEntry: false };
}

/** Purge de sécurité : images conservées trop longtemps. */
export function purgeOldImages() {
  const cutoff = new Date(Date.now() - config.images.maxRetentionHours * 3600_000).toISOString();
  for (const r of all('SELECT id, file_path FROM imports WHERE file_path IS NOT NULL AND created_at < ?', cutoff)) {
    const u = get("SELECT settings FROM users u JOIN imports i ON i.user_id = u.id WHERE i.id = ?", r.id);
    if (u && JSON.parse(u.settings || '{}').keepImages) continue;
    try {
      fs.rmSync(r.file_path, { force: true });
    } catch {}
    run('UPDATE imports SET file_path = NULL, image_deleted_at = ? WHERE id = ?', nowIso(), r.id);
  }
}
