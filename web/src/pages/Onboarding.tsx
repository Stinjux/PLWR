import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { centsToInput, money, parseMoney } from '../lib/format';
import { Icon, Seg } from '../components/ui';
import { MonthlyExpenses, SavingsGoalForm, useOnboarding } from '../components/MonthlyExpenses';
import type { Me } from '../App';

type Period = 'year' | 'month' | 'biweekly' | 'week';
const PER_MONTH: Record<Period, number> = { year: 1 / 12, month: 1, biweekly: 26 / 12, week: 52 / 12 };

/** Profil obligatoire : prénom, âge, profession, salaire. Sert à l'accueil et dans Réglages. */
export function ProfileForm({ me, onSaved, submitLabel = 'Continuer' }: { me: Me; onSaved: () => void; submitLabel?: string }) {
  const p = (me.onboarding?.profileData || {}) as any;
  const [name, setName] = useState(me.user.name || '');
  const [age, setAge] = useState(p.age ? String(p.age) : '');
  const [profession, setProfession] = useState(p.profession || '');
  const [salary, setSalary] = useState(p.salaryCents ? centsToInput(p.salaryCents) : '');
  const [period, setPeriod] = useState<Period>(p.salaryPeriod || 'year');
  const [type, setType] = useState<'gross' | 'net'>(p.salaryType || 'gross');
  const [nextPay, setNextPay] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const cents = parseMoney(salary);
  const ageN = Number(age);
  const valid = name.trim().length > 0 && Number.isInteger(ageN) && ageN >= 14 && ageN <= 100 && profession.trim().length >= 2 && Boolean(cents && cents > 0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/onboarding/profile', { name, age: ageN, profession, salaryCents: cents, salaryPeriod: period, salaryType: type, nextPayDate: nextPay || undefined });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <div className="form-grid">
        <label className="field full">
          Prénom
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="given-name" required />
        </label>
        <label className="field">
          Âge
          <input className="input" inputMode="numeric" value={age} onChange={(e) => setAge(e.target.value.replace(/\D/g, '').slice(0, 3))} required aria-describedby="age-hint" />
        </label>
        <label className="field">
          Profession
          <input className="input" value={profession} onChange={(e) => setProfession(e.target.value)} placeholder="Ex. : infirmière" autoComplete="organization-title" required />
        </label>
      </div>
      <label className="field">
        Salaire
        <span className="money-input">
          <input className="input" inputMode="decimal" value={salary} onChange={(e) => setSalary(e.target.value)} placeholder="0,00" required aria-label="Salaire" />
          <span aria-hidden="true">$</span>
        </span>
      </label>
      <Seg
        full
        label="Fréquence du salaire"
        value={period}
        onChange={setPeriod}
        options={[
          ['year', 'Par année'],
          ['month', 'Par mois'],
          ['biweekly', 'Aux 2 sem.'],
          ['week', 'Par sem.'],
        ]}
      />
      <Seg
        full
        label="Brut ou net"
        value={type}
        onChange={setType}
        options={[
          ['gross', 'Brut (avant impôts)'],
          ['net', 'Net (sur ma paie)'],
        ]}
      />
      {cents ? (
        <div className="small muted" data-testid="salary-monthly">
          ≈ {money(Math.round(cents * PER_MONTH[period]))} par mois {type === 'gross' ? 'avant impôts' : 'dans ton compte'}
        </div>
      ) : null}
      {type === 'net' && period !== 'year' && (
        <label className="field">
          Prochaine paie <span className="tiny">(facultatif)</span>
          <input className="input" type="date" value={nextPay} onChange={(e) => setNextPay(e.target.value)} />
          <span className="tiny muted">Pour savoir combien il te reste jusqu’à la prochaine paie.</span>
        </label>
      )}
      <p className="tiny muted" id="age-hint" style={{ margin: 0 }}>
        <Icon.lock style={{ width: 12, height: 12, verticalAlign: -1 }} /> Ces informations restent privées : elles servent seulement à tes suggestions de budget et d’épargne.
      </p>
      {error && <div className="error">{error}</div>}
      <button className="btn primary block" disabled={!valid || busy}>
        {submitLabel}
      </button>
    </form>
  );
}

const STEPS = ['Profil', 'Dépenses', 'Épargne'];

