// Tests unitaires : node --test server/tests/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { parseExpenses, parseAmountReply } from '../services/expenseParser.ts';
import { planDay } from '../services/planner.ts';
import { expandRule, type Occurrence } from '../services/events.ts';
import { applyQuietHours } from '../services/reminders.ts';
import { findCardNumberBoxes, maskCardText } from '../vision/ocr.ts';
import { DEFAULT_SETTINGS } from '../auth.ts';

const TZ = 'America/Toronto';
const NOW = new Date('2026-11-11T17:00:00Z'); // mercredi 11 nov., 12 h à Toronto

test('phrase simple : montant, commerçant, date relative', () => {
  const [e] = parseExpenses('J’ai mis 72,30 $ d’essence hier chez Shell', TZ, NOW).items;
  assert.equal(e.amountCents, 7230);
  assert.equal(e.merchant, 'Shell');
  assert.equal(e.date, '2026-11-10');
  assert.equal(e.currency, 'CAD');
  assert.equal(e.budgetKey, null);
});

test('« ce matin » se calcule dans le fuseau de Toronto, même après minuit UTC', () => {
  const lateEvening = new Date('2026-11-12T03:30:00Z'); // 22 h 30 le 11 à Toronto
  const [e] = parseExpenses('Café 4,50 $ chez Tim Hortons ce matin', TZ, lateEvening).items;
  assert.equal(e.date, '2026-11-11');
});

test('deux dépenses dans le même message, budget MONDAIX', () => {
  const items = parseExpenses('12 $ chez Tim Hortons ce matin et 45,60 $ chez Costco pour MONDAIX', TZ, NOW).items;
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => [i.amountCents, i.merchant, i.budgetKey]), [
    [1200, 'Tim Hortons', null],
    [4560, 'Costco', 'mondaix'],
  ]);
});

test('formats de montants québécois', () => {
  const amt = (s: string) => parseExpenses(s, TZ, NOW).items[0]?.amountCents;
  assert.equal(amt('72$30 essence chez Esso'), 7230);
  assert.equal(amt('1 250,00 $ loyer'), 125000);
  assert.equal(amt('$12.50 chez Subway'), 1250);
  assert.equal(parseExpenses('40 USD chez Amazon', TZ, NOW).items[0].currency, 'USD');
  assert.equal(parseAmountReply('58,10')?.cents, 5810);
});

test('dépense sans montant : détectée, montant manquant', () => {
  const r = parseExpenses('J’ai fait le plein chez Esso ce matin', TZ, NOW);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].amountCents, null);
  assert.equal(r.items[0].merchant, 'Esso');
});

test('message sans dépense', () => {
  assert.equal(parseExpenses('Bonjour !', TZ, NOW).items.length, 0);
});

const occ = (o: Partial<Occurrence> & { id: string; title: string; kind: 'fixed' | 'flexible' }): Occurrence => ({
  eventId: o.id,
  seriesId: null,
  recurrenceId: null,
  start: null,
  end: null,
  durationMin: 60,
  dueAt: null,
  priority: 2,
  preferredWindow: null,
  planDate: null,
  location: null,
  notes: null,
  rrule: null,
  status: 'active',
  focusDate: null,
  reminders: [],
  dueReminders: [],
  goalIds: [],
  isRecurring: false,
  sample: false,
  ownerId: 'u1',
  visibility: 'details',
  participantIds: [],
  ...o,
});
const at = (hhmm: string, date = '2026-11-11') => DateTime.fromISO(`${date}T${hhmm}`, { zone: TZ }).toUTC().toISO()!;

test('rencontre prolongée de 45 min : le bloc CFA est déplacé, les rendez-vous fixes restent', () => {
  const r = planDay({
    date: '2026-11-11',
    tz: TZ,
    now: new Date(at('12:00')),
    settings: DEFAULT_SETTINGS,
    occurrences: [
      occ({ id: 'meeting', title: 'Rencontre', kind: 'fixed', start: at('13:00'), end: at('14:45') }), // prolongée
      occ({ id: 'cfa', title: 'Bloc CFA', kind: 'flexible', start: at('14:15'), end: at('15:15'), priority: 1, preferredWindow: 'apres-midi' }),
      occ({ id: 'call', title: 'Appel', kind: 'fixed', start: at('15:30'), end: at('16:00') }),
      occ({ id: 'gym', title: 'Gym', kind: 'flexible', start: at('16:00'), end: at('17:00'), preferredWindow: '16:00-21:00' }),
    ],
    unscheduled: [],
  });
  const moved = Object.fromEntries(r.changes.map((c) => [c.id, c]));
  assert.ok(moved.cfa, 'le bloc CFA doit être déplacé');
  assert.ok(!moved.meeting && !moved.call, 'les rendez-vous fixes ne bougent pas');
  // Aucun chevauchement avec les fixes (battement de 10 min) ni avec le souper
  const busy = [
    [at('13:00'), at('14:45')],
    [at('15:30'), at('16:00')],
    [at('18:00'), at('18:45')],
  ];
  for (const c of r.changes) for (const [s, e] of busy) assert.ok(c.to.end <= s || c.to.start >= e, `${c.title} chevauche ${s}`);
  // La gym (16 h) chevauche le battement après l'appel : elle est replacée elle aussi
  assert.ok(moved.gym, 'la séance de gym est replacée');
  assert.ok(moved.gym.to.start >= at('16:00'));
  assert.equal(r.postponed.length, 0);
});

