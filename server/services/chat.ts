import { all, get, run, uid, nowIso, parseJson } from '../db.ts';
import type { User } from '../auth.ts';
import { parseExpenses, parseAmountReply, findDate, strip } from './expenseParser.ts';
import { createDraft, getDraft, updateDraft, cancelDraft, type DraftField } from './drafts.ts';
import { listCategories } from './budget.ts';
import { formatMoney } from '../time.ts';

export type ChatPayload = {
  draftIds?: string[];
  chips?: { label: string; value: string }[];
  question?: { draftId: string; field: DraftField };
  importId?: string;
  manualEntry?: boolean;
  confirmation?: { transactionId: string; text: string };
};

export function addMessage(userId: string, role: 'user' | 'assistant', text: string, payload: ChatPayload = {}) {
  const id = uid();
  run('INSERT INTO chat_messages (id, user_id, role, text, payload, created_at) VALUES (?,?,?,?,?,?)', id, userId, role, text, JSON.stringify(payload), nowIso());
  return { id, role, text, payload, createdAt: nowIso() };
}

export function listMessages(userId: string, limit = 60) {
  const rows = all('SELECT * FROM chat_messages WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', userId, limit).reverse();
  return rows.map((r) => {
    const payload = parseJson<ChatPayload>(r.payload, {});
    return {
      id: r.id,
      role: r.role,
      text: r.text,
      payload,
      drafts: (payload.draftIds || []).map((d) => getDraft(userId, d)).filter(Boolean),
      createdAt: r.created_at,
    };
  });
}

function draftLabel(d: any): string {
  const f = d.fields;
  const parts = [f.amountCents ? formatMoney(f.amountCents, f.currency || 'CAD') : null, f.merchant].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'cette dépense';
}

function categoryChips(userId: string, budgetKey: string) {
  return listCategories(userId)
    .filter((c) => c.kind === 'expense' && c.budgetKey === budgetKey)
    .slice(0, 12)
    .map((c) => ({ label: c.label, value: `cat:${c.id}` }));
}

/** Pose une seule question ciblée sur la première information manquante, ou rien si tout est prêt. */
function nextQuestion(user: User, draftIds: string[]): { text: string; payload: ChatPayload } | null {
  for (const id of draftIds) {
    const d = getDraft(user.id, id);
    if (!d || d.status !== 'pending') continue;
    const many = draftIds.length > 1;
    const which = many ? ` (${draftLabel(d)})` : '';
    if (d.missing.includes('amount')) {
      set(user.id, id, 'amount');
      return { text: `Quel est le montant${d.fields.merchant ? ` payé chez ${d.fields.merchant}` : ''}${many && !d.fields.merchant ? which : ''} ?`, payload: { question: { draftId: id, field: 'amount' }, draftIds: [id] } };
    }
    if (d.missing.includes('merchant')) {
      set(user.id, id, 'merchant');
      return { text: `Chez quel commerçant as-tu payé ${formatMoney(d.fields.amountCents!)} ?`, payload: { question: { draftId: id, field: 'merchant' }, draftIds: [id], chips: [{ label: 'Passer', value: 'skip' }] } };
    }
    if (d.missing.includes('category')) {
      set(user.id, id, 'category');
      return { text: `Dans quelle catégorie dois-je classer ${draftLabel(d)} ?`, payload: { question: { draftId: id, field: 'category' }, draftIds: [id], chips: categoryChips(user.id, d.fields.budgetKey) } };
    }
  }
  run('DELETE FROM chat_pending WHERE user_id = ?', user.id);
  return null;
}

function set(userId: string, draftId: string, field: string) {
  run('INSERT INTO chat_pending (user_id, draft_id, field, created_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET draft_id = excluded.draft_id, field = excluded.field, created_at = excluded.created_at', userId, draftId, field, nowIso());
}

function readyMessage(user: User, ids: string[]): string {
  const ds = ids.map((i) => getDraft(user.id, i)).filter((d) => d && d.status === 'pending');
  if (!ds.length) return 'C’est noté.';
  const dup = ds.some((d) => d!.duplicates.length);
  const base = ds.length === 1 ? 'Voici la fiche. Vérifie-la puis confirme.' : `J’ai trouvé ${ds.length} dépenses. Confirme-les une par une ou toutes ensemble.`;
  return dup ? `${base} Attention : doublon possible signalé.` : base;
}

