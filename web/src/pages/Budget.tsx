import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { DateTime } from 'luxon';
import { api } from '../lib/api';
import { TZ, centsToInput, dayLabel, money, monthLabel, parseMoney, todayIso } from '../lib/format';
import { imageForm } from '../lib/image';
import { useApp } from '../App';
import { Icon, Progress, Ring, Seg, Sheet, useToast } from '../components/ui';
import { useCategories } from '../components/DraftCard';

type View = 'perso' | 'mondaix' | 'all';

export function Budget() {
  const { openChat, openPending } = useApp();
  const toast = useToast();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const [view, setView] = useState<View>((params.get('vue') as View) || 'all');
  const tab = params.get('tab') || 'transactions';
  const [envelope, setEnvelope] = useState<any | null>(null);
  const [txEdit, setTxEdit] = useState<any | null>(null);
  const [newTx, setNewTx] = useState<'expense' | 'income' | null>(null);
  const [recEdit, setRecEdit] = useState<any | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
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
  async function remove(t: any) {
    await api.del(`/api/transactions/${t.id}`);
    setConfirmDel(null);
    toast(`${t.merchant || 'Dépense'} supprimée`);
    qc.invalidateQueries();
  }

  // Dépenses regroupées par jour
  const groups: [string, any[]][] = [];
  for (const t of txs.data || []) {
    const g = groups.find(([d]) => d === t.date);
    if (g) g[1].push(t);
    else groups.push([t.date, [t]]);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Mes finances</div>
          <h1>Budget</h1>
        </div>
      </div>

      {s && <BudgetHero s={s} month={month} onShift={shiftMonth} />}

      <div className="budget-tools">
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
      </div>

      <QuickExpense onAdded={() => qc.invalidateQueries()} />

      <div className="tool-row">
        <button className="tool" onClick={openChat}>
          <Icon.chat /> <span>Discuter</span>
        </button>
        <button className="tool" onClick={() => fileRef.current?.click()} disabled={uploading} data-testid="import-button">
          <Icon.upload /> <span>{uploading ? 'Lecture…' : 'Importer'}</span>
        </button>
        <button className="tool" onClick={() => camRef.current?.click()} disabled={uploading}>
          <Icon.camera /> <span>Photo</span>
        </button>
        <button className="tool" onClick={() => setNewTx('income')}>
          <Icon.plus /> <span>Revenu</span>
        </button>
        <button className="tool" onClick={() => openPending()}>
          <Icon.check /> <span>À valider{s?.pendingDrafts ? ` (${s.pendingDrafts})` : ''}</span>
        </button>
      </div>
      <input ref={fileRef} type="file" accept="image/*" hidden data-testid="budget-file" onChange={(e) => (upload(e.target.files?.[0]), (e.target.value = ''))} />
      <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => (upload(e.target.files?.[0]), (e.target.value = ''))} />

      {payday.data?.configured && (
        <section className="card soft" style={{ marginTop: 12 }}>
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

      <div style={{ margin: '18px 0 10px' }}>
        <Seg
          full
          label="Section"
          value={tab}
          options={[
            ['transactions', 'Dépenses'],
            ['categories', 'Enveloppes'],
            ['recurrents', 'Récurrents'],
          ]}
          onChange={setTab}
        />
      </div>

      {tab === 'categories' && s && (
        <section className="card">
          <p className="tiny muted" style={{ margin: '0 0 8px' }}>
            Touche une enveloppe pour ajuster son montant.
          </p>
          <ul className="list" data-testid="categories">
            {s.categories.map((c: any) => {
              const pct = c.planned ? (c.spent / c.planned) * 100 : c.spent ? 100 : 0;
              return (
                <li key={c.id} className="clickable envelope-row" onClick={() => setEnvelope(c)} data-testid="category-row" data-label={c.label} data-budget={c.budgetKey}>
                  <CategoryTile label={c.label} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row between">
                      <span className="small ellipsis" style={{ fontWeight: 600 }}>
                        {c.name || c.label}
                        {view === 'all' && <span className="tiny muted"> · {c.budgetName}</span>}
                      </span>
                      <span className="tiny" data-testid="category-remaining" style={{ color: c.remaining < 0 ? 'var(--danger)' : 'var(--muted)' }}>
                        {money(c.spent)} / {money(c.planned)} · reste {money(c.remaining)}
                      </span>
                    </div>
                    <Progress percent={pct} tone={pct > 100 ? 'over' : pct > 85 ? 'warn' : undefined} />
                  </div>
                  <button className="icon-btn sm" aria-label={`Ajuster l’enveloppe ${c.label}`} onClick={(e) => (e.stopPropagation(), setEnvelope(c))}>
                    <Icon.edit />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {tab === 'transactions' && (
        <section className="card tx-card">
          {txs.data?.length === 0 && <div className="empty">Aucune dépense ce mois-ci. Écris-en une ci-dessus.</div>}
          <div data-testid="transactions">
            {groups.map(([date, list]) => (
              <div key={date} className="tx-group">
                <div className="tx-day">
                  <span>{dayLabel(date)}</span>
                  <span>{money(list.filter((t) => t.type === 'expense').reduce((a, t) => a + t.amountCents, 0))}</span>
                </div>
                <ul className="list">
                  {list.map((t) =>
                    confirmDel === t.id ? (
                      <li key={t.id} className="tx-confirm" data-testid="tx-row" data-merchant={t.merchant}>
                        <span className="grow small">
                          Supprimer <strong>{t.merchant || 'cette dépense'}</strong> ({money(t.amountCents)}) ?
                        </span>
                        <button className="btn small danger-solid" onClick={() => remove(t)}>
                          Supprimer
                        </button>
                        <button className="btn small ghost" onClick={() => setConfirmDel(null)}>
                          Annuler
                        </button>
                      </li>
                    ) : (
                      <li key={t.id} className="tx-row" data-testid="tx-row" data-merchant={t.merchant}>
                        <CategoryTile label={t.splits[0]?.label || ''} />
                        <button className="tx-main" onClick={() => setTxEdit(t)}>
                          <span className="row between" style={{ gap: 8 }}>
                            <span className="ellipsis" style={{ fontWeight: 600 }}>
                              {t.merchant || 'Sans commerçant'}
                            </span>
                            <span className="tx-amount" style={{ color: t.type === 'expense' ? undefined : 'var(--ok)' }}>
                              {t.type === 'expense' ? '' : '+'}
                              {money(t.amountCents)}
                            </span>
                          </span>
                          <span className="tiny muted ellipsis block">
                            {t.splits.map((x: any) => x.label.split(' / ').pop()).join(' + ')}
                            {view === 'all' ? ` · ${t.budgetKeys.map((k: string) => (k === 'mondaix' ? 'MONDAIX' : 'Personnel')).join(' + ')}` : ''}
                            {t.type === 'refund' ? ' · remboursement' : ''}
                            {t.refundedCents ? ` · remboursé ${money(t.refundedCents)}` : ''}
                          </span>
                        </button>
                        <span className="tx-actions">
                          <button className="icon-btn sm" aria-label={`Modifier ${t.merchant || 'la dépense'}`} onClick={() => setTxEdit(t)}>
                            <Icon.edit />
                          </button>
                          <button className="icon-btn sm danger" aria-label={`Supprimer ${t.merchant || 'la dépense'}`} onClick={() => setConfirmDel(t.id)}>
                            <Icon.trash />
                          </button>
                        </span>
                      </li>
                    ),
                  )}
                </ul>
              </div>
            ))}
          </div>
          <button className="btn small ghost" style={{ marginTop: 8 }} onClick={() => setNewTx('expense')}>
            + Saisie détaillée (plusieurs catégories)
          </button>
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

const GROUP_ICON: Record<string, keyof typeof Icon> = {
  Logement: 'home', Alimentation: 'cart', Transport: 'car', Santé: 'heart', Loisirs: 'film', Formation: 'book', Achats: 'bag', Divers: 'dots',
  Revenus: 'wallet', Assurances: 'shield', Famille: 'users', Dettes: 'card', Produits: 'box', Marketing: 'megaphone', Outils: 'briefcase', Logistique: 'truck', Administration: 'briefcase',
};
const GROUP_TONE: Record<string, string> = { Logement: 'blue', Alimentation: 'green', Transport: 'amber', Santé: 'rose', Loisirs: 'plum', Formation: 'teal', Achats: 'amber', Revenus: 'green', Assurances: 'teal', Famille: 'rose', Dettes: 'rose' };

/** Pastille d'icône selon le groupe de la catégorie (« Alimentation / Épicerie » → panier). */
export function CategoryTile({ label }: { label: string }) {
  const grp = (label || '').split(' / ')[0];
  const I = Icon[GROUP_ICON[grp] || 'dots'];
  return (
    <span className={`cat-tile pc-${GROUP_TONE[grp] || 'blue'}`} aria-hidden="true">
      <I />
    </span>
  );
}

/** Fenêtre du budget : ce qui reste, jauge, rythme par jour, revenus. */
function BudgetHero({ s, month, onShift }: { s: any; month: string; onShift: (n: number) => void }) {
  const { planned, spent, remaining, income, incomePlanned } = s.totals;
  const pct = planned ? Math.round((spent / planned) * 100) : 0;
  const now = DateTime.now().setZone(TZ);
  const isCurrent = now.toFormat('yyyy-LL') === month;
  const daysLeft = isCurrent ? Math.max(1, Math.round(now.endOf('month').diff(now.startOf('day'), 'days').days)) : 0;
  const elapsed = isCurrent ? now.day / now.daysInMonth! : 1;
  const over = remaining < 0;
  const status = over ? 'Budget dépassé' : !isCurrent ? (DateTime.fromISO(month + '-01') > now ? 'Mois à venir' : 'Mois terminé') : spent / Math.max(1, planned) > elapsed + 0.1 ? 'Rythme un peu rapide' : 'Dans les temps';
  const tone = over ? 'over' : status === 'Rythme un peu rapide' ? 'warn' : 'ok';
  return (
    <section className="hero budget-hero" aria-label="Mon budget du mois" data-testid="budget-hero">
      <div className="hero-top">
        <button className="icon-btn" onClick={() => onShift(-1)} aria-label="Mois précédent">
          <Icon.chevronL />
        </button>
        <strong>{monthLabel(month)}</strong>
        <button className="icon-btn" onClick={() => onShift(1)} aria-label="Mois suivant">
          <Icon.chevronR />
        </button>
      </div>
      <div className="hero-body">
        <Ring percent={pct} tone={tone} label={`${pct} %`} sub="dépensé" />
        <div className="hero-figures">
          <span className="hero-label">{over ? 'Dépassement' : 'Il te reste'}</span>
          <span className={`hero-amount${over ? ' over' : ''}`}>{money(Math.abs(remaining))}</span>
          <span className="small muted">
            <span data-testid="total-spent">{money(spent)}</span> dépensés sur {money(planned)} prévus
          </span>
          <span className={`status-chip ${tone}`}>{status}</span>
        </div>
      </div>
      <div className="hero-foot">
        {isCurrent && !over && (
          <div>
            <span className="tiny muted block">Par jour jusqu’à la fin du mois</span>
            <strong>≈ {money(Math.floor(remaining / daysLeft))}</strong> <span className="tiny muted">· {daysLeft} j</span>
          </div>
        )}
        <div>
          <span className="tiny muted block">Revenus du mois</span>
          <strong>{money(income)}</strong> <span className="tiny muted">/ {money(incomePlanned)} prévus</span>
        </div>
      </div>
    </section>
  );
}

type Preview = { amountCents: number; merchant: string | null; date: string; dateLabel: string; categoryId: string | null; categoryConfident: boolean; categories: { id: string; label: string }[] };

/** Saisie rapide : une phrase → montant, catégorie, commerçant, date à vérifier → Ajouter. */
function QuickExpense({ onAdded }: { onAdded: () => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [p, setP] = useState<Preview | null>(null);
  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [merchant, setMerchant] = useState('');
  const [date, setDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function analyse(e?: React.FormEvent) {
    e?.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<Preview>('/api/expenses/preview', { text });
      setP(r);
      setAmount(centsToInput(r.amountCents));
      setCategoryId(r.categoryId || '');
      setMerchant(r.merchant || '');
      setDate(r.date);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function add() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/expenses', { amountCents: parseMoney(amount), categoryId, merchant, date });
      toast(`Ajouté : ${merchant || 'dépense'} · ${money(parseMoney(amount) || 0)}`);
      setP(null);
      setText('');
      onAdded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={`quick-expense${p ? ' open' : ''}`} aria-label="Saisie rapide d’une dépense">
      {!p ? (
        <form className="qe-bar" onSubmit={analyse}>
          <Icon.wallet aria-hidden="true" />
          <label className="sr-only" htmlFor="qe-input">
            Ajouter une dépense
          </label>
          <input id="qe-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Ajouter une dépense : 12 $ café ce matin…" autoComplete="off" />
          <button className="btn small primary" disabled={!text.trim() || busy}>
            {busy ? '…' : 'Analyser'}
          </button>
        </form>
      ) : (
        <div className="qe-review" data-testid="quick-expense-review">
          <div className="row between">
            <strong>Vérifie avant d’ajouter</strong>
            <button className="icon-btn sm" aria-label="Annuler la saisie" onClick={() => setP(null)}>
              <Icon.close />
            </button>
          </div>
          <div className="qe-grid">
            <label className="field">
              Montant
              <span className="money-input">
                <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Montant de la dépense" />
                <span aria-hidden="true">$</span>
              </span>
            </label>
            <label className="field">
              Catégorie {!p.categoryConfident && <span className="tag-warn">à vérifier</span>}
              <select className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="Catégorie de la dépense">
                {p.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Commerçant
              <input className="input" value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="Facultatif" />
            </label>
            <label className="field">
              Date
              <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
          </div>
          <button className="btn primary block" onClick={add} disabled={busy || !parseMoney(amount) || !categoryId}>
            Ajouter la dépense
          </button>
        </div>
      )}
      {error && <div className="error" style={{ marginTop: 6 }}>{error}</div>}
    </section>
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
          {cat.budgetName} · {monthLabel(month)} · dépensé {money(cat.spent)}
        </div>
        <div className="envelope-adjust">
          <span className="field-label">Montant prévu ce mois-ci</span>
          <div className="stepper">
            {[-50, -10].map((d) => (
              <button key={d} type="button" className="step-btn" onClick={() => setAmount(centsToInput(Math.max(0, (parseMoney(amount) || 0) + d * 100)))} aria-label={`Retirer ${-d} $`}>
                {d}
              </button>
            ))}
            <span className="money-input grow">
              <input className="input lg center" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Montant prévu" />
              <span aria-hidden="true">$</span>
            </span>
            {[10, 50].map((d) => (
              <button key={d} type="button" className="step-btn" onClick={() => setAmount(centsToInput((parseMoney(amount) || 0) + d * 100))} aria-label={`Ajouter ${d} $`}>
                +{d}
              </button>
            ))}
          </div>
          {(() => {
            const max = Math.max(1000, Math.ceil(((Math.max(cat.planned, cat.spent) || 0) * 2) / 100 / 100) * 100);
            const v = Math.round((parseMoney(amount) || 0) / 100);
            return (
              <input
                type="range"
                className="gauge-range"
                min={0}
                max={max}
                step={5}
                value={Math.min(v, max)}
                onChange={(e) => setAmount(centsToInput(Number(e.target.value) * 100))}
                aria-label="Ajuster le montant prévu"
                style={{ ['--pct' as any]: `${Math.min(100, (v / max) * 100)}%` }}
              />
            );
          })()}
          {(() => {
            const left = (parseMoney(amount) || 0) - cat.spent;
            return (
              <div className={`small ${left < 0 ? 'error' : 'muted'}`} data-testid="envelope-left">
                {left < 0 ? `Dépassé de ${money(-left)} avec ce montant` : `Il restera ${money(left)} dans cette enveloppe`}
              </div>
            );
          })()}
        </div>
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
