import { DateTime } from 'luxon';
import { all, get, run, uid, nowIso, parseJson, tx } from '../db.ts';
import type { User } from '../auth.ts';
import { formatMoney } from '../time.ts';
import { googleStatus } from './google.ts';
import { outlookStatus } from './outlook.ts';
import { pendingCount } from './drafts.ts';

/**
 * Accueil (onboarding) et cloche « À faire / Alertes ».
 * Étape 1 obligatoire : prénom, âge, profession, salaire.
 * Étapes 2 (dépenses mensuelles récurrentes) et 3 (objectif d'épargne) : on peut les remettre à plus tard ;
 * elles deviennent alors des tâches dans la cloche, avec la synchronisation des agendas.
 */

export type SalaryPeriod = 'year' | 'month' | 'biweekly' | 'week';
export type Profile = { age: number; profession: string; salaryCents: number; salaryPeriod: SalaryPeriod; salaryType: 'gross' | 'net' };
export type StepState = 'done' | 'skipped' | null;
export type Onboarding = { profile: boolean; expenses: StepState; savings: StepState; savingsGoalId: string | null; completedAt: string | null };

const PERIODS: SalaryPeriod[] = ['year', 'month', 'biweekly', 'week'];
const PER_MONTH: Record<SalaryPeriod, number> = { year: 1 / 12, month: 1, biweekly: 26 / 12, week: 52 / 12 };

function settingsOf(userId: string): any {
  return parseJson(get<{ settings: string }>('SELECT settings FROM users WHERE id = ?', userId)?.settings, {});
}
function patchSettings(userId: string, patch: Record<string, any>) {
  const s = { ...settingsOf(userId), ...patch };
  run('UPDATE users SET settings = ? WHERE id = ?', JSON.stringify(s), userId);
  return s;
}

export function onboardingState(userId: string): Onboarding & { profileData: Profile | null; monthlySalaryCents: number | null } {
  const s = settingsOf(userId);
  const o = s.onboarding || {};
  const p: Profile | null = s.profile || null;
  return {
    profile: Boolean(p),
    expenses: o.expenses ?? null,
    savings: o.savings ?? null,
    savingsGoalId: o.savingsGoalId ?? null,
    completedAt: o.completedAt ?? null,
    profileData: p,
    monthlySalaryCents: p ? Math.round(p.salaryCents * PER_MONTH[p.salaryPeriod]) : null,
  };
}

function setStep(userId: string, patch: Partial<Onboarding>) {
  const s = settingsOf(userId);
  patchSettings(userId, { onboarding: { ...(s.onboarding || {}), ...patch } });
}

/** Étape 1 : profil obligatoire. */
export function saveProfile(user: User, b: any) {
  const name = String(b.name || '').trim().slice(0, 80);
  const age = Number(b.age);
  const profession = String(b.profession || '').trim().slice(0, 80);
  const salaryCents = Math.round(Number(b.salaryCents));
  const salaryPeriod: SalaryPeriod = PERIODS.includes(b.salaryPeriod) ? b.salaryPeriod : 'year';
  const salaryType = b.salaryType === 'net' ? 'net' : 'gross';
  if (!name) throw new Error('Indique ton prénom');
  if (!Number.isInteger(age) || age < 14 || age > 100) throw new Error('Indique un âge valide (14 à 100 ans)');
  if (profession.length < 2) throw new Error('Indique ta profession');
  if (!(salaryCents > 0) || salaryCents > 100_000_000_00) throw new Error('Indique un salaire valide');
  tx(() => {
    run('UPDATE users SET name = ? WHERE id = ?', name, user.id);
    patchSettings(user.id, { profile: { age, profession, salaryCents, salaryPeriod, salaryType } satisfies Profile });
    // Avec un salaire net et une date de paie, la paie devient un revenu récurrent (« Jusqu'à la prochaine paie »)
    const nextPay = /^\d{4}-\d{2}-\d{2}$/.test(b.nextPayDate || '') ? b.nextPayDate : null;
    if (salaryType === 'net' && nextPay && salaryPeriod !== 'year') {
      const cat = get("SELECT c.id FROM categories c JOIN budgets b ON b.id = c.budget_id WHERE c.user_id = ? AND b.key = 'perso' AND c.kind = 'income' ORDER BY c.sort LIMIT 1", user.id);
      const freq = salaryPeriod === 'month' ? 'monthly' : salaryPeriod;
      const existing = get("SELECT id FROM recurring WHERE user_id = ? AND kind = 'income' AND name = 'Salaire' AND sample = 0", user.id);
      if (existing) run('UPDATE recurring SET amount_cents = ?, frequency = ?, next_date = ?, active = 1 WHERE id = ?', salaryCents, freq, nextPay, existing.id);
      else
        run(
          "INSERT INTO recurring (id, user_id, name, merchant, amount_cents, category_id, kind, frequency, next_date, created_at) VALUES (?,?,?,?,?,?,'income',?,?,?)",
          uid(), user.id, 'Salaire', 'Salaire', salaryCents, cat?.id || null, freq, nextPay, nowIso(),
        );
    }
  });
  return onboardingState(user.id);
}

