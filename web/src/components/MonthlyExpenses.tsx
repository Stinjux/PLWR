import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { money, parseMoney } from '../lib/format';
import { Icon, useToast } from './ui';

export type Expenses = { items: { id: string; name: string; amountCents: number; day: number; frequency: string }[]; totalMonthlyCents: number };
export type OnboardingData = {
  state: { profile: boolean; expenses: 'done' | 'skipped' | null; savings: 'done' | 'skipped' | null; completedAt: string | null; monthlySalaryCents: number | null; profileData: any };
  expenses: Expenses;
  presets: { key: string; name: string }[];
};

export const useOnboarding = () => useQuery({ queryKey: ['onboarding'], queryFn: () => api.get<OnboardingData>('/api/onboarding') });

/** Ajout des dépenses fixes mensuelles (loyer, Hydro…) : elles deviennent des paiements récurrents du budget. */
export function MonthlyExpenses() {
  const q = useOnboarding();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState<string | null>(null); // clé du modèle ouvert, ou 'autre'
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [day, setDay] = useState('1');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => (qc.invalidateQueries({ queryKey: ['onboarding'] }), qc.invalidateQueries({ queryKey: ['inbox'] }));

  const d = q.data;
  if (!d) return <div className="empty">Chargement…</div>;
  const added = new Set(d.expenses.items.map((i) => i.name));

  function start(key: string) {
    setOpen(open === key ? null : key);
    setName('');
    setAmount('');
    setDay('1');
    setError(null);
  }
  async function add() {
    const cents = parseMoney(amount);
    if (!cents || cents <= 0) return setError('Indique un montant');
    if (open === 'autre' && !name.trim()) return setError('Donne un nom à la dépense');
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/onboarding/expenses', { preset: open === 'autre' ? undefined : open, name: open === 'autre' ? name : undefined, amountCents: cents, day: Number(day) });
      setOpen(null);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string, label: string) {
    await api.del(`/api/recurring/${id}`);
    toast(`${label} retiré`);
    refresh();
  }

  const form = (
    <div className="expense-form">
      {open === 'autre' && (
        <label className="field">
          Nom
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex. : Pension alimentaire, Netflix…" autoFocus />
        </label>
      )}
      <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
        <label className="field grow">
          Montant par mois
          <span className="money-input">
            <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" autoFocus={open !== 'autre'} aria-label="Montant par mois" />
            <span aria-hidden="true">$</span>
          </span>
        </label>
        <label className="field" style={{ width: 110 }}>
          Le … du mois
          <select className="input" value={day} onChange={(e) => setDay(e.target.value)} aria-label="Jour du paiement">
            {Array.from({ length: 31 }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                {i + 1}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <div className="error">{error}</div>}
      <button className="btn primary block" onClick={add} disabled={busy}>
        Ajouter cette dépense
      </button>
    </div>
  );

  return (
    <div className="stack">
      <div className="preset-grid" role="group" aria-label="Dépenses courantes">
        {d.presets.map((p) => {
          const done = added.has(p.name);
          return (
            <button key={p.key} type="button" className={`preset${open === p.key ? ' on' : ''}${done ? ' done' : ''}`} aria-expanded={open === p.key} onClick={() => start(p.key)}>
              {done ? <Icon.check /> : <Icon.plus />} {p.name}
            </button>
          );
        })}
        <button type="button" className={`preset${open === 'autre' ? ' on' : ''}`} aria-expanded={open === 'autre'} onClick={() => start('autre')}>
          <Icon.plus /> Autre dépense
        </button>
      </div>
      {open && form}

      {d.expenses.items.length > 0 && (
        <section>
          <h3 className="group-label">Mes dépenses mensuelles</h3>
          <ul className="group" data-testid="expenses-list">
            {d.expenses.items.map((i) => (
              <li key={i.id}>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="block ellipsis">{i.name}</span>
                  <span className="tiny muted">{i.frequency === 'monthly' ? `Le ${i.day} de chaque mois` : 'Récurrent'}</span>
                </span>
                <strong>{money(i.amountCents)}</strong>
                <button className="icon-btn" aria-label={`Retirer ${i.name}`} onClick={() => remove(i.id, i.name)}>
                  <Icon.close />
                </button>
              </li>
            ))}
            <li className="total-row">
              <span className="grow">Total par mois</span>
              <strong data-testid="expenses-total">{money(d.expenses.totalMonthlyCents)}</strong>
            </li>
          </ul>
        </section>
      )}
    </div>
  );
}

const REASONS = ['Fonds d’urgence', 'Voyage', 'Mise de fonds', 'Retraite', 'Projet perso'];

/** Objectif d'épargne : un montant chaque mois, ou une somme à atteindre d'ici une date. */
export function SavingsGoalForm({ onCreated, onLater, laterLabel = 'Plus tard' }: { onCreated: () => void; onLater?: () => void; laterLabel?: string }) {
  const q = useOnboarding();
  const toast = useToast();
  const [title, setTitle] = useState(REASONS[0]);
  const [kind, setKind] = useState<'monthly' | 'target'>('monthly');
  const [amount, setAmount] = useState('');
  const [deadline, setDeadline] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const d = q.data;
  const salary = d?.state.monthlySalaryCents || 0;
  const net = d?.state.profileData?.salaryType === 'net';
  // Repères simples : 10 % du revenu net (≈ 75 % du brut), ou 3 mois de dépenses fixes pour un fonds d'urgence
  const tenPct = Math.round((salary * (net ? 1 : 0.75) * 0.1) / 1000) * 1000;
  const emergency = Math.round(((d?.expenses.totalMonthlyCents || 0) * 3) / 10000) * 10000;

  async function create() {
    const cents = parseMoney(amount);
    if (!cents || cents <= 0) return setError('Indique un montant');
    if (kind === 'target' && !deadline) return setError('Choisis une date');
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/onboarding/savings', { title, kind, amountCents: cents, deadline: kind === 'target' ? deadline : undefined });
      toast(`Objectif « ${title} » créé`);
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="row wrap" role="group" aria-label="Pour quoi épargner">
        {REASONS.map((r) => (
          <button key={r} type="button" className={`person-chip${title === r ? '' : ' off'}`} style={{ paddingLeft: 14 }} aria-pressed={title === r} onClick={() => (setTitle(r), r === 'Fonds d’urgence' && emergency ? setKind('target') : null)}>
            {r}
          </button>
        ))}
      </div>
      <div className="seg full" role="group" aria-label="Type d’objectif">
        <button type="button" className={kind === 'monthly' ? 'on' : ''} aria-pressed={kind === 'monthly'} onClick={() => setKind('monthly')}>
          Chaque mois
        </button>
        <button type="button" className={kind === 'target' ? 'on' : ''} aria-pressed={kind === 'target'} onClick={() => setKind('target')}>
          Un montant d’ici une date
        </button>
      </div>
      <label className="field">
        {kind === 'monthly' ? 'Montant à mettre de côté chaque mois' : 'Montant à atteindre'}
        <span className="money-input">
          <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" aria-label={kind === 'monthly' ? 'Montant par mois' : 'Montant à atteindre'} />
          <span aria-hidden="true">$</span>
        </span>
      </label>
      {kind === 'monthly' && tenPct > 0 && (
        <button type="button" className="suggestion" onClick={() => setAmount(String(tenPct / 100))}>
          Suggestion : <strong>{money(tenPct)}</strong> par mois, environ 10 % de ton revenu net
        </button>
      )}
      {kind === 'target' && emergency > 0 && (
        <button type="button" className="suggestion" onClick={() => setAmount(String(emergency / 100))}>
          Suggestion : <strong>{money(emergency)}</strong>, soit 3 mois de tes dépenses fixes
        </button>
      )}
      {kind === 'target' && (
        <label className="field">
          D’ici le
          <input className="input" type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        </label>
      )}
      {error && <div className="error">{error}</div>}
      <button className="btn primary block" onClick={create} disabled={busy}>
        Créer mon objectif
      </button>
      {onLater && (
        <button className="btn ghost block" onClick={onLater}>
          {laterLabel}
        </button>
      )}
    </div>
  );
}