/** Accueil après la création du compte : profil obligatoire, puis dépenses mensuelles et épargne (facultatives). */
export function Onboarding({ me }: { me: Me }) {
  const qc = useQueryClient();
  const ob = useOnboarding();
  const [step, setStep] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const inbox = useQuery({ queryKey: ['inbox'], queryFn: () => api.get<any>('/api/inbox'), enabled: step === 3 });

  // Reprend là où la personne s'était arrêtée
  useEffect(() => {
    if (step !== null || !ob.data) return;
    const s = ob.data.state;
    setStep(!s.profile ? 0 : s.expenses === null ? 1 : s.savings === null ? 2 : 3);
  }, [ob.data, step]);

  if (step === null) return <div className="empty">Chargement…</div>;
  const refresh = () => (qc.invalidateQueries({ queryKey: ['onboarding'] }), qc.invalidateQueries({ queryKey: ['me'] }));
  const mark = async (s: 'expenses' | 'savings', state: 'done' | 'skipped') => {
    await api.post('/api/onboarding/step', { step: s, state });
    refresh();
  };
  async function finish() {
    setBusy(true);
    await api.post('/api/onboarding/complete');
    await qc.invalidateQueries();
  }
  const firstName = (me.user.name || '').split(' ')[0];

  return (
    <div className="onb">
      {step < 3 && (
        <div className="onb-progress" aria-label={`Étape ${step + 1} sur 3`}>
          {step > 0 && (
            <button className="icon-btn" aria-label="Étape précédente" onClick={() => setStep(step - 1)}>
              <Icon.chevronL />
            </button>
          )}
          <div className="onb-bars">
            {STEPS.map((s, i) => (
              <span key={s} className={i <= step ? 'on' : ''}>
                <i />
                {s}
              </span>
            ))}
          </div>
        </div>
      )}

      {step === 0 && (
        <section className="onb-step" aria-labelledby="onb-0">
          <div className="eyebrow">Bienvenue dans PLWR</div>
          <h1 id="onb-0">Faisons connaissance</h1>
          <p className="muted">Quatre réponses pour adapter ton budget et tes objectifs. Ça prend une minute.</p>
          <ProfileForm me={me} onSaved={() => (refresh(), setStep(1))} />
        </section>
      )}

      {step === 1 && (
        <section className="onb-step" aria-labelledby="onb-1">
          <div className="eyebrow">Étape 2 sur 3</div>
          <h1 id="onb-1">Tes dépenses fixes chaque mois</h1>
          <p className="muted">Touche ce qui s’applique et indique le montant. PLWR te rappellera chaque paiement et les comptera dans ton budget.</p>
          <MonthlyExpenses />
          <div className="onb-actions">
            <button className="btn primary block" onClick={async () => (await mark('expenses', 'done'), setStep(2))} disabled={!ob.data?.expenses.items.length}>
              C’est tout, continuer
            </button>
            <button className="btn ghost block" onClick={async () => (await mark('expenses', 'skipped'), setStep(2))}>
              Je finirai plus tard
            </button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="onb-step" aria-labelledby="onb-2">
          <div className="eyebrow">Étape 3 sur 3</div>
          <h1 id="onb-2">Ton objectif d’épargne</h1>
          <p className="muted">Un objectif clair, même petit, change tout. Tu pourras en ajouter d’autres dans Objectifs.</p>
          <SavingsGoalForm onCreated={() => (refresh(), setStep(3))} onLater={async () => (await mark('savings', 'skipped'), setStep(3))} />
        </section>
      )}

      {step === 3 && (
        <section className="onb-step onb-done" aria-labelledby="onb-3">
          <span className="onb-bell" aria-hidden="true">
            <Icon.bell />
          </span>
          <h1 id="onb-3">Tout est prêt{firstName ? `, ${firstName}` : ''}</h1>
          <p className="muted">La cloche en haut à droite garde tes alertes et ce qu’il reste à faire. Pour commencer :</p>
          <ul className="group">
            {(inbox.data?.tasks || []).map((t: any) => (
              <li key={t.id}>
                <span className={`task-check${t.done ? ' done' : ''}`} aria-hidden="true">
                  {t.done && <Icon.check />}
                </span>
                <span className="grow">
                  <span className="block">{t.title}</span>
                  <span className="tiny muted">{t.done ? 'Fait' : t.detail}</span>
                </span>
              </li>
            ))}
          </ul>
          <button className="btn primary block" onClick={finish} disabled={busy}>
            Commencer
          </button>
        </section>
      )}
    </div>
  );
}