/** Dépenses mensuelles proposées : clé → nom, groupe et catégorie du budget personnel. */
export const EXPENSE_PRESETS: Record<string, { name: string; grp: string; category: string }> = {
  loyer: { name: 'Loyer ou hypothèque', grp: 'Logement', category: 'Loyer' },
  hydro: { name: 'Hydro-électricité', grp: 'Logement', category: 'Hydro-électricité' },
  internet: { name: 'Internet', grp: 'Logement', category: 'Internet et cellulaire' },
  cellulaire: { name: 'Cellulaire', grp: 'Logement', category: 'Internet et cellulaire' },
  assurance_hab: { name: 'Assurance habitation', grp: 'Assurances', category: 'Assurances' },
  assurance_auto: { name: 'Assurance auto', grp: 'Assurances', category: 'Assurances' },
  paiement_auto: { name: 'Paiement de voiture', grp: 'Transport', category: 'Paiement auto' },
  transport: { name: 'Transport en commun', grp: 'Transport', category: 'Transport en commun' },
  garderie: { name: 'Garderie', grp: 'Famille', category: 'Garderie' },
  gym: { name: 'Gym', grp: 'Santé', category: 'Gym et sport' },
  abonnements: { name: 'Abonnements (musique, télé…)', grp: 'Loisirs', category: 'Abonnements' },
  pret: { name: 'Prêt ou carte de crédit', grp: 'Dettes', category: 'Prêts et cartes' },
};

/** Catégorie du budget personnel (créée si elle n'existe pas). */
function ensureCategory(userId: string, grp: string, name: string, cents: number): string {
  const found = get("SELECT c.id FROM categories c JOIN budgets b ON b.id = c.budget_id WHERE c.user_id = ? AND b.key = 'perso' AND c.name = ? AND c.kind = 'expense'", userId, name);
  if (found) return found.id;
  const budget = get("SELECT id FROM budgets WHERE user_id = ? AND key = 'perso'", userId);
  if (!budget) throw new Error('Budget personnel introuvable');
  const id = uid();
  run('INSERT INTO categories (id, user_id, budget_id, grp, name, kind, default_amount_cents, sort) VALUES (?,?,?,?,?,?,?,?)', id, userId, budget.id, grp, name, 'expense', cents, 50);
  return id;
}

/** Prochaine date pour un jour du mois (aujourd'hui compris), ajustée aux mois courts. */
export function nextMonthlyDate(day: number, tz: string, from = DateTime.now().setZone(tz)): string {
  const d = Math.min(Math.max(1, Math.round(day) || 1), 31);
  const at = (m: DateTime) => m.set({ day: Math.min(d, m.daysInMonth!) });
  const thisMonth = at(from.startOf('month'));
  return (thisMonth.startOf('day') >= from.startOf('day') ? thisMonth : at(from.startOf('month').plus({ months: 1 }))).toISODate()!;
}

