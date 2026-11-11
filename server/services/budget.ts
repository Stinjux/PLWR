import { DateTime } from 'luxon';
import { all, get, run, uid, nowIso, tx } from '../db.ts';
import { formatMoney } from '../time.ts';

export type Category = {
  id: string;
  budgetId: string;
  budgetKey: string;
  budgetName: string;
  grp: string;
  name: string;
  label: string;
  kind: 'expense' | 'income';
  defaultAmountCents: number;
  keywords: string;
  archived: boolean;
};

export function listBudgets(userId: string) {
  return all('SELECT id, key, name FROM budgets WHERE user_id = ? ORDER BY key DESC', userId);
}

export function listCategories(userId: string, includeArchived = false): Category[] {
  return all(
    `SELECT c.*, b.key AS budget_key, b.name AS budget_name FROM categories c JOIN budgets b ON b.id = c.budget_id
     WHERE c.user_id = ? ${includeArchived ? '' : 'AND c.archived = 0'} ORDER BY b.key DESC, c.kind, c.sort, c.grp, c.name`,
    userId,
  ).map((r) => ({
    id: r.id,
    budgetId: r.budget_id,
    budgetKey: r.budget_key,
    budgetName: r.budget_name,
    grp: r.grp,
    name: r.name,
    label: r.grp === r.name ? r.name : `${r.grp} / ${r.name}`,
    kind: r.kind,
    defaultAmountCents: r.default_amount_cents,
    keywords: r.keywords,
    archived: Boolean(r.archived),
  }));
}

export function getCategory(userId: string, id: string): Category | undefined {
  return listCategories(userId, true).find((c) => c.id === id);
}

/** Montant prévu d'une catégorie pour un mois : allocation du mois, sinon montant par défaut. */
export function plannedFor(categoryId: string, month: string, defaultCents: number): number {
  const a = get<{ amount_cents: number }>('SELECT amount_cents FROM allocations WHERE category_id = ? AND month = ?', categoryId, month);
  return a ? a.amount_cents : defaultCents;
}

export function setAllocation(categoryId: string, month: string, cents: number) {
  run(
    'INSERT INTO allocations (category_id, month, amount_cents) VALUES (?,?,?) ON CONFLICT(category_id, month) DO UPDATE SET amount_cents = excluded.amount_cents',
    categoryId,
    month,
    Math.max(0, Math.round(cents)),
  );
}

function monthRange(month: string) {
  const s = DateTime.fromISO(`${month}-01`);
  return { from: s.toISODate()!, to: s.plus({ months: 1 }).toISODate()! };
}

/** Dépenses confirmées nettes (dépenses - remboursements) par catégorie pour un mois. */
export function spentByCategory(userId: string, month: string): Map<string, number> {
  const { from, to } = monthRange(month);
  const rows = all<{ category_id: string; type: string; total: number }>(
    `SELECT s.category_id, t.type, SUM(s.amount_cents) total FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id
     WHERE t.user_id = ? AND t.date >= ? AND t.date < ? GROUP BY s.category_id, t.type`,
    userId,
    from,
    to,
  );
  const m = new Map<string, number>();
  for (const r of rows) {
    const sign = r.type === 'refund' ? -1 : 1;
    m.set(r.category_id, (m.get(r.category_id) || 0) + sign * r.total);
  }
  return m;
}

export function categoryRemaining(userId: string, categoryId: string, month: string) {
  const c = getCategory(userId, categoryId);
  if (!c) return null;
  const planned = plannedFor(c.id, month, c.defaultAmountCents);
  const spent = spentByCategory(userId, month).get(c.id) || 0;
  return { category: c, planned, spent, remaining: planned - spent, month };
}

export function budgetSummary(userId: string, month: string, view: 'perso' | 'mondaix' | 'all') {
  const cats = listCategories(userId).filter((c) => view === 'all' || c.budgetKey === view);
  const spent = spentByCategory(userId, month);
  const rows = cats.map((c) => {
    const planned = plannedFor(c.id, month, c.defaultAmountCents);
    const s = spent.get(c.id) || 0;
    return { ...c, planned, spent: s, remaining: planned - s };
  });
  const expenses = rows.filter((r) => r.kind === 'expense');
  const incomes = rows.filter((r) => r.kind === 'income');
  const sum = (a: typeof rows, k: 'planned' | 'spent' | 'remaining') => a.reduce((s, r) => s + r[k], 0);
  return {
    month,
    view,
    categories: expenses,
    incomeCategories: incomes,
    totals: {
      planned: sum(expenses, 'planned'),
      spent: sum(expenses, 'spent'),
      remaining: sum(expenses, 'remaining'),
      incomePlanned: sum(incomes, 'planned'),
      income: sum(incomes, 'spent'),
    },
  };
}

