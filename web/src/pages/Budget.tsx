import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { DateTime } from 'luxon';
import { api } from '../lib/api';
import { centsToInput, dayLabel, money, monthLabel, parseMoney, todayIso } from '../lib/format';
import { imageForm } from '../lib/image';
import { useApp } from '../App';
import { Icon, Progress, Seg, Sheet, useToast } from '../components/ui';
import { useCategories } from '../components/DraftCard';

type View = 'perso' | 'mondaix' | 'all';

export function Budget() {
  const { openChat, openPending } = useApp();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const [view, setView] = useState<View>((params.get('vue') as View) || 'all');
  const tab = params.get('tab') || 'categories';
  const [envelope, setEnvelope] = useState<any | null>(null);
  const [txEdit, setTxEdit] = useState<any | null>(null);
  const [newTx, setNewTx] = useState<'expense' | 'income' | null>(null);
  const [recEdit, setRecEdit] = useState<any | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);

  const summary = useQuery({ queryKey: ['summary', month, view], queryFn: () => api.get<any>(`/api/budget/summary?month=${month}&view=${view}`) });
  const txs = useQuery({ queryKey: ['transactions', month, view], queryFn: () => api.get<any[]>(`/api/transactions?month=${month}&view=${view}`), enabled: tab === 'transactions' });
  const rec = useQuery({ queryKey: ['recurring'], queryFn: () => api.get<any[]>('/api/recurring'), enabled: tab === 'recurrents' });
  const payday = useQuery({ queryKey: ['payday'], queryFn: () => api.get<any>('/api/budget/until-payday') });
  const s = summary.data;

  async function upload(file?: File) {
    if (!file) return;
    setUploading(true);
    try {
      const r = await api.upload<any>('/api/imports', await imageForm(file));
      openPending(r.import.id);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setUploading(false);
    }
  }
  const setTab = (t: string) => {
    params.set('tab', t);
    setParams(params, { replace: true });
  };
  const shiftMonth = (n: number) => setMonth(DateTime.fromISO(month + '-01').plus({ months: n }).toFormat('yyyy-LL'));

  return (
    <>
      <div className="page-head">
        <h1>Budget</h1>
        <div className="row">
          <button className="icon-btn" onClick={() => shiftMonth(-1)} aria-label="Mois précédent">
            <Icon.chevronL />
          </button>
          <strong>{monthLabel(month)}</strong>
          <button className="icon-btn" onClick={() => shiftMonth(1)} aria-label="Mois suivant">
            <Icon.chevronR />
          </button>
        </div>
      </div>
      <Seg
        full
        label="Vue du budget"
        value={view}
        options={[
          ['perso', 'Personnel'],
          ['mondaix', 'MONDAIX'],
          ['all', 'Combiné'],
        ]}
        onChange={setView}
      />

      {s && (
        <section className="card" style={{ marginTop: 12 }}>
          <div className="stats">
            <div className="stat">
              <span className="tiny muted">Prévu</span>
              <span className="v">{money(s.totals.planned)}</span>
            </div>
            <div className="stat">
              <span className="tiny muted">Dépensé</span>
              <span className="v" data-testid="total-spent">{money(s.totals.spent)}</span>
            </div>
            <div className="stat">
              <span className="tiny muted">Reste</span>
              <span className="v" style={{ color: s.totals.remaining < 0 ? 'var(--danger)' : undefined }}>
                {money(s.totals.remaining)}
              </span>
            </div>
          </div>
          <Progress percent={s.totals.planned ? (s.totals.spent / s.totals.planned) * 100 : 0} tone={s.totals.spent > s.totals.planned ? 'over' : undefined} />
          <div className="row between small" style={{ marginTop: 8 }}>
            <span className="muted">
              Revenus : <strong>{money(s.totals.income)}</strong> / {money(s.totals.incomePlanned)} prévus
            </span>
          </div>
        </section>
      )}

      <div className="quick-actions" style={{ marginTop: 12 }}>
        <button className="btn primary" onClick={openChat}>
          <Icon.chat /> Dépense
        </button>
        <button className="btn" onClick={() => fileRef.current?.click()} disabled={uploading} data-testid="import-button">
          <Icon.upload /> {uploading ? 'Lecture…' : 'Importer'}
        </button>
        <button className="btn" onClick={() => camRef.current?.click()} disabled={uploading}>
          <Icon.camera /> Photo
        </button>
      </div>
      <input ref={fileRef} type="file" accept="image/*" hidden data-testid="budget-file" onChange={(e) => (upload(e.target.files?.[0]), (e.target.value = ''))} />
      <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => (upload(e.target.files?.[0]), (e.target.value = ''))} />
      <div className="row wrap" style={{ marginTop: 8 }}>
        <button className="btn small" onClick={() => openPending()}>
          À valider ({s?.pendingDrafts ?? 0})
        </button>
        <button className="btn small" onClick={() => setNewTx('income')}>
          + Revenu
        </button>
        <button className="btn small" onClick={() => setNewTx('expense')}>
          + Saisie détaillée
        </button>
      </div>

      {payday.data?.configured && (
        <section className="card" style={{ marginTop: 12 }}>
          <div className="row between">
            <h3 style={{ margin: 0 }}>Jusqu’à la prochaine paie</h3>
            <span className="tiny muted">{dayLabel(payday.data.payday)}</span>
          </div>
          <div className="small">
            Factures prévues d’ici là : <strong>{money(payday.data.billsTotal)}</strong>
            {payday.data.bills.length ? ` (${payday.data.bills.map((b: any) => b.name).join(', ')})` : ''}. Reste dans tes enveloppes personnelles :{' '}
            <strong>{money(payday.data.envelopeRemaining)}</strong>.
          </div>
        </section>
      )}

      <div style={{ margin: '16px 0 8px' }}>
        <Seg
          full
          label="Section"
          value={tab}
          options={[
            ['categories', 'Catégories'],
            ['transactions', 'Transactions'],
            ['recurrents', 'Récurrents'],
          ]}
          onChange={setTab}
        />
      </div>

      {tab === 'categories' && s && (
        <section className="card">
          <ul className="list" data-testid="categories">
            {s.categories.map((c: any) => {
              const pct = c.planned ? (c.spent / c.planned) * 100 : c.spent ? 100 : 0;
              return (
                <li key={c.id} className="clickable" onClick={() => setEnvelope(c)} data-testid="category-row" data-label={c.label} data-budget={c.budgetKey}>
                  <div className="grow">
                    <div className="row between">
                      <span className="small" style={{ fontWeight: 600 }}>
                        {c.label}
                        {view === 'all' && <span className="tiny muted"> · {c.budgetName}</span>}
                      </span>
                      <span className="tiny" data-testid="category-remaining" style={{ color: c.remaining < 0 ? 'var(--danger)' : 'var(--muted)' }}>
                        {money(c.spent)} / {money(c.planned)} · reste {money(c.remaining)}
                      </span>
                    </div>
                    <Progress percent={pct} tone={pct > 100 ? 'over' : pct > 85 ? 'warn' : undefined} />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {tab === 'transactions' && (
        <section className="card">
          {txs.data?.length === 0 && <div className="empty">Aucune transaction ce mois-ci.</div>}
          <ul className="list" data-testid="transactions">
            {txs.data?.map((t) => (
              <li key={t.id} className="clickable" onClick={() => setTxEdit(t)} data-testid="tx-row" data-merchant={t.merchant}>
                <div className="grow">
                  <div className="row between">
                    <span style={{ fontWeight: 600 }} className="ellipsis">
                      {t.merchant || 'Sans commerçant'}
                    </span>
                    <span style={{ fontWeight: 700, color: t.type === 'expense' ? undefined : 'var(--ok)' }}>
                      {t.type === 'expense' ? '' : '+'}
                      {money(t.amountCents)}
                    </span>
                  </div>
                  <div className="tiny muted">
                    {dayLabel(t.date)} · {t.splits.map((x: any) => x.label).join(' + ')} · {t.budgetKeys.map((k: string) => (k === 'mondaix' ? 'MONDAIX' : 'Personnel')).join(' + ')}
                    {t.type === 'refund' ? ' · remboursement' : ''}
                    {t.refundedCents ? ` · remboursé ${money(t.refundedCents)}` : ''}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tab === 'recurrents' && (
        <section className="card">
          <div className="card-title">
            <h2>Paiements récurrents</h2>
            <button className="btn small" onClick={() => setRecEdit({})}>
              + Ajouter
            </button>
          </div>
          <ul className="list">
            {rec.data?.map((r) => (
              <RecurringRow key={r.id} r={r} onEdit={() => setRecEdit(r)} />
            ))}
          </ul>
        </section>
      )}

      {envelope && <EnvelopeEditor cat={envelope} month={month} onClose={() => setEnvelope(null)} />}
      {txEdit && <TransactionEditor tx={txEdit} onClose={() => setTxEdit(null)} />}
      {newTx && <TransactionEditor tx={{ type: newTx, date: todayIso(), merchant: '', amountCents: null, splits: [] }} onClose={() => setNewTx(null)} />}
      {recEdit && <RecurringEditor r={recEdit} onClose={() => setRecEdit(null)} />}
    </>
  );
}

function RecurringRow({ r, onEdit }: { r: any; onEdit: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function pay(e: React.MouseEvent) {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      await api.post(`/api/recurring/${r.id}/pay`, { dueDate: r.nextDate });
      toast(r.kind === 'income' ? 'Revenu enregistré' : 'Paiement enregistré');
      qc.invalidateQueries();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className="clickable" onClick={onEdit}>
      <div className="grow">
        <div style={{ fontWeight: 600 }}>
          {r.name} <span className="tiny muted">{r.kind === 'income' ? '(revenu)' : ''}</span>
        </div>
        <div className="tiny muted">
          {money(r.amountCents)} · {({ weekly: 'chaque semaine', biweekly: 'aux deux semaines', monthly: 'chaque mois', yearly: 'chaque année' } as any)[r.frequency]} · prochain : {dayLabel(r.nextDate)}
          {r.reminderDays !== null ? ` · rappel ${r.reminderDays} j avant` : ''}
        </div>
      </div>
      <button className="btn small" onClick={pay} disabled={busy}>
        {r.kind === 'income' ? 'Reçu' : 'Payé'}
      </button>
    </li>
  );
}

function EnvelopeEditor({ cat, month, onClose }: { cat: any; month: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState(centsToInput(cat.planned));
  const [future, setFuture] = useState(false);
  const txs = useQuery({ queryKey: ['transactions', month, 'cat', cat.id], queryFn: () => api.get<any[]>(`/api/transactions?month=${month}&categoryId=${cat.id}`) });
  async function save() {
    await api.put('/api/budget/allocations', { categoryId: cat.id, month, amountCents: parseMoney(amount) || 0, applyToFuture: future });
    qc.invalidateQueries();
    onClose();
  }
  return (
    <Sheet title={cat.label} onClose={onClose} footer={<button className="btn primary block" onClick={save}>Enregistrer l’enveloppe</button>}>
      <div className="stack">
        <div className="small muted">
          {cat.budgetName} · {monthLabel(month)} · dépensé {money(cat.spent)} · reste {money(cat.remaining)}
        </div>
        <label className="field">
          Montant prévu ce mois-ci
          <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Montant prévu" />
        </label>
        <label className="row small">
          <input type="checkbox" checked={future} onChange={(e) => setFuture(e.target.checked)} /> Appliquer aussi aux mois suivants
        </label>
        <h3>Transactions</h3>
        <ul className="list">
          {txs.data?.map((t) => (
            <li key={t.id}>
              <span className="grow small">
                {t.merchant} <span className="tiny muted">{dayLabel(t.date)}</span>
              </span>
              <span className="small">{money(t.splits.find((x: any) => x.categoryId === cat.id)?.amountCents)}</span>
            </li>
          ))}
          {txs.data?.length === 0 && <li className="small muted">Aucune transaction.</li>}
        </ul>
      </div>
    </Sheet>
  );
}

/** Modifier une transaction confirmée, la répartir entre catégories, enregistrer un remboursement ou la supprimer. */
function TransactionEditor({ tx, onClose }: { tx: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const cats = useCategories().data?.categories || [];
  const isNew = !tx.id;
  const [date, setDate] = useState(tx.date);
  const [merchant, setMerchant] = useState(tx.merchant);
  const [amount, setAmount] = useState(centsToInput(tx.amountCents));
  const [note, setNote] = useState(tx.note || '');
  const [splits, setSplits] = useState<{ categoryId: string; amount: string }[]>(tx.splits.length ? tx.splits.map((s: any) => ({ categoryId: s.categoryId, amount: centsToInput(s.amountCents) })) : [{ categoryId: '', amount: '' }]);
  const [refund, setRefund] = useState('');
  const [error, setError] = useState<string | null>(null);
  const kind = tx.type === 'income' ? 'income' : 'expense';
  const options = cats.filter((c) => c.kind === kind);

  async function save() {
    const cents = parseMoney(amount);
    if (!cents) return setError('Montant invalide');
    const sp = splits.length === 1 ? [{ categoryId: splits[0].categoryId, amountCents: cents }] : splits.map((s) => ({ categoryId: s.categoryId, amountCents: parseMoney(s.amount) || 0 }));
    if (sp.some((s) => !s.categoryId)) return setError('Choisis une catégorie');
    try {
      const body = { date, merchant, amountCents: cents, note, splits: sp, type: tx.type };
      if (isNew) await api.post('/api/transactions', body);
      else await api.patch(`/api/transactions/${tx.id}`, body);
      qc.invalidateQueries();
      toast('Transaction enregistrée');
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function doRefund() {
    const cents = parseMoney(refund);
    if (!cents) return setError('Montant du remboursement invalide');
    try {
      await api.post(`/api/transactions/${tx.id}/refund`, { amountCents: cents });
      qc.invalidateQueries();
      toast(`Remboursement de ${money(cents)} enregistré`);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function del() {
    if (!confirm('Supprimer cette transaction ?')) return;
    await api.del(`/api/transactions/${tx.id}`);
    qc.invalidateQueries();
    onClose();
  }
  return (
    <Sheet
      title={isNew ? (kind === 'income' ? 'Nouveau revenu' : 'Nouvelle dépense') : 'Transaction'}
      onClose={onClose}
      footer={
        <>
          {!isNew && (
            <button className="btn danger" onClick={del} aria-label="Supprimer">
              <Icon.trash />
            </button>
          )}
          <button className="btn primary grow" onClick={save}>
            Enregistrer
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field">
          Montant (CAD)
          <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Montant" />
        </label>
        <label className="field">
          Date
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field full">
          {kind === 'income' ? 'Source' : 'Commerçant'}
          <input className="input" value={merchant} onChange={(e) => setMerchant(e.target.value)} aria-label="Commerçant" />
        </label>
        <div className="full stack" style={{ gap: 6 }}>
          <div className="small muted" style={{ fontWeight: 600 }}>
            {splits.length > 1 ? 'Répartition' : 'Catégorie'}
          </div>
          {splits.map((s, i) => (
            <div className={splits.length > 1 ? 'split-row' : ''} key={i}>
              <select className="input" value={s.categoryId} onChange={(e) => setSplits(splits.map((x, j) => (j === i ? { ...x, categoryId: e.target.value } : x)))} aria-label={`Catégorie ${i + 1}`}>
                <option value="">— Choisir —</option>
                {options.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.budgetName} · {c.label}
                  </option>
                ))}
              </select>
              {splits.length > 1 && (
                <>
                  <input className="input" inputMode="decimal" value={s.amount} onChange={(e) => setSplits(splits.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} aria-label={`Montant ${i + 1}`} />
                  <button className="icon-btn" onClick={() => setSplits(splits.filter((_, j) => j !== i))} aria-label="Retirer la part">
                    <Icon.close />
                  </button>
                </>
              )}
            </div>
          ))}
          {kind === 'expense' && (
            <button className="btn small" onClick={() => setSplits(splits.length === 1 ? [{ ...splits[0], amount }, { categoryId: '', amount: '' }] : [...splits, { categoryId: '', amount: '' }])}>
              {splits.length === 1 ? 'Répartir entre plusieurs catégories' : '+ Ajouter une part'}
            </button>
          )}
        </div>
        <label className="field full">
          Note
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {!isNew && tx.type === 'expense' && (
          <div className="full card" style={{ boxShadow: 'none' }}>
            <h3>Enregistrer un remboursement</h3>
            <div className="tiny muted" style={{ marginBottom: 6 }}>
              Déjà remboursé : {money(tx.refundedCents)} sur {money(tx.amountCents)}. Le remboursement est réparti sur les mêmes catégories.
            </div>
            <div className="row">
              <input className="input" inputMode="decimal" value={refund} onChange={(e) => setRefund(e.target.value)} placeholder="Montant" aria-label="Montant du remboursement" />
              <button className="btn" onClick={doRefund}>
                Rembourser
              </button>
            </div>
          </div>
        )}
        {error && <div className="error full">{error}</div>}
      </div>
    </Sheet>
  );
}

function RecurringEditor({ r, onClose }: { r: any; onClose: () => void }) {
  const qc = useQueryClient();
  const cats = useCategories().data?.categories || [];
  const isNew = !r.id;
  const [f, setF] = useState({
    name: r.name || '',
    amount: centsToInput(r.amountCents),
    kind: r.kind || 'expense',
    categoryId: r.categoryId || '',
    frequency: r.frequency || 'monthly',
    nextDate: r.nextDate || todayIso(),
    reminderDays: r.reminderDays ?? 2,
    active: r.active ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  async function save() {
    const body = { ...f, amountCents: parseMoney(f.amount), merchant: f.name, reminderDays: f.reminderDays === '' ? null : Number(f.reminderDays) };
    try {
      if (isNew) await api.post('/api/recurring', body);
      else await api.patch(`/api/recurring/${r.id}`, body);
      qc.invalidateQueries();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function del() {
    await api.del(`/api/recurring/${r.id}`);
    qc.invalidateQueries();
    onClose();
  }
  return (
    <Sheet title={isNew ? 'Paiement récurrent' : f.name} onClose={onClose} footer={<>{!isNew && <button className="btn danger" onClick={del} aria-label="Supprimer"><Icon.trash /></button>}<button className="btn primary grow" onClick={save}>Enregistrer</button></>}>
      <div className="form-grid">
        <label className="field full">
          Nom
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>
        <label className="field">
          Montant
          <input className="input" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </label>
        <label className="field">
          Type
          <select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, categoryId: '' })}>
            <option value="expense">Facture / dépense</option>
            <option value="income">Revenu (paie)</option>
          </select>
        </label>
        <label className="field full">
          Catégorie
          <select className="input" value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>
            <option value="">— Choisir —</option>
            {cats
              .filter((c) => c.kind === f.kind)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.budgetName} · {c.label}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          Fréquence
          <select className="input" value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}>
            <option value="weekly">Chaque semaine</option>
            <option value="biweekly">Aux deux semaines</option>
            <option value="monthly">Chaque mois</option>
            <option value="yearly">Chaque année</option>
          </select>
        </label>
        <label className="field">
          Prochaine date
          <input className="input" type="date" value={f.nextDate} onChange={(e) => setF({ ...f, nextDate: e.target.value })} />
        </label>
        {f.kind === 'expense' && (
          <label className="field">
            Rappel (jours avant)
            <input className="input" type="number" min={0} value={f.reminderDays} onChange={(e) => setF({ ...f, reminderDays: e.target.value as any })} />
          </label>
        )}
        {error && <div className="error full">{error}</div>}
      </div>
    </Sheet>
  );
}