/** Étape 2 : ajoute une dépense mensuelle récurrente (paiement récurrent du budget). */
export function addMonthlyExpense(user: User, b: any) {
  const preset = EXPENSE_PRESETS[b.preset];
  const name = String(b.name || preset?.name || '').trim().slice(0, 80);
  const amountCents = Math.round(Number(b.amountCents));
  if (!name) throw new Error('Donne un nom à la dépense');
  if (!(amountCents > 0)) throw new Error('Indique un montant');
  const categoryId = ensureCategory(user.id, preset?.grp || 'Divers', preset?.category || 'Autre', amountCents);
  const id = uid();
  run(
    "INSERT INTO recurring (id, user_id, name, merchant, amount_cents, category_id, kind, frequency, next_date, reminder_days, created_at) VALUES (?,?,?,?,?,?,'expense','monthly',?,?,?)",
    id, user.id, name, name, amountCents, categoryId, nextMonthlyDate(Number(b.day) || 1, user.timezone), 2, nowIso(),
  );
  return monthlyExpenses(user.id).items.find((x) => x.id === id)!;
}

export function monthlyExpenses(userId: string) {
  const items = all("SELECT * FROM recurring WHERE user_id = ? AND kind = 'expense' AND active = 1 AND sample = 0 ORDER BY created_at", userId).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    amountCents: r.amount_cents as number,
    day: Number(String(r.next_date).slice(8, 10)),
    frequency: r.frequency as string,
  }));
  const monthly = (i: { amountCents: number; frequency: string }) => (i.frequency === 'monthly' ? i.amountCents : i.frequency === 'yearly' ? i.amountCents / 12 : i.frequency === 'weekly' ? (i.amountCents * 52) / 12 : (i.amountCents * 26) / 12);
  return { items, totalMonthlyCents: Math.round(items.reduce((s, i) => s + monthly(i), 0)) };
}

export function markStep(userId: string, step: 'expenses' | 'savings', state: 'done' | 'skipped') {
  setStep(userId, { [step]: state });
  return onboardingState(userId);
}

/** Étape 3 : objectif d'épargne (un objectif « montant » : par mois, ou une somme d'ici une date). */
export function createSavingsGoal(user: User, b: any) {
  const title = String(b.title || '').trim().slice(0, 120) || 'Épargne';
  const amount = Math.round(Number(b.amountCents)) / 100;
  if (!(amount > 0)) throw new Error('Indique un montant d’épargne');
  const monthly = b.kind !== 'target';
  const deadline = !monthly && /^\d{4}-\d{2}-\d{2}$/.test(b.deadline || '') ? b.deadline : null;
  if (!monthly && !deadline) throw new Error('Choisis une date pour atteindre ce montant');
  const id = uid();
  run(
    "INSERT INTO goals (id, user_id, title, metric, target, unit, period, start_date, deadline, reminder_days, created_at) VALUES (?,?,?,'amount',?,'$',?,?,?,?,?)",
    id, user.id, title, amount, monthly ? 'monthly' : 'once', DateTime.now().setZone(user.timezone).toISODate(), deadline, deadline ? 14 : null, nowIso(),
  );
  setStep(user.id, { savings: 'done', savingsGoalId: id });
  return { id, state: onboardingState(user.id) };
}

export function completeOnboarding(userId: string) {
  const st = onboardingState(userId);
  if (!st.profile) throw new Error('Termine d’abord ton profil');
  setStep(userId, { completedAt: nowIso(), expenses: st.expenses ?? 'skipped', savings: st.savings ?? 'skipped' });
  return onboardingState(userId);
}

// ---------- Cloche : tâches et alertes ----------

