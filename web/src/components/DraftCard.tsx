import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { centsToInput, dayLabel, money, parseMoney } from '../lib/format';
import { Check, Icon, useToast } from './ui';

export type Draft = {
  id: string;
  source: string;
  importId: string | null;
  status: 'pending' | 'confirmed' | 'cancelled';
  transactionId: string | null;
  rawText: string | null;
  fields: {
    date: string | null;
    merchant: string | null;
    amountCents: number | null;
    currency: string;
    type: 'expense' | 'refund' | 'income';
    budgetKey: 'perso' | 'mondaix';
    categoryId: string | null;
    splits?: { categoryId: string; amountCents: number }[] | null;
    note?: string | null;
    categoryReason?: string;
  };
  categoryLabel: string | null;
  budgetName: string;
  uncertain: string[];
  missing: string[];
  duplicates: { type: string; id: string; label: string }[];
  importDuplicate: { importId: string } | null;
};

export type Category = { id: string; label: string; budgetKey: string; budgetName: string; kind: string; grp: string; name: string };

export function useCategories() {
  return useQuery({ queryKey: ['categories'], queryFn: () => api.get<{ categories: Category[] }>('/api/budget/categories'), staleTime: 60_000 });
}

const FIELD_LABEL: Record<string, string> = { amount: 'montant', merchant: 'commerçant', category: 'catégorie', date: 'date', currency: 'devise' };

