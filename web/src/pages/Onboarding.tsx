import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { api } from '../lib/api';
import { TZ, centsToInput, money, parseMoney } from '../lib/format';
import { track } from '../lib/track';
import { Icon } from '../components/ui';
import { ProfessionPicker, SalaryGauge } from '../components/ProfileFields';
import type { Me } from '../App';

type Path = 'week' | 'goal' | 'expense' | 'explore';

/** Profil obligatoire : prénom, âge, profession (liste filtrable ou « Autre »), salaire annuel (jauge). Sert aussi dans Réglages. */
export function ProfileForm({ me, onSaved, submitLabel = 'Terminer' }: { me: Me; onSaved: () => void; submitLabel?: string }) {
  const p = (me.onboarding?.profileData || {}) as any;
  const annual = p.salaryCents ? Math.round(p.salaryCents * ({ year: 1, month: 12, biweekly: 26, week: 52 } as any)[p.salaryPeriod || 'year']) : 0;
  const [name, setName] = useState(me.user.name || '');
  const [age, setAge] = useState(p.age ? String(p.age) : '');
  const [profession, setProfession] = useState<string>(p.profession || '');
  const [salary, setSalary] = useState<number>(annual);
  const [type, setType] = useState<'gross' | 'net'>(p.salaryType || 'gross');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ageN = Number(age);
  const valid = name.trim().length > 0 && Number.isInteger(ageN) && ageN >= 14 && ageN <= 100 && profession.trim().length >= 2 && salary > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/onboarding/profile', { name, age: ageN, profession, salaryCents: salary, salaryPeriod: 'year', salaryType: type });
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
        <label className="field">
          Prénom
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="given-name" required />
        </label>
        <label className="field">
          Âge
          <input className="input" inputMode="numeric" value={age} onChange={(e) => setAge(e.target.value.replace(/\D/g, '').slice(0, 3))} placeholder="29" required />
        </label>
      </div>
      <ProfessionPicker value={profession} onChange={setProfession} />
      <SalaryGauge cents={salary} onChange={setSalary} type={type} onType={setType} />
      <p className="tiny muted" style={{ margin: 0 }}>
        <Icon.lock style={{ width: 12, height: 12, verticalAlign: -1 }} /> Ces informations restent privées. Elles servent à adapter tes suggestions de budget et d’épargne.
      </p>
      {error && <div className="error">{error}</div>}
      <button className="btn primary block lg" disabled={!valid || busy}>
        {submitLabel}
      </button>
    </form>
  );
}

// ---------- Choix du jour et de l'heure ----------

function useDays() {
  return useMemo(() => {
    const t = DateTime.now().setZone(TZ).startOf('day');
    return Array.from({ length: 7 }, (_, i) => {
      const d = t.plus({ days: i });
      return { iso: d.toISODate()!, label: i === 0 ? 'Aujourd’hui' : i === 1 ? 'Demain' : d.toFormat('ccc d', { locale: 'fr-CA' }) };
    });
  }, []);
}
const TIMES = Array.from({ length: 33 }, (_, i) => {
  const m = 6 * 60 + i * 30;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
});
const timeLabel = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
};

