import fs from 'node:fs';
import { DateTime } from 'luxon';
import { all, get, run, uid, nowIso, parseJson, tx } from '../db.ts';
import {
  categoryRemaining,
  findDuplicates,
  getCategory,
  insertTransaction,
  learnMerchant,
  listCategories,
  suggestCategory,
  type SplitInput,
} from './budget.ts';
import { config } from '../config.ts';
import type { User } from '../auth.ts';
import { formatMoney } from '../time.ts';

export type DraftFields = {
  date: string | null;
  merchant: string | null;
  amountCents: number | null;
  currency: string;
  origAmountCents?: number | null;
  type: 'expense' | 'refund' | 'income';
  budgetKey: 'perso' | 'mondaix';
  categoryId: string | null;
  splits?: SplitInput[] | null;
  note?: string | null;
  categoryReason?: string;
};

export type DraftField = 'amount' | 'merchant' | 'category' | 'date' | 'currency';

export class DuplicateError extends Error {
  hints: any[];
  constructor(hints: any[]) {
    super('Doublon possible');
    this.hints = hints;
  }
}

export function missingFields(f: DraftFields): DraftField[] {
  const m: DraftField[] = [];
  if (!f.amountCents || f.amountCents <= 0) m.push('amount');
  if (!f.merchant) m.push('merchant');
  if (!f.categoryId && !(f.splits && f.splits.length)) m.push('category');
  if (!f.date) m.push('date');
  return m;
}

export function serializeDraft(userId: string, r: any) {
  const f = parseJson<DraftFields>(r.fields, {} as DraftFields);
  const cat = f.categoryId ? getCategory(userId, f.categoryId) : null;
  const imp = r.import_id ? get('SELECT id, duplicate_of, created_at FROM imports WHERE id = ?', r.import_id) : null;
  const duplicates = r.status === 'pending' ? findDuplicates(userId, f, r.id) : [];
  return {
    id: r.id,
    source: r.source,
    importId: r.import_id,
    lineIndex: r.line_index,
    status: r.status,
    transactionId: r.transaction_id,
    rawText: r.raw_text,
    fields: f,
    categoryLabel: cat?.label || null,
    budgetName: f.budgetKey === 'mondaix' ? 'MONDAIX' : 'Personnel',
    uncertain: parseJson<string[]>(r.uncertain, []),
    missing: missingFields(f),
    duplicates,
    importDuplicate: imp?.duplicate_of ? { importId: imp.duplicate_of } : null,
    createdAt: r.created_at,
  };
}

export function getDraft(userId: string, id: string) {
  const r = get('SELECT * FROM drafts WHERE id = ? AND user_id = ?', id, userId);
  return r ? serializeDraft(userId, r) : undefined;
}

export function listPendingDrafts(userId: string) {
  return all("SELECT * FROM drafts WHERE user_id = ? AND status = 'pending' ORDER BY created_at, line_index", userId).map((r) => serializeDraft(userId, r));
}

export function pendingCount(userId: string): number {
  return get<{ n: number }>("SELECT COUNT(*) n FROM drafts WHERE user_id = ? AND status = 'pending'", userId)!.n;
}

