import { DateTime } from 'luxon';
import { all, get, run, uid, nowIso, tx } from '../db.ts';
import type { User } from '../auth.ts';
import { createEvent } from './events.ts';
import { insertTransaction, listCategories } from './budget.ts';

const PERSO: [string, string, number, string?][] = [
  ['Logement', 'Loyer', 1200_00],
  ['Logement', 'Hydro-électricité', 80_00],
  ['Logement', 'Internet et cellulaire', 110_00],
  ['Alimentation', 'Épicerie', 500_00],
  ['Alimentation', 'Restaurants et cafés', 200_00],
  ['Transport', 'Essence', 180_00],
  ['Transport', 'Entretien et transport', 60_00],
  ['Santé', 'Gym et sport', 60_00],
  ['Santé', 'Santé et pharmacie', 40_00],
  ['Loisirs', 'Abonnements', 40_00],
  ['Loisirs', 'Sorties et loisirs', 100_00],
  ['Formation', 'CFA et formation', 100_00],
  ['Achats', 'Vêtements et maison', 100_00],
  ['Divers', 'Autre', 50_00],
];
const MONDAIX: [string, string, number, string?][] = [
  ['Produits', 'Inventaire', 800_00],
  ['Marketing', 'Publicité', 300_00],
  ['Outils', 'Logiciels et abonnements', 100_00],
  ['Logistique', 'Expédition', 150_00],
  ['Administration', 'Frais divers', 100_00],
];

export function createDefaults(userId: string) {
  tx(() => {
    const perso = uid(), mondaix = uid();
    run('INSERT INTO budgets (id, user_id, key, name) VALUES (?,?,?,?)', perso, userId, 'perso', 'Personnel');
    run('INSERT INTO budgets (id, user_id, key, name) VALUES (?,?,?,?)', mondaix, userId, 'mondaix', 'MONDAIX');
    const add = (b: string, grp: string, name: string, cents: number, kind = 'expense', sort = 0) =>
      run('INSERT INTO categories (id, user_id, budget_id, grp, name, kind, default_amount_cents, sort) VALUES (?,?,?,?,?,?,?,?)', uid(), userId, b, grp, name, kind, cents, sort);
    PERSO.forEach(([g, n, c], i) => add(perso, g, n, c, 'expense', i));
    MONDAIX.forEach(([g, n, c], i) => add(mondaix, g, n, c, 'expense', i));
    add(perso, 'Revenus', 'Salaire', 4200_00, 'income');
    add(perso, 'Revenus', 'Autres revenus', 0, 'income');
    add(mondaix, 'Revenus', 'Ventes', 2500_00, 'income');
  });
}