export function DraftCard({
  draft,
  from,
  onChanged,
  selectable,
  selected,
  onSelect,
}: {
  draft: Draft;
  from: 'chat' | 'budget';
  onChanged: (d?: Draft) => void;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: (v: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dup, setDup] = useState<string[] | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const toast = useToast();
  const f = draft.fields;
  const unc = (k: string) => draft.uncertain.includes(k) || draft.missing.includes(k);

  async function confirm(force = false) {
    if (busy) return; // une double pression ne déclenche qu'un envoi
    setBusy(true);
    setError(null);
    try {
      const r = await api.post(`/api/drafts/${draft.id}/confirm${from === 'chat' ? '?from=chat' : ''}`, { force });
      setDone(r.remaining?.map((x: any) => x.text).join(' ') || 'Enregistrée.');
      setDup(null);
      toast(`Dépense enregistrée. ${r.remaining?.[0]?.text || ''}`);
      onChanged(r.draft);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setDup(e.data.duplicates.map((d: any) => d.label));
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    setBusy(true);
    try {
      onChanged(await api.post(`/api/drafts/${draft.id}/cancel`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const statusChip =
    draft.status === 'confirmed' ? <span className="chip ok">✓ Confirmée</span> : draft.status === 'cancelled' ? <span className="chip">{from === 'budget' ? 'Retirée' : 'Annulée'}</span> : null;

  return (
    <div className={`draft ${draft.status}`} data-testid="draft-card" data-draft-id={draft.id}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        {selectable && draft.status === 'pending' && <Check on={!!selected} onToggle={() => onSelect?.(!selected)} label="Sélectionner cette ligne" />}
        <div className="grow">
          <div className="draft-sum" data-testid="draft-summary">
            <span className={`amt${unc('amount') ? ' unc' : ''}`}>{f.amountCents ? `${money(f.amountCents)} ${f.currency}` : 'Montant ?'}</span>
            <span className="sep"> · </span>
            <span className={unc('merchant') ? 'unc' : ''}>{f.merchant || 'Commerçant ?'}</span>
            <span className="sep"> · </span>
            <span className={unc('category') ? 'unc' : ''}>{f.splits?.length ? `${f.splits.length} catégories` : draft.categoryLabel || 'Catégorie ?'}</span>
            <span className="sep"> · </span>
            <span className={unc('date') ? 'unc' : ''}>{f.date ? dayLabel(f.date) : 'Date ?'}</span>
            <span className="sep"> · </span>
            <span>{draft.budgetName}</span>
            {f.type === 'refund' && <span className="chip ok">Remboursement</span>}
          </div>
          {draft.rawText && draft.source === 'import' && <div className="tiny muted ellipsis">Lu : {draft.rawText}</div>}
          {draft.status === 'pending' && draft.uncertain.length > 0 && (
            <div className="tiny" style={{ color: 'var(--accent)' }}>
              À vérifier : {draft.uncertain.map((u) => FIELD_LABEL[u] || u).join(', ')}
            </div>
          )}
          {draft.status === 'pending' && f.currency !== 'CAD' && <div className="tiny" style={{ color: 'var(--accent)' }}>Montant en {f.currency} : indique le montant débité en CAD.</div>}
          {draft.status === 'pending' && draft.duplicates.length > 0 && (
            <div className="tiny" style={{ color: 'var(--danger)' }} data-testid="duplicate-warning">
              ⚠ Doublon possible : {draft.duplicates[0].label}
            </div>
          )}
          {draft.status === 'pending' && draft.importDuplicate && <div className="tiny" style={{ color: 'var(--danger)' }}>⚠ Cette image a déjà été importée.</div>}
        </div>
        {statusChip}
      </div>
      {done && draft.status === 'confirmed' && <div className="small" style={{ marginTop: 6 }}>{done}</div>}
      {error && <div className="error">{error}</div>}
      {dup && (
        <div className="banner danger" style={{ marginTop: 8, flexDirection: 'column', alignItems: 'stretch' }}>
          <div className="small">Cette dépense ressemble à : {dup.join(' ; ')}</div>
          <div className="row">
            <button className="btn small" onClick={() => setDup(null)}>
              Ne pas enregistrer
            </button>
            <button className="btn small danger" onClick={() => confirm(true)} disabled={busy}>
              Confirmer quand même
            </button>
          </div>
        </div>
      )}
      {editing && draft.status === 'pending' && <DraftEditor draft={draft} onSaved={(d) => (setEditing(false), onChanged(d))} />}
      {draft.status === 'pending' && !editing && (
        <div className="draft-actions">
          <button className="btn small primary" onClick={() => confirm(false)} disabled={busy || draft.missing.includes('amount') || draft.missing.includes('category')}>
            <Icon.check /> Confirmer
          </button>
          <button className="btn small" onClick={() => setEditing(true)}>
            <Icon.edit /> Modifier
          </button>
          <button className="btn small" onClick={cancel} disabled={busy}>
            {from === 'budget' ? 'Retirer' : 'Annuler'}
          </button>
        </div>
      )}
    </div>
  );
}

export function DraftEditor({ draft, onSaved }: { draft: Draft; onSaved: (d: Draft) => void }) {
  const cats = useCategories().data?.categories || [];
  const f = draft.fields;
  const [amount, setAmount] = useState(centsToInput(f.amountCents));
  const [merchant, setMerchant] = useState(f.merchant || '');
  const [date, setDate] = useState(f.date || '');
  const [budgetKey, setBudgetKey] = useState(f.budgetKey);
  const [categoryId, setCategoryId] = useState(f.categoryId || '');
  const [type, setType] = useState(f.type);
  const [split, setSplit] = useState<{ categoryId: string; amount: string }[] | null>(f.splits?.length ? f.splits.map((s) => ({ categoryId: s.categoryId, amount: centsToInput(s.amountCents) })) : null);
  const [error, setError] = useState<string | null>(null);
  const expenseCats = cats.filter((c) => c.kind === (type === 'income' ? 'income' : 'expense'));

  async function save() {
    const cents = parseMoney(amount);
    if (!cents || cents <= 0) return setError('Montant invalide');
    let splits: { categoryId: string; amountCents: number }[] | null = null;
    if (split) {
      splits = split.map((s) => ({ categoryId: s.categoryId, amountCents: parseMoney(s.amount) || 0 }));
      const total = splits.reduce((a, b) => a + b.amountCents, 0);
      if (total !== cents) return setError(`La répartition (${money(total)}) doit égaler ${money(cents)}`);
      if (splits.some((s) => !s.categoryId)) return setError('Choisis une catégorie pour chaque part');
    }
    try {
      const d = await api.patch<Draft>(`/api/drafts/${draft.id}`, {
        amountCents: cents,
        merchant: merchant.trim() || null,
        date,
        budgetKey,
        categoryId: split ? splits![0].categoryId : categoryId || null,
        splits,
        type,
        currency: 'CAD',
      });
      onSaved(d);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="form-grid" style={{ marginTop: 10 }}>
      <label className="field">
        Montant (CAD)
        <input className={`input${draft.uncertain.includes('amount') ? ' uncertain' : ''}`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Montant" />
      </label>
      <label className="field">
        Date
        <input className={`input${draft.uncertain.includes('date') ? ' uncertain' : ''}`} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <label className="field full">
        Commerçant
        <input className={`input${draft.uncertain.includes('merchant') ? ' uncertain' : ''}`} value={merchant} onChange={(e) => setMerchant(e.target.value)} aria-label="Commerçant" />
      </label>
      <label className="field">
        Budget
        <select className="input" value={budgetKey} onChange={(e) => (setBudgetKey(e.target.value as any), setCategoryId(''))}>
          <option value="perso">Personnel</option>
          <option value="mondaix">MONDAIX</option>
        </select>
      </label>
      <label className="field">
        Type
        <select className="input" value={type} onChange={(e) => setType(e.target.value as any)}>
          <option value="expense">Dépense</option>
          <option value="refund">Remboursement</option>
          <option value="income">Revenu</option>
        </select>
      </label>
      {!split ? (
        <label className="field full">
          Catégorie
          <select className={`input${draft.uncertain.includes('category') ? ' uncertain' : ''}`} value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="Catégorie">
            <option value="">— Choisir —</option>
            {expenseCats
              .filter((c) => c.budgetKey === budgetKey)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
          </select>
        </label>
      ) : (
        <div className="full stack" style={{ gap: 6 }}>
          <div className="small muted">Répartition entre catégories (personnel et MONDAIX possibles)</div>
          {split.map((s, i) => (
            <div className="split-row" key={i}>
              <select className="input" value={s.categoryId} onChange={(e) => setSplit(split.map((x, j) => (j === i ? { ...x, categoryId: e.target.value } : x)))} aria-label={`Catégorie ${i + 1}`}>
                <option value="">— Catégorie —</option>
                {expenseCats.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.budgetName} · {c.label}
                  </option>
                ))}
              </select>
              <input className="input" inputMode="decimal" value={s.amount} onChange={(e) => setSplit(split.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} aria-label={`Montant ${i + 1}`} />
              <button className="icon-btn" onClick={() => setSplit(split.length > 2 ? split.filter((_, j) => j !== i) : null)} aria-label="Retirer la part">
                <Icon.close />
              </button>
            </div>
          ))}
          <button className="btn small" onClick={() => setSplit([...split, { categoryId: '', amount: '' }])}>
            + Ajouter une part
          </button>
        </div>
      )}
      {!split && (
        <button className="btn small full" onClick={() => setSplit([{ categoryId: categoryId, amount: amount }, { categoryId: '', amount: '' }])}>
          Répartir entre plusieurs catégories
        </button>
      )}
      {error && <div className="error full">{error}</div>}
      <button className="btn primary full" onClick={save}>
        Enregistrer les modifications
      </button>
    </div>
  );
}

/** Saisie manuelle : utilisée quand l'image est illisible ou que la lecture échoue. */
export function ManualExpenseForm({ importId, fromChat, onCreated }: { importId?: string | null; fromChat?: boolean; onCreated: (d: Draft) => void }) {
  const cats = useCategories().data?.categories || [];
  const [amount, setAmount] = useState('');
  const [merchant, setMerchant] = useState('');
  const [date, setDate] = useState(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }));
  const [budgetKey, setBudgetKey] = useState('perso');
  const [categoryId, setCategoryId] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const cents = parseMoney(amount);
    if (!cents) return setError('Indique le montant');
    try {
      const d = await api.post<Draft>('/api/drafts', { amountCents: cents, merchant, date, budgetKey, categoryId: categoryId || null, importId, fromChat });
      onCreated(d);
      setAmount('');
      setMerchant('');
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <form className="form-grid card" onSubmit={submit} data-testid="manual-form">
      <div className="full">
        <h3>Saisie manuelle</h3>
      </div>
      <label className="field">
        Montant (CAD)
        <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Montant" autoFocus />
      </label>
      <label className="field">
        Date
        <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <label className="field full">
        Commerçant
        <input className="input" value={merchant} onChange={(e) => setMerchant(e.target.value)} aria-label="Commerçant" />
      </label>
      <label className="field">
        Budget
        <select className="input" value={budgetKey} onChange={(e) => (setBudgetKey(e.target.value), setCategoryId(''))}>
          <option value="perso">Personnel</option>
          <option value="mondaix">MONDAIX</option>
        </select>
      </label>
      <label className="field">
        Catégorie
        <select className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="Catégorie">
          <option value="">Suggérer pour moi</option>
          {cats
            .filter((c) => c.kind === 'expense' && c.budgetKey === budgetKey)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
        </select>
      </label>
      {error && <div className="error full">{error}</div>}
      <button className="btn primary full" type="submit">
        Créer la fiche
      </button>
    </form>
  );
}