/** Crée une fiche (dépense en attente de validation) en proposant catégorie et budget. */
export function createDraft(
  user: User,
  input: Partial<DraftFields> & { rawText?: string; hint?: string },
  meta: { source: 'chat' | 'import' | 'manuel' | 'recurrent'; importId?: string | null; lineIndex?: number; uncertain?: string[] },
) {
  const budgetKey = input.budgetKey || null;
  let categoryId = input.categoryId || null;
  let categoryReason = '';
  let resolvedBudget: 'perso' | 'mondaix' = (budgetKey as any) || 'perso';
  const uncertain = new Set(meta.uncertain || []);
  if (!categoryId) {
    const s = suggestCategory(user.id, input.merchant || '', input.hint || input.rawText || '', budgetKey);
    categoryId = s.categoryId;
    categoryReason = s.reason;
    if (!budgetKey) resolvedBudget = s.budgetKey as any;
    if (s.confidence === 'low') uncertain.add('category');
  }
  if (input.type === 'income') {
    const inc = listCategories(user.id).find((c) => c.kind === 'income' && c.budgetKey === resolvedBudget);
    if (inc) categoryId = inc.id;
  }
  const fields: DraftFields = {
    date: input.date ?? DateTime.now().setZone(user.timezone).toISODate(),
    merchant: input.merchant ?? null,
    amountCents: input.amountCents ?? null,
    currency: input.currency || 'CAD',
    origAmountCents: input.origAmountCents ?? null,
    type: input.type || 'expense',
    budgetKey: resolvedBudget,
    categoryId,
    splits: null,
    note: input.note ?? null,
    categoryReason,
  };
  if (fields.currency !== 'CAD') {
    uncertain.add('currency');
    fields.origAmountCents = fields.amountCents;
  }
  const id = uid();
  const now = nowIso();
  run(
    `INSERT INTO drafts (id, user_id, source, import_id, line_index, fields, uncertain, raw_text, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?, 'pending', ?, ?)`,
    id,
    user.id,
    meta.source,
    meta.importId ?? null,
    meta.lineIndex ?? 0,
    JSON.stringify(fields),
    JSON.stringify([...uncertain]),
    input.rawText ?? null,
    now,
    now,
  );
  return getDraft(user.id, id)!;
}

export function updateDraft(userId: string, id: string, patch: Partial<DraftFields>) {
  const r = get('SELECT * FROM drafts WHERE id = ? AND user_id = ?', id, userId);
  if (!r) throw new Error('Fiche introuvable');
  if (r.status !== 'pending') throw new Error('Cette fiche est déjà traitée');
  const f = { ...parseJson<DraftFields>(r.fields, {} as DraftFields) };
  const unc = new Set(parseJson<string[]>(r.uncertain, []));
  const map: Record<string, string> = { amountCents: 'amount', merchant: 'merchant', categoryId: 'category', date: 'date', currency: 'currency', budgetKey: 'category', splits: 'category' };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    (f as any)[k] = v;
    if (map[k]) unc.delete(map[k]);
  }
  if (patch.categoryId) {
    const c = getCategory(userId, patch.categoryId);
    if (c) f.budgetKey = c.budgetKey as any;
    f.categoryReason = '';
  } else if (patch.budgetKey && f.categoryId) {
    // changement de budget : proposer une catégorie équivalente dans l'autre budget
    const c = getCategory(userId, f.categoryId);
    if (c && c.budgetKey !== patch.budgetKey) {
      const s = suggestCategory(userId, f.merchant || '', r.raw_text || '', patch.budgetKey);
      f.categoryId = s.categoryId;
      if (!s.categoryId) unc.add('category');
    }
  }
  run('UPDATE drafts SET fields = ?, uncertain = ?, updated_at = ? WHERE id = ?', JSON.stringify(f), JSON.stringify([...unc]), nowIso(), id);
  return getDraft(userId, id)!;
}

/** Supprime l'image d'un import dès que toutes ses lignes sont confirmées ou retirées (réglage par défaut). */
export function maybeDeleteImportImage(userId: string, importId: string | null, keepImages: boolean) {
  if (!importId || keepImages || !config.images.deleteAfterValidation) return;
  const imp = get('SELECT * FROM imports WHERE id = ? AND user_id = ?', importId, userId);
  if (!imp || !imp.file_path) return;
  const pending = get<{ n: number }>("SELECT COUNT(*) n FROM drafts WHERE import_id = ? AND status = 'pending'", importId)!.n;
  if (pending > 0) return;
  try {
    fs.rmSync(imp.file_path, { force: true });
  } catch {}
  run('UPDATE imports SET file_path = NULL, image_deleted_at = ? WHERE id = ?', nowIso(), importId);
}