/** Traite un message texte de l'utilisateur dans le chatbot de dépenses. */
export function handleChat(user: User, text: string, reply?: { value: string }) {
  const userMsg = addMessage(user.id, 'user', text);
  const pending = get('SELECT * FROM chat_pending WHERE user_id = ?', user.id);
  const responses: ReturnType<typeof addMessage>[] = [];
  const say = (t: string, p: ChatPayload = {}) => responses.push(addMessage(user.id, 'assistant', t, p));

  const pendingDraft = pending ? getDraft(user.id, pending.draft_id) : undefined;
  if (pending && pendingDraft && pendingDraft.status === 'pending') {
    const val = reply?.value ?? text;
    const st = strip(val).trim();
    if (/^(annule|annuler|laisse faire|oublie|non merci)\b/.test(st)) {
      cancelDraft(user, pending.draft_id);
      say('D’accord, j’ai annulé cette fiche.');
      return { userMessage: userMsg, messages: responses };
    }
    let handled = false;
    // Si le message contient manifestement une nouvelle dépense complète, on la traite comme telle
    const looksNew = parseExpenses(text, user.timezone).items.some((i) => i.amountCents && i.merchant) && pending.field !== 'amount';
    if (!looksNew) {
      if (pending.field === 'amount') {
        const a = parseAmountReply(val);
        if (a) {
          updateDraft(user.id, pending.draft_id, { amountCents: a.cents, currency: a.currency });
          handled = true;
        } else {
          say('Je n’ai pas reconnu de montant. Peux-tu l’écrire en chiffres, par exemple « 45,20 » ?', { question: { draftId: pending.draft_id, field: 'amount' }, draftIds: [pending.draft_id] });
          return { userMessage: userMsg, messages: responses };
        }
      } else if (pending.field === 'merchant') {
        const m = val === 'skip' ? 'Sans commerçant' : val.replace(/^(c'?etait|c'?est|chez|au|à la|a la|à)\s+/i, '').trim().slice(0, 80);
        updateDraft(user.id, pending.draft_id, { merchant: m });
        handled = true;
      } else if (pending.field === 'category') {
        const cats = listCategories(user.id).filter((c) => c.kind === 'expense');
        let catId = val.startsWith('cat:') ? val.slice(4) : null;
        if (!catId) {
          const sv = strip(val);
          const found = cats.find((c) => strip(c.label) === sv) || cats.find((c) => strip(c.name) === sv) || cats.find((c) => sv.length > 2 && (strip(c.label).includes(sv) || sv.includes(strip(c.name))));
          catId = found?.id || null;
        }
        if (catId && cats.some((c) => c.id === catId)) {
          updateDraft(user.id, pending.draft_id, { categoryId: catId });
          handled = true;
        } else {
          say('Je n’ai pas trouvé cette catégorie. Choisis-en une :', { question: { draftId: pending.draft_id, field: 'category' }, draftIds: [pending.draft_id], chips: categoryChips(user.id, pendingDraft.fields.budgetKey) });
          return { userMessage: userMsg, messages: responses };
        }
      }
      // date éventuelle ajoutée dans la réponse (« 45 $, c'était hier »)
      const d = findDate(val, user.timezone, new Date());
      if (handled && d) updateDraft(user.id, pending.draft_id, { date: d.date });
    }
    if (handled) {
      run('DELETE FROM chat_pending WHERE user_id = ?', user.id);
      // autres fiches du même message encore incomplètes ?
      const group = all("SELECT payload FROM chat_messages WHERE user_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 10", user.id)
        .map((r) => parseJson<ChatPayload>(r.payload, {}).draftIds || [])
        .find((ids) => ids.length > 1 && ids.includes(pending.draft_id)) || [pending.draft_id];
      const q = nextQuestion(user, group);
      if (q) say(q.text, q.payload);
      else say(readyMessage(user, group), { draftIds: group });
      return { userMessage: userMsg, messages: responses };
    }
  }

  const parsed = parseExpenses(text, user.timezone);
  if (!parsed.items.length) {
    say('Je n’ai pas trouvé de dépense dans ce message. Essaie par exemple « 12 $ chez Tim Hortons ce matin », ou joins une photo de reçu.', {
      chips: [{ label: 'Saisie manuelle', value: 'manual' }],
    });
    return { userMessage: userMsg, messages: responses };
  }
  const ids: string[] = [];
  parsed.items.forEach((it, i) => {
    const uncertain: string[] = [];
    if (it.amountUncertain) uncertain.push('amount');
    if (it.dateUncertain) uncertain.push('date');
    const d = createDraft(
      user,
      { date: it.date, merchant: it.merchant, amountCents: it.amountCents, currency: it.currency, type: it.type, budgetKey: it.budgetKey || undefined, rawText: it.raw, hint: it.hint },
      { source: 'chat', lineIndex: i, uncertain },
    );
    ids.push(d.id);
  });
  const q = nextQuestion(user, ids);
  if (q) {
    // On affiche toutes les fiches, puis une seule question
    say(ids.length > 1 ? `J’ai trouvé ${ids.length} dépenses.` : 'J’ai préparé une fiche.', { draftIds: ids });
    say(q.text, q.payload);
  } else say(readyMessage(user, ids), { draftIds: ids });
  return { userMessage: userMsg, messages: responses };
}