export type SplitInput = { categoryId: string; amountCents: number };
export type TxInput = {
  date: string;
  merchant: string;
  amountCents: number;
  currency?: string;
  origAmountCents?: number | null;
  origCurrency?: string | null;
  type?: 'expense' | 'income' | 'refund';
  refundOf?: string | null;
  note?: string | null;
  splits: SplitInput[];
  source?: string;
  draftId?: string | null;
  importId?: string | null;
  recurringId?: string | null;
  sample?: boolean;
};

function validateTx(userId: string, t: TxInput) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date)) throw new Error('Date invalide');
  if (!Number.isInteger(t.amountCents) || t.amountCents <= 0) throw new Error('Le montant doit être positif');
  if (!t.splits?.length) throw new Error('Choisis au moins une catégorie');
  const total = t.splits.reduce((s, x) => s + x.amountCents, 0);
  if (total !== t.amountCents) throw new Error(`La répartition (${formatMoney(total)}) doit égaler le montant (${formatMoney(t.amountCents)})`);
  for (const s of t.splits) {
    if (!get('SELECT 1 FROM categories WHERE id = ? AND user_id = ?', s.categoryId, userId)) throw new Error('Catégorie inconnue');
    if (s.amountCents <= 0) throw new Error('Chaque part doit être positive');
  }
  if (t.refundOf && !get('SELECT 1 FROM transactions WHERE id = ? AND user_id = ?', t.refundOf, userId)) throw new Error('Transaction d’origine introuvable');
}