test('journée trop pleine : tâche à reporter avec un autre créneau proposé', () => {
  const r = planDay({
    date: '2026-11-11',
    tz: TZ,
    now: new Date(at('20:00')),
    settings: DEFAULT_SETTINGS,
    occurrences: [],
    unscheduled: [occ({ id: 't', title: 'Rapport', kind: 'flexible', durationMin: 180 })],
    futureDays: [{ date: '2026-11-12', occurrences: [] }],
  });
  assert.equal(r.postponed.length, 1);
  assert.equal(r.postponed[0].suggestion?.start, at('07:00', '2026-11-12'));
  assert.ok(r.overloaded);
});

test('récurrence hebdomadaire : l’heure locale est conservée au changement d’heure', () => {
  const starts = expandRule(at('18:00', '2026-10-26'), { freq: 'weekly', byDay: [1] }, TZ, at('00:00', '2026-10-26'), at('00:00', '2026-11-17'));
  const local = starts.map((s) => DateTime.fromISO(s).setZone(TZ).toFormat('yyyy-LL-dd HH:mm'));
  assert.deepEqual(local, ['2026-10-26 18:00', '2026-11-02 18:00', '2026-11-09 18:00', '2026-11-16 18:00']);
});

test('heures silencieuses : un rappel à 23 h est décalé à 7 h', () => {
  const user = { id: 'u', email: '', name: '', timezone: TZ, settings: DEFAULT_SETTINGS };
  const r = applyQuietHours(DateTime.fromISO(at('23:00')), user);
  assert.ok(r.deferred);
  assert.equal(r.at.setZone(TZ).toFormat('yyyy-LL-dd HH:mm'), '2026-11-12 07:00');
  assert.equal(applyQuietHours(DateTime.fromISO(at('09:00')), user).deferred, false);
});

test('numéros de carte : zones repérées et texte masqué', () => {
  const w = (text: string, x: number) => ({ text, confidence: 95, bbox: { x0: x, y0: 0, x1: x + 50, y1: 20 } });
  const boxes = findCardNumberBoxes({ text: '', confidence: 90, lines: [{ text: '', confidence: 90, words: [w('Carte', 0), w('4520', 60), w('1234', 120), w('5678', 180), w('9012', 240)] }] });
  assert.equal(boxes.length, 1);
  assert.equal(maskCardText('Visa 4520 1234 5678 9012'), 'Visa •••• 9012');
  assert.equal(findCardNumberBoxes({ text: '', confidence: 90, lines: [{ text: '', confidence: 90, words: [w('72,30', 0), w('$', 60)] }] }).length, 0);
});

test('récurrences façon Outlook : tous les 2 jours, 2e mardi du mois, dernier vendredi, après N occurrences, annuelle', () => {
  const local = (xs: string[]) => xs.map((x) => DateTime.fromISO(x).setZone(TZ).toFormat('yyyy-LL-dd HH:mm'));
  assert.deepEqual(local(expandRule(at('09:00', '2026-11-02'), { freq: 'daily', interval: 2, count: 3 }, TZ, at('00:00', '2026-11-01'), at('00:00', '2026-12-01'))), [
    '2026-11-02 09:00', '2026-11-04 09:00', '2026-11-06 09:00',
  ]);
  assert.deepEqual(local(expandRule(at('18:00', '2026-11-10'), { freq: 'monthly', byDay: [2], bySetPos: 2 }, TZ, at('00:00', '2026-11-01'), at('00:00', '2027-02-01'))), [
    '2026-11-10 18:00', '2026-12-08 18:00', '2027-01-12 18:00',
  ]);
  assert.deepEqual(local(expandRule(at('16:00', '2026-11-27'), { freq: 'monthly', byDay: [5], bySetPos: -1 }, TZ, at('00:00', '2026-11-01'), at('00:00', '2027-01-01'))), [
    '2026-11-27 16:00', '2026-12-25 16:00',
  ]);
  assert.deepEqual(local(expandRule(at('07:00', '2026-11-09'), { freq: 'weekly', byDay: [1, 2, 3, 4, 5], until: '2026-11-11' }, TZ, at('00:00', '2026-11-01'), at('00:00', '2026-12-01'))), [
    '2026-11-09 07:00', '2026-11-10 07:00', '2026-11-11 07:00',
  ]);
  assert.equal(expandRule(at('10:00', '2026-03-15'), { freq: 'yearly' }, TZ, at('00:00', '2026-01-01'), at('00:00', '2029-01-01')).length, 3);
});