/** Ajoute quelques exemples (supprimables en un clic dans Réglages). */
export function createSamples(user: User) {
  const tz = user.timezone;
  const now = DateTime.now().setZone(tz);
  const d = now.toISODate()!;
  const at = (date: string, hhmm: string) => DateTime.fromISO(`${date}T${hhmm}`, { zone: tz }).toISO()!;
  const cats = listCategories(user.id);
  const cat = (name: string) => cats.find((c) => c.name === name)!.id;

  const goal = (title: string, metric: string, target: number, unit: string, period: string, deadline: string | null = null, reminderDays: number | null = null) => {
    const id = uid();
    run(
      'INSERT INTO goals (id, user_id, title, metric, target, unit, period, start_date, deadline, reminder_days, sample, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)',
      id, user.id, title, metric, target, unit, period, now.startOf('month').toISODate(), deadline, reminderDays, nowIso(),
    );
    return id;
  };
  const gGym = goal('Gym : 5 séances par semaine', 'quantity', 5, 'séances', 'weekly');
  const gCfa = goal('Étudier 6 h pour le CFA', 'duration', 360, 'min', 'weekly');
  const gLeads = goal('Trouver 50 leads MONDAIX', 'quantity', 50, 'leads', 'once', now.endOf('month').toISODate(), 3);
  goal("Boire 2 L d'eau", 'check', 1, '', 'daily');
  goal('Épargner 500 $ ce mois-ci', 'amount', 500, '$', 'monthly');

  // Agenda : rendez-vous fixes et blocs flexibles
  createEvent(user.id, { title: 'Rencontre client MONDAIX', kind: 'fixed', start: at(d, '13:00'), durationMin: 60, location: 'Zoom', reminders: [10] }, true);
  createEvent(user.id, { title: 'Bloc CFA – Éthique', kind: 'flexible', start: at(d, '14:15'), durationMin: 60, priority: 1, preferredWindow: 'apres-midi', reminders: [5], goalIds: [gCfa] }, true);
  createEvent(user.id, { title: 'Appel fournisseur', kind: 'fixed', start: at(d, '15:30'), durationMin: 30, reminders: [10] }, true);
  createEvent(
    user.id,
    { title: 'Séance de gym', kind: 'flexible', start: at(d, '16:15'), durationMin: 60, priority: 2, preferredWindow: '16:00-21:00', rrule: { freq: 'weekly', byDay: [1, 2, 3, 4, 5] }, reminders: [15], goalIds: [gGym] },
    true,
  );
  createEvent(user.id, { title: 'Prospection : 10 leads MONDAIX', kind: 'flexible', planDate: d, durationMin: 60, priority: 1, preferredWindow: 'matin', goalIds: [gLeads] }, true);
  createEvent(user.id, { title: 'Payer la facture Hydro', kind: 'flexible', planDate: d, durationMin: 15, priority: 2, dueAt: at(d, '21:00'), dueReminders: [120] }, true);
  createEvent(user.id, { title: 'Révision CFA – Quantitative', kind: 'flexible', planDate: now.plus({ days: 1 }).toISODate(), durationMin: 90, priority: 2, goalIds: [gCfa] }, true);
  run('UPDATE events SET focus_date = ? WHERE user_id = ? AND sample = 1 AND title IN (?, ?, ?)', d, user.id, 'Bloc CFA – Éthique', 'Prospection : 10 leads MONDAIX', 'Séance de gym');

  // Budget : quelques transactions confirmées
  const tx1 = (days: number, merchant: string, cents: number, c: string, type: any = 'expense') =>
    insertTransaction(user.id, { date: now.minus({ days }).toISODate()!, merchant, amountCents: cents, type, splits: [{ categoryId: cat(c), amountCents: cents }], source: 'manuel', sample: true });
  const day = now.day;
  tx1(Math.min(day - 1, 9), 'Propriétaire', 1200_00, 'Loyer');
  tx1(Math.min(day - 1, 4), 'IGA', 86_45, 'Épicerie');
  tx1(Math.min(day - 1, 2), 'Tim Hortons', 4_85, 'Restaurants et cafés');
  tx1(Math.min(day - 1, 6), 'Shopify', 39_00, 'Logiciels et abonnements');
  tx1(Math.min(day - 1, 3), 'Liquidation Pro', 245_00, 'Inventaire');
  tx1(Math.min(day - 1, 7), 'Employeur', 2100_00, 'Salaire', 'income');

  const rec = (name: string, merchant: string, cents: number, c: string, kind: string, frequency: string, next: string, reminderDays: number | null) =>
    run(
      'INSERT INTO recurring (id, user_id, name, merchant, amount_cents, category_id, kind, frequency, next_date, reminder_days, sample, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)',
      uid(), user.id, name, merchant, cents, cat(c), kind, frequency, next, reminderDays, nowIso(),
    );
  rec('Loyer', 'Propriétaire', 1200_00, 'Loyer', 'expense', 'monthly', now.plus({ months: 1 }).startOf('month').toISODate()!, 3);
  rec('Cellulaire et Internet', 'Vidéotron', 110_00, 'Internet et cellulaire', 'expense', 'monthly', now.plus({ days: 6 }).toISODate()!, 2);
  rec('Netflix', 'Netflix', 18_99, 'Abonnements', 'expense', 'monthly', now.plus({ days: 3 }).toISODate()!, 1);
  rec('Paie', 'Employeur', 2100_00, 'Salaire', 'income', 'biweekly', now.plus({ days: 7 }).toISODate()!, null);
}

export function deleteSamples(userId: string) {
  tx(() => {
    run('DELETE FROM events WHERE user_id = ? AND sample = 1', userId);
    run('DELETE FROM goals WHERE user_id = ? AND sample = 1', userId);
    run('DELETE FROM transactions WHERE user_id = ? AND sample = 1', userId);
    run('DELETE FROM recurring WHERE user_id = ? AND sample = 1', userId);
  });
}

export function hasSamples(userId: string): boolean {
  return Boolean(
    get('SELECT 1 FROM events WHERE user_id = ? AND sample = 1 LIMIT 1', userId) ||
      get('SELECT 1 FROM goals WHERE user_id = ? AND sample = 1 LIMIT 1', userId) ||
      get('SELECT 1 FROM transactions WHERE user_id = ? AND sample = 1 LIMIT 1', userId),
  );
}

export { all };