export type Task = { id: string; title: string; detail: string; done: boolean; open?: 'expenses' | 'savings'; links?: { label: string; to: string }[] };
export type Alert = { id: string; kind: 'error' | 'bill' | 'drafts' | 'notification'; title: string; body: string; at: string | null; to: string | null; unread: boolean };

export function inbox(user: User) {
  const st = onboardingState(user.id);
  const g = googleStatus(user.id), o = outlookStatus(user.id);
  const exp = monthlyExpenses(user.id);
  const tasks: Task[] = [
    {
      id: 'sync',
      title: 'Synchroniser tes agendas',
      detail: g.connected || o.connected ? `Relié à ${[g.connected && 'Google Agenda', o.connected && 'Outlook'].filter(Boolean).join(' et ')}` : 'Relie Google Agenda ou Outlook',
      done: g.connected || o.connected,
      links: [
        { label: 'Google Agenda', to: '/reglages/google' },
        { label: 'Outlook', to: '/reglages/outlook' },
      ],
    },
    {
      id: 'expenses',
      title: 'Terminer tes dépenses mensuelles',
      detail: exp.items.length ? `${exp.items.length} ajoutée(s) · ${formatMoney(exp.totalMonthlyCents)} par mois` : 'Loyer, Hydro, cellulaire, assurances…',
      done: st.expenses === 'done',
      open: 'expenses',
    },
    {
      id: 'savings',
      title: 'Choisir ton objectif d’épargne',
      detail: st.savings === 'done' ? 'Objectif créé' : 'Fonds d’urgence, voyage, mise de fonds…',
      done: st.savings === 'done',
      open: 'savings',
    },
  ];

  const alerts: Alert[] = [];
  if (g.connected && g.lastError) alerts.push({ id: 'err-google', kind: 'error', title: 'Google Agenda', body: g.lastError, at: g.lastSyncAt, to: '/reglages/google', unread: true });
  if (o.connected && o.lastError) alerts.push({ id: 'err-outlook', kind: 'error', title: 'Outlook', body: o.lastError, at: o.lastSyncAt, to: '/reglages/outlook', unread: true });
  const drafts = pendingCount(user.id);
  if (drafts) alerts.push({ id: 'drafts', kind: 'drafts', title: 'Dépenses à valider', body: `${drafts} fiche(s) en attente de confirmation`, at: null, to: '/budget', unread: true });
  const today = DateTime.now().setZone(user.timezone).startOf('day');
  for (const r of all("SELECT * FROM recurring WHERE user_id = ? AND kind = 'expense' AND active = 1 AND next_date <= ? ORDER BY next_date", user.id, today.plus({ days: 3 }).toISODate())) {
    const due = DateTime.fromISO(r.next_date, { zone: user.timezone });
    const diff = Math.round(due.diff(today, 'days').days);
    const when = diff < 0 ? `en retard depuis le ${due.toFormat('d LLLL', { locale: 'fr-CA' })}` : diff === 0 ? 'aujourd’hui' : diff === 1 ? 'demain' : `le ${due.toFormat('d LLLL', { locale: 'fr-CA' })}`;
    alerts.push({ id: `bill-${r.id}`, kind: 'bill', title: `${r.name} : ${formatMoney(r.amount_cents)}`, body: `Paiement prévu ${when}`, at: null, to: '/budget', unread: true });
  }
  for (const n of all('SELECT * FROM notifications WHERE user_id = ? ORDER BY sent_at DESC LIMIT 20', user.id)) {
    alerts.push({ id: `n-${n.id}`, kind: 'notification', title: n.title, body: n.body, at: n.sent_at, to: n.url || null, unread: !n.read_at });
  }
  const openTasks = tasks.filter((t) => !t.done).length;
  return { tasks, alerts, badge: openTasks + alerts.filter((a) => a.unread).length, openTasks };
}

export function markAlertsRead(userId: string) {
  run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', nowIso(), userId);
}