/**
 * Confirme une fiche et crée la transaction. Idempotent : une double pression renvoie la même transaction.
 * Les doublons probables exigent une confirmation explicite (force).
 */
export function confirmDraft(user: User, id: string, opts: { force?: boolean } = {}) {
  const result = tx(() => {
    const r = get('SELECT * FROM drafts WHERE id = ? AND user_id = ?', id, user.id);
    if (!r) throw new Error('Fiche introuvable');
    if (r.status === 'confirmed') return { transactionId: r.transaction_id as string, already: true, fields: parseJson<DraftFields>(r.fields, {} as DraftFields), importId: r.import_id };
    if (r.status === 'cancelled') throw new Error('Cette fiche a été annulée');
    const f = parseJson<DraftFields>(r.fields, {} as DraftFields);
    const missing = missingFields(f);
    if (missing.includes('amount')) throw new Error('Il manque le montant');
    if (missing.includes('category')) throw new Error('Choisis une catégorie');
    if (missing.includes('date')) throw new Error('Il manque la date');
    if (!opts.force) {
      const d = findDuplicates(user.id, f, r.id).filter((x) => x.type === 'transaction');
      if (d.length) throw new DuplicateError(d);
    }
    const splits = f.splits && f.splits.length ? f.splits : [{ categoryId: f.categoryId!, amountCents: f.amountCents! }];
    const txId = insertTransaction(user.id, {
      date: f.date!,
      merchant: f.merchant || '',
      amountCents: f.amountCents!,
      origAmountCents: f.currency !== 'CAD' ? (f.origAmountCents ?? null) : null,
      origCurrency: f.currency !== 'CAD' ? f.currency : null,
      type: f.type,
      note: f.note,
      splits,
      source: r.source,
      draftId: r.id,
      importId: r.import_id,
    });
    run("UPDATE drafts SET status = 'confirmed', transaction_id = ?, updated_at = ? WHERE id = ?", txId, nowIso(), r.id);
    run('DELETE FROM chat_pending WHERE user_id = ? AND draft_id = ?', user.id, r.id);
    if (f.merchant) for (const s of splits) learnMerchant(user.id, f.merchant, s.categoryId);
    return { transactionId: txId, already: false, fields: f, importId: r.import_id };
  });
  maybeDeleteImportImage(user.id, result.importId, user.settings.keepImages);
  const month = (result.fields.date || '').slice(0, 7);
  const splits = result.fields.splits && result.fields.splits.length ? result.fields.splits : [{ categoryId: result.fields.categoryId!, amountCents: result.fields.amountCents! }];
  const remaining = splits.map((s) => categoryRemaining(user.id, s.categoryId, month)).filter(Boolean) as NonNullable<ReturnType<typeof categoryRemaining>>[];
  return {
    transactionId: result.transactionId,
    already: result.already,
    draft: getDraft(user.id, id),
    remaining: remaining.map((x) => ({
      categoryId: x.category.id,
      label: x.category.label,
      budgetName: x.category.budgetName,
      planned: x.planned,
      spent: x.spent,
      remaining: x.remaining,
      month: x.month,
      text: `Il reste ${formatMoney(x.remaining)} dans ${x.category.label} (${x.category.budgetName}) pour ${DateTime.fromISO(x.month + '-01').setLocale('fr-CA').toFormat('LLLL')}.`,
    })),
  };
}

export function cancelDraft(user: User, id: string) {
  const r = get('SELECT * FROM drafts WHERE id = ? AND user_id = ?', id, user.id);
  if (!r) throw new Error('Fiche introuvable');
  if (r.status === 'confirmed') throw new Error('Cette fiche est déjà confirmée');
  run("UPDATE drafts SET status = 'cancelled', updated_at = ? WHERE id = ?", nowIso(), id);
  run('DELETE FROM chat_pending WHERE user_id = ? AND draft_id = ?', user.id, id);
  maybeDeleteImportImage(user.id, r.import_id, user.settings.keepImages);
  return getDraft(user.id, id);
}