function WhenPicker({ day, time, duration, onDay, onTime, onDuration }: { day: string; time: string; duration: number; onDay: (d: string) => void; onTime: (t: string) => void; onDuration: (m: number) => void }) {
  const days = useDays();
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="chip-scroll" role="group" aria-label="Jour">
        {days.map((d) => (
          <button key={d.iso} type="button" className={`pill${day === d.iso ? ' on' : ''}`} aria-pressed={day === d.iso} onClick={() => onDay(d.iso)}>
            {d.label}
          </button>
        ))}
      </div>
      <div className="row" style={{ gap: 10 }}>
        <label className="field grow">
          Heure
          <select className="input" value={time} onChange={(e) => onTime(e.target.value)}>
            {TIMES.map((t) => (
              <option key={t} value={t}>
                {timeLabel(t)}
              </option>
            ))}
          </select>
        </label>
        <label className="field grow">
          Durée
          <select className="input" value={duration} onChange={(e) => onDuration(Number(e.target.value))}>
            {[15, 30, 45, 60, 90, 120].map((m) => (
              <option key={m} value={m}>
                {m < 60 ? `${m} min` : m === 60 ? '1 h' : m === 90 ? '1 h 30' : '2 h'}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
const toIso = (day: string, time: string) => DateTime.fromISO(`${day}T${time}`, { zone: TZ }).toUTC().toISO()!;
const tomorrow = () => DateTime.now().setZone(TZ).plus({ days: 1 }).toISODate()!;

// ---------- Les trois actions réelles ----------

function WeekAction({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [day, setDay] = useState(tomorrow());
  const [time, setTime] = useState('09:00');
  const [duration, setDuration] = useState(60);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function add() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/onboarding/event', { title, start: toIso(day, time), durationMin: duration });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <>
      <h1 id="onb-title">Ajoute un moment de ta semaine</h1>
      <p className="lead">Un rendez-vous, une séance de sport, un souper. Il apparaîtra tout de suite dans ton agenda.</p>
      <label className="field">
        Quoi ?
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex. : Dentiste" autoFocus />
      </label>
      <div className="chip-scroll" role="group" aria-label="Exemples">
        {['Rendez-vous médical', 'Entraînement', 'Souper en famille', 'Réunion'].map((x) => (
          <button key={x} type="button" className="pill ghost" onClick={() => setTitle(x)}>
            {x}
          </button>
        ))}
      </div>
      <WhenPicker day={day} time={time} duration={duration} onDay={setDay} onTime={setTime} onDuration={setDuration} />
      {error && <div className="error">{error}</div>}
      <button className="btn primary block lg" onClick={add} disabled={!title.trim() || busy}>
        Ajouter à mon agenda
      </button>
    </>
  );
}

type GoalDraft = { title: string; kind: string; metric: string; target: number; unit: string; period: string; deadline: string | null; summary: string; firstStep: { title: string; durationMin: number }; source: 'ai' | 'rules' };
const PERIOD_LABEL: Record<string, string> = { once: 'une fois', daily: 'par jour', weekly: 'par semaine', monthly: 'par mois' };
const GOAL_IDEAS: [string, string[]][] = [
  ['Finances', ['Me bâtir un fonds d’urgence de 1 000 $', 'Épargner 200 $ par mois', 'Rembourser ma carte de crédit d’ici 6 mois', 'Mettre 3 000 $ de côté pour un voyage']],
  ['Personnel', ['Courir 3 fois par semaine', 'Lire 20 min par jour', 'Méditer 10 min par jour', 'Apprendre l’espagnol']],
];

function GoalAction({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState('');
  const [goal, setGoal] = useState<GoalDraft | null>(null);
  const [stepTitle, setStepTitle] = useState('');
  const [day, setDay] = useState(tomorrow());
  const [time, setTime] = useState('18:00');
  const [duration, setDuration] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function define() {
    setBusy(true);
    setError(null);
    try {
      const g = await api.post<GoalDraft>('/api/onboarding/goal/interpret', { text });
      setGoal(g);
      setStepTitle(g.firstStep.title);
      setDuration([15, 30, 45, 60, 90, 120].reduce((a, b) => (Math.abs(b - g.firstStep.durationMin) < Math.abs(a - g.firstStep.durationMin) ? b : a)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function plan() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/onboarding/goal', { goal, step: { title: stepTitle, start: toIso(day, time), durationMin: duration } });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  if (!goal)
    return (
      <>
        <h1 id="onb-title">Quel objectif veux-tu suivre ?</h1>
        <p className="lead">Choisis une idée ou écris le tien. PLWR le rend mesurable et t’aide à planifier la première étape.</p>
        {GOAL_IDEAS.map(([group, ideas]) => (
          <div key={group}>
            <div className="field-label" style={{ marginBottom: 6 }}>
              {group}
            </div>
            <div className="row wrap" role="group" aria-label={`Idées ${group.toLowerCase()}`} style={{ gap: 8 }}>
              {ideas.map((x) => (
                <button key={x} type="button" className={`pill${text === x ? ' on' : ''}`} aria-pressed={text === x} onClick={() => setText(x)}>
                  {x}
                </button>
              ))}
            </div>
          </div>
        ))}
        <label className="field">
          Ou écris-le avec tes mots
          <textarea className="input" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Ex. : Mettre 5 000 $ de côté pour un voyage d’ici juin" />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="btn primary block lg" onClick={define} disabled={text.trim().length < 3 || busy}>
          {busy ? 'Un instant…' : 'Définir mon objectif'}
        </button>
      </>
    );

  return (
    <>
      <h1 id="onb-title">Planifie la première étape</h1>
      <div className="result-card" data-testid="goal-result">
        <div className="eyebrow">{goal.kind === 'financial' ? 'Objectif financier' : 'Objectif personnel'}</div>
        <input className="result-title" value={goal.title} onChange={(e) => setGoal({ ...goal, title: e.target.value })} aria-label="Titre de l’objectif" />
        <div className="row wrap" style={{ gap: 6 }}>
          {goal.metric !== 'check' && (
            <span className="chip ok">
              {goal.metric === 'amount' ? money(Math.round(goal.target * 100)) : `${goal.target} ${goal.unit}`.trim()} · {PERIOD_LABEL[goal.period]}
            </span>
          )}
          {goal.deadline && <span className="chip">d’ici le {DateTime.fromISO(goal.deadline).toFormat('d LLLL yyyy', { locale: 'fr-CA' })}</span>}
          {goal.metric === 'check' && <span className="chip">à cocher une fois atteint</span>}
        </div>
        {goal.summary && <p className="small muted" style={{ margin: 0 }}>{goal.summary}</p>}
        <button type="button" className="link-btn" onClick={() => setGoal(null)}>
          Modifier mon texte
        </button>
      </div>
      <label className="field">
        Première étape
        <input className="input" value={stepTitle} onChange={(e) => setStepTitle(e.target.value)} />
      </label>
      <WhenPicker day={day} time={time} duration={duration} onDay={setDay} onTime={setTime} onDuration={setDuration} />
      {error && <div className="error">{error}</div>}
      <button className="btn primary block lg" onClick={plan} disabled={!stepTitle.trim() || !goal.title.trim() || busy}>
        Planifier la première étape
      </button>
    </>
  );
}

type Preview = { amountCents: number; merchant: string | null; date: string; dateLabel: string; categoryId: string | null; categoryConfident: boolean; categoryReason: string; categories: { id: string; label: string }[] };

function ExpenseAction({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState('');
  const [p, setP] = useState<Preview | null>(null);
  const [amount, setAmount] = useState('');
  const [merchant, setMerchant] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [date, setDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function analyse() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<Preview>('/api/onboarding/expense/preview', { text });
      setP(r);
      setAmount(centsToInput(r.amountCents));
      setMerchant(r.merchant || '');
      setCategoryId(r.categoryId || '');
      setDate(r.date);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/onboarding/expense', { amountCents: parseMoney(amount), merchant, categoryId, date });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  if (!p)
    return (
      <>
        <h1 id="onb-title">Note une dépense comme tu la dirais</h1>
        <p className="lead">PLWR trouve le montant, le commerçant, la date et la catégorie. Tu vérifies avant d’enregistrer.</p>
        <label className="field">
          Ta dépense
          <input className="input lg" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && text.trim() && analyse()} placeholder="Ex. : 12,50 $ café ce matin chez Tim Hortons" autoFocus />
        </label>
        <div className="chip-scroll" role="group" aria-label="Exemples">
          {['12,50 $ café ce matin', '64 $ d’épicerie chez IGA hier', '45 $ d’essence chez Shell'].map((x) => (
            <button key={x} type="button" className="pill ghost" onClick={() => setText(x)}>
              {x}
            </button>
          ))}
        </div>
        {error && <div className="error">{error}</div>}
        <button className="btn primary block lg" onClick={analyse} disabled={!text.trim() || busy}>
          Analyser
        </button>
      </>
    );

  return (
    <>
      <h1 id="onb-title">Voici ce que j’ai compris</h1>
      <p className="lead">Corrige ce qui ne va pas, puis confirme.</p>
      <div className="result-card" data-testid="expense-result">
        <label className="field">
          Montant
          <span className="money-input">
            <input className="input lg" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Montant" />
            <span aria-hidden="true">$</span>
          </span>
        </label>
        <label className="field">
          Catégorie {!p.categoryConfident && <span className="tag-warn">à vérifier</span>}
          <select className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="Catégorie">
            {p.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <div className="form-grid">
          <label className="field">
            Commerçant
            <input className="input" value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="Facultatif" />
          </label>
          <label className="field">
            Date
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <button className="btn primary block lg" onClick={confirm} disabled={!parseMoney(amount) || !categoryId || busy}>
        Confirmer la dépense
      </button>
      <button type="button" className="link-btn center" onClick={() => setP(null)}>
        Recommencer
      </button>
    </>
  );
}

// ---------- Parcours ----------

const CHOICES: { path: Exclude<Path, 'explore'>; title: string; example: string; icon: keyof typeof Icon }[] = [
  { path: 'week', title: 'Planifier ma semaine', example: 'Ex. : dentiste jeudi à 14 h', icon: 'calendar' },
  { path: 'goal', title: 'Suivre un objectif', example: 'Ex. : courir 3 fois par semaine', icon: 'target' },
  { path: 'expense', title: 'Gérer mes dépenses', example: 'Ex. : 12 $ café ce matin', icon: 'wallet' },
];

/** Accueil en trois écrans au plus : choix → une action réelle → profil. Le résultat s'affiche ensuite sur le tableau de bord. */
export function Onboarding({ me }: { me: Me }) {
  const qc = useQueryClient();
  const st = me.onboarding;
  const [path, setPath] = useState<Path | null>((st.path as Path) || null);
  const [selected, setSelected] = useState<Path | null>((st.path as Path) || null);
  const [screen, setScreen] = useState<'choose' | 'action' | 'profile'>(st.firstAction || st.path === 'explore' ? 'profile' : st.path ? 'action' : 'choose');
  const [done, setDone] = useState<string | null>(st.firstAction?.label || null);

  useEffect(() => {
    track('onboarding_started');
  }, []);

  const refreshMe = () => qc.invalidateQueries({ queryKey: ['me'] });
  async function go(p: Path) {
    await api.post('/api/onboarding/path', { path: p });
    setPath(p);
    setScreen(p === 'explore' ? 'profile' : 'action');
  }
  async function explore() {
    track('explore_clicked', { from: screen, path: path || 'aucun' });
    if (!path) await api.post('/api/onboarding/path', { path: 'explore' });
    setPath(path || 'explore');
    setScreen('profile');
  }
  async function afterAction() {
    const fresh = await api.get<Me>('/api/me');
    setDone(fresh.onboarding.firstAction?.label || null);
    setScreen('profile');
  }
  async function finish() {
    await api.post('/api/onboarding/complete');
    await qc.invalidateQueries();
  }

  const total = path === 'explore' || (screen === 'profile' && !done) ? 2 : 3;
  const index = screen === 'choose' ? 1 : screen === 'action' ? 2 : total;

  return (
    <div className="onb">
      <div className="onb-top">
        <div className="onb-dots" aria-label={`Écran ${index} sur ${total}`}>
          {Array.from({ length: total }, (_, i) => (
            <i key={i} className={i < index ? 'on' : ''} />
          ))}
        </div>
        {screen !== 'profile' && (
          <button type="button" className="link-btn" onClick={explore}>
            Explorer l’app
          </button>
        )}
      </div>

      <section className="onb-step" aria-labelledby="onb-title">
        {screen === 'choose' && (
          <>
            <div className="eyebrow">Bienvenue dans PLWR</div>
            <h1 id="onb-title">Qu’est-ce que tu veux organiser en premier ?</h1>
            <p className="lead">Choisis une chose. Le reste attendra que tu sois prêt·e.</p>
            <div className="choice-list" role="radiogroup" aria-label="Par quoi commencer">
              {CHOICES.map((c) => {
                const I = Icon[c.icon];
                return (
                  <button key={c.path} type="button" role="radio" aria-checked={selected === c.path} className={`choice${selected === c.path ? ' on' : ''}`} onClick={() => setSelected(c.path)}>
                    <span className="choice-icon" aria-hidden="true">
                      <I />
                    </span>
                    <span className="grow">
                      <span className="choice-title">{c.title}</span>
                      <span className="choice-example">{c.example}</span>
                    </span>
                    <span className="choice-radio" aria-hidden="true" />
                  </button>
                );
              })}
            </div>
            <button className="btn primary block lg" disabled={!selected} onClick={() => selected && go(selected)}>
              Continuer
            </button>
          </>
        )}

        {screen === 'action' && path === 'week' && <WeekAction onDone={afterAction} />}
        {screen === 'action' && path === 'goal' && <GoalAction onDone={afterAction} />}
        {screen === 'action' && path === 'expense' && <ExpenseAction onDone={afterAction} />}

        {screen === 'profile' && (
          <>
            {done && (
              <div className="done-banner" role="status" data-testid="first-action-done">
                <Icon.check /> <span>C’est noté : {done}</span>
              </div>
            )}
            <h1 id="onb-title">Dernière étape : toi</h1>
            <p className="lead">Quatre réponses pour adapter tes suggestions de budget. Ensuite, tu arrives sur ton tableau de bord.</p>
            <ProfileForm me={me} onSaved={() => (refreshMe(), finish())} />
          </>
        )}
      </section>
    </div>
  );
}