export function insertTransaction(userId: string, t: TxInput): string {
  validateTx(userId, t);
  const id = uid();
  const now = nowIso();
  run(
    `INSERT INTO transactions (id, user_id, date, merchant, amount_cents, currency, orig_amount_cents, orig_currency, type, refund_of, note, source,
      draft_id, import_id, recurring_id, sample, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    userId,
    t.date,
    (t.merchant || '').trim().slice(0, 120),
    t.amountCents,
    'CAD',
    t.origAmountCents ?? null,
    t.origCurrency && t.origCurrency !== 'CAD' ? t.origCurrency : null,
    t.type || 'expense',
    t.refundOf ?? null,
    t.note ?? null,
    t.source || 'manuel',
    t.draftId ?? null,
    t.importId ?? null,
    t.recurringId ?? null,
    t.sample ? 1 : 0,
    now,
    now,
  );
  for (const s of t.splits) run('INSERT INTO transaction_splits (id, transaction_id, category_id, amount_cents) VALUES (?,?,?,?)', uid(), id, s.categoryId, s.amountCents);
  return id;
}

export function updateTransaction(userId: string, id: string, t: TxInput) {
  const existing = get('SELECT * FROM transactions WHERE id = ? AND user_id = ?', id, userId);
  if (!existing) throw new Error('Transaction introuvable');
  validateTx(userId, t);
  tx(() => {
    run(
      `UPDATE transactions SET date = ?, merchant = ?, amount_cents = ?, orig_amount_cents = ?, orig_currency = ?, type = ?, refund_of = ?, note = ?, updated_at = ? WHERE id = ?`,
      t.date,
      (t.merchant || '').trim(),
      t.amountCents,
      t.origAmountCents ?? null,
      t.origCurrency && t.origCurrency !== 'CAD' ? t.origCurrency : null,
      t.type || existing.type,
      t.refundOf ?? existing.refund_of,
      t.note ?? null,
      nowIso(),
      id,
    );
    run('DELETE FROM transaction_splits WHERE transaction_id = ?', id);
    for (const s of t.splits) run('INSERT INTO transaction_splits (id, transaction_id, category_id, amount_cents) VALUES (?,?,?,?)', uid(), id, s.categoryId, s.amountCents);
  });
}

export function getTransaction(userId: string, id: string) {
  const r = get('SELECT * FROM transactions WHERE id = ? AND user_id = ?', id, userId);
  return r ? hydrate(userId, [r])[0] : undefined;
}

function hydrate(userId: string, rows: any[]) {
  const cats = new Map(listCategories(userId, true).map((c) => [c.id, c]));
  return rows.map((r) => {
    const splits = all('SELECT category_id, amount_cents FROM transaction_splits WHERE transaction_id = ?', r.id).map((s) => ({
      categoryId: s.category_id,
      amountCents: s.amount_cents,
      label: cats.get(s.category_id)?.label || '?',
      budgetKey: cats.get(s.category_id)?.budgetKey || 'perso',
    }));
    return {
      id: r.id,
      date: r.date,
      merchant: r.merchant,
      amountCents: r.amount_cents,
      currency: r.currency,
      origAmountCents: r.orig_amount_cents,
      origCurrency: r.orig_currency,
      type: r.type,
      refundOf: r.refund_of,
      note: r.note,
      source: r.source,
      importId: r.import_id,
      splits,
      budgetKeys: [...new Set(splits.map((s) => s.budgetKey))],
      refundedCents: (get<{ v: number }>("SELECT COALESCE(SUM(amount_cents),0) v FROM transactions WHERE refund_of = ? AND type = 'refund'", r.id)?.v) || 0,
      sample: Boolean(r.sample),
    };
  });
}

export function listTransactions(userId: string, opts: { month?: string; view?: 'perso' | 'mondaix' | 'all'; categoryId?: string; limit?: number }) {
  const params: any[] = [userId];
  let where = 't.user_id = ?';
  if (opts.month) {
    const r = monthRange(opts.month);
    where += ' AND t.date >= ? AND t.date < ?';
    params.push(r.from, r.to);
  }
  if (opts.view && opts.view !== 'all') {
    where += ' AND EXISTS (SELECT 1 FROM transaction_splits s JOIN categories c ON c.id = s.category_id JOIN budgets b ON b.id = c.budget_id WHERE s.transaction_id = t.id AND b.key = ?)';
    params.push(opts.view);
  }
  if (opts.categoryId) {
    where += ' AND EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id AND s.category_id = ?)';
    params.push(opts.categoryId);
  }
  const rows = all(`SELECT t.* FROM transactions t WHERE ${where} ORDER BY t.date DESC, t.created_at DESC LIMIT ?`, ...params, opts.limit || 300);
  return hydrate(userId, rows);
}

// ---------- Catégorisation ----------

export function merchantKey(m: string): string {
  return (m || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/#?\d{2,}/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(inc|ltee|ltd|corp|cie|the|le|la|les|store|magasin|qc|on|ca|can)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Apprend la catégorie choisie pour un commerçant (sert aux suggestions futures). */
export function learnMerchant(userId: string, merchant: string, categoryId: string) {
  const key = merchantKey(merchant);
  if (!key) return;
  run(
    `INSERT INTO merchant_rules (user_id, merchant_key, category_id, hits, updated_at) VALUES (?,?,?,1,?)
     ON CONFLICT(user_id, merchant_key, category_id) DO UPDATE SET hits = hits + 1, updated_at = excluded.updated_at`,
    userId,
    key,
    categoryId,
    nowIso(),
  );
}

type Suggestion = { categoryId: string | null; confidence: 'high' | 'medium' | 'low'; reason: string };

const KEYWORDS: [RegExp, string][] = [
  [/\b(essence|gaz|plein|carburant|shell|esso|petro[- ]?canada|ultramar|irving|couche[- ]tard|crevier|sonic)\b/, 'Essence'],
  [/\b(epicerie|iga|metro|maxi|provigo|super ?c|loblaws|adonis|marche|costco|walmart|sobeys|food basics|no frills|avril)\b/, 'Épicerie'],
  [/\b(resto|restaurant|cafe|starbucks|tim hortons?|mcdo|mcdonald|subway|a&w|dejeuner|diner|souper|lunch|pizza|sushi|bar|saq|uber ?eats|doordash|skip)\b/, 'Restaurants et cafés'],
  [/\b(loyer|hypotheque)\b/, 'Loyer'],
  [/\b(hydro|electricite)\b/, 'Hydro-électricité'],
  [/\b(bell|videotron|fizz|koodo|rogers|telus|virgin|cellulaire|internet|telephone)\b/, 'Internet et cellulaire'],
  [/\b(stm|rtc|stl|opus|exo|bus|metro de|uber|lyft|taxi|communauto|bixi|stationnement|parking|garage|pneus?|canadian tire|lave[- ]auto|saaq)\b/, 'Entretien et transport'],
  [/\b(gym|energie cardio|nautilus|econofitness|yoga|crossfit|sport|piscine)\b/, 'Gym et sport'],
  [/\b(pharmacie|jean coutu|pharmaprix|uniprix|familiprix|brunet|medicament|dentiste|medecin|clinique)\b/, 'Santé et pharmacie'],
  [/\b(netflix|spotify|disney|crave|apple|icloud|youtube|prime video|abonnement)\b/, 'Abonnements'],
  [/\b(cinema|spectacle|concert|billet|sortie|bowling)\b/, 'Sorties et loisirs'],
  [/\b(cfa|kaplan|schweser|examen|livre|formation|cours|udemy|coursera)\b/, 'CFA et formation'],
  [/\b(vetements?|simons|winners|h&m|zara|uniqlo|ikea|dollarama|home depot|rona|bureau en gros|best buy|amazon)\b/, 'Vêtements et maison'],
  [/\b(inventaire|stock|grossiste|alibaba|aliexpress|fournisseur|marchandise|liquidation)\b/, 'Inventaire'],
  [/\b(pub|publicite|facebook ads|meta|google ads|tiktok ads|marketing)\b/, 'Publicité'],
  [/\b(shopify|canva|notion|zapier|chatgpt|openai|anthropic|claude|logiciel|domaine|godaddy|hebergement|sellerboard|keepa|helium)\b/, 'Logiciels et abonnements'],
  [/\b(postes canada|canada post|purolator|ups|fedex|dhl|livraison|expedition|envoi|chit chats|stallion)\b/, 'Expédition'],
];

export function suggestCategory(userId: string, merchant: string, text: string, budgetKey: string | null): Suggestion & { budgetKey: string } {
  const cats = listCategories(userId).filter((c) => c.kind === 'expense');
  const key = merchantKey(merchant);
  // 1) mes corrections passées pour ce commerçant
  if (key) {
    const rules = all<{ category_id: string; hits: number }>(
      'SELECT category_id, hits FROM merchant_rules WHERE user_id = ? AND (merchant_key = ? OR ? LIKE merchant_key || \'%\' OR merchant_key LIKE ? || \'%\') ORDER BY hits DESC, updated_at DESC',
      userId,
      key,
      key,
      key,
    );
    for (const r of rules) {
      const c = cats.find((x) => x.id === r.category_id);
      if (!c) continue;
      if (budgetKey && c.budgetKey !== budgetKey) continue;
      return { categoryId: c.id, confidence: 'high', reason: `Comme tes dernières dépenses chez ${merchant}`, budgetKey: c.budgetKey };
    }
  }
  // 2) mots-clés
  const hay = merchantKey(`${merchant} ${text}`);
  const pool = budgetKey ? cats.filter((c) => c.budgetKey === budgetKey) : cats.filter((c) => c.budgetKey === 'perso');
  for (const [re, name] of KEYWORDS) {
    if (!re.test(hay)) continue;
    const c = pool.find((x) => merchantKey(x.name) === merchantKey(name)) || cats.find((x) => merchantKey(x.name) === merchantKey(name) && (!budgetKey || x.budgetKey === budgetKey));
    if (c) return { categoryId: c.id, confidence: 'medium', reason: 'Selon le commerçant', budgetKey: c.budgetKey };
  }
  // 3) mots-clés personnalisés des catégories
  for (const c of pool) {
    const kws = c.keywords.split(',').map((k) => merchantKey(k)).filter(Boolean);
    if (kws.some((k) => hay.includes(k))) return { categoryId: c.id, confidence: 'medium', reason: 'Mot-clé de catégorie', budgetKey: c.budgetKey };
  }
  return { categoryId: null, confidence: 'low', reason: 'Catégorie à préciser', budgetKey: budgetKey || 'perso' };
}

// ---------- Doublons ----------

function similarMerchant(a: string, b: string): boolean {
  const x = merchantKey(a), y = merchantKey(b);
  if (!x || !y) return true; // commerçant inconnu : on se fie au montant et à la date
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const tx = new Set(x.split(' ')), ty = y.split(' ');
  return ty.some((t) => t.length > 2 && tx.has(t));
}

export type DuplicateHint = { type: 'transaction' | 'draft'; id: string; label: string };

export function findDuplicates(userId: string, f: { date?: string | null; amountCents?: number | null; merchant?: string | null }, excludeDraftId?: string): DuplicateHint[] {
  if (!f.amountCents || !f.date) return [];
  const d = DateTime.fromISO(f.date);
  const from = d.minus({ days: 3 }).toISODate(), to = d.plus({ days: 3 }).toISODate();
  const out: DuplicateHint[] = [];
  for (const t of all('SELECT * FROM transactions WHERE user_id = ? AND amount_cents = ? AND date BETWEEN ? AND ?', userId, f.amountCents, from, to)) {
    if (similarMerchant(t.merchant, f.merchant || '')) out.push({ type: 'transaction', id: t.id, label: `${formatMoney(t.amount_cents)} · ${t.merchant || 'sans commerçant'} · ${t.date} (déjà enregistrée)` });
  }
  for (const r of all("SELECT * FROM drafts WHERE user_id = ? AND status = 'pending' AND id != ?", userId, excludeDraftId || '')) {
    const g = JSON.parse(r.fields);
    if (g.amountCents === f.amountCents && g.date && Math.abs(DateTime.fromISO(g.date).diff(d, 'days').days) <= 3 && similarMerchant(g.merchant || '', f.merchant || '')) {
      out.push({ type: 'draft', id: r.id, label: `${formatMoney(g.amountCents)} · ${g.merchant || 'sans commerçant'} · ${g.date} (en attente)` });
    }
  }
  return out;
}
