import { DateTime } from 'luxon';

export type ParsedExpense = {
  raw: string;
  amountCents: number | null;
  currency: string;
  amountUncertain: boolean;
  merchant: string | null;
  date: string;
  dateLabel: string;
  dateUncertain: boolean;
  budgetKey: 'perso' | 'mondaix' | null;
  type: 'expense' | 'refund' | 'income';
  hint: string;
};

const MONTHS = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];
const MONTHS_SHORT = ['janv', 'fevr', 'mars', 'avr', 'mai', 'juin', 'juil', 'aout', 'sept', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

const KNOWN_MERCHANTS = [
  'Shell', 'Esso', 'Petro-Canada', 'Ultramar', 'Couche-Tard', 'Irving', 'Costco', 'IGA', 'Metro', 'Maxi', 'Provigo', 'Super C', 'Loblaws',
  'Walmart', 'Amazon', 'Tim Hortons', 'Starbucks', 'SAQ', 'Jean Coutu', 'Pharmaprix', 'Uniprix', 'Familiprix', 'Uber Eats', 'Uber', 'DoorDash',
  'Dollarama', 'Canadian Tire', 'Home Depot', 'Rona', 'IKEA', 'Best Buy', 'Netflix', 'Spotify', 'Bell', 'Vidéotron', 'Fizz', 'Hydro-Québec',
  "McDonald's", 'Subway', 'A&W', 'Shopify', 'Canva', 'Postes Canada', 'Purolator', 'Alibaba', 'Simons', 'Winners', 'Énergie Cardio', 'STM',
  'Apple', 'Google', 'Meta', 'Bureau en Gros', 'Sobeys', 'Adonis',
];

export const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function toCents(num: string): number {
  const clean = num.replace(/[\s  ]/g, '').replace(',', '.');
  return Math.round(parseFloat(clean) * 100);
}

const NUM = String.raw`\d{1,3}(?:[   ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
const CUR_AFTER = String.raw`\$\s*(?:can|cad|us|usd)?|cad\b|usd\b|us\$|dollars?\s*(?:us|americains?|canadiens?)?|piasses?\b|piastres?\b|€|eur\b|euros?\b`;

type AmountMatch = { index: number; end: number; cents: number; currency: string; uncertain: boolean };

/** Trouve les montants dans un texte (« 72,30 $ », « 72$30 », « $12.50 », « 1 250 $ », « 40 USD », « payé 45 »). */
export function findAmounts(text: string): AmountMatch[] {
  const t = text.replace(/ | /g, ' ');
  const out: AmountMatch[] = [];
  const taken = (i: number, e: number) => out.some((m) => i < m.end && e > m.index);
  const currencyOf = (s: string) => {
    const x = strip(s);
    if (/us|americ/.test(x)) return 'USD';
    if (/€|eur/.test(x)) return 'EUR';
    return 'CAD';
  };
  // 72$30 (style québécois)
  for (const m of t.matchAll(/(\d+)\s?\$\s?(\d{2})\b/g)) {
    out.push({ index: m.index!, end: m.index! + m[0].length, cents: parseInt(m[1]) * 100 + parseInt(m[2]), currency: 'CAD', uncertain: false });
  }
  for (const m of t.matchAll(new RegExp(`(${NUM})\\s*(${CUR_AFTER})`, 'gi'))) {
    if (taken(m.index!, m.index! + m[0].length)) continue;
    out.push({ index: m.index!, end: m.index! + m[0].length, cents: toCents(m[1]), currency: currencyOf(m[2]), uncertain: false });
  }
  for (const m of t.matchAll(new RegExp(`(\\$|cad|usd|us\\$)\\s*(${NUM})`, 'gi'))) {
    if (taken(m.index!, m.index! + m[0].length)) continue;
    out.push({ index: m.index!, end: m.index! + m[0].length, cents: toCents(m[2]), currency: currencyOf(m[1]), uncertain: false });
  }
  // Montant sans devise après un verbe de paiement
  for (const m of t.matchAll(new RegExp(`\\b(?:pay[ée]e?s?|d[ée]pens[ée]e?s?|co[uû]t[ée]|mis|donn[ée]|factur[ée]|total(?:\\s+de)?|montant(?:\\s+de)?)\\s+(${NUM})(?!\\s*(?:h\\b|min|jours?|km|%|fois|\\d))`, 'gi'))) {
    const start = m.index! + m[0].lastIndexOf(m[1]);
    if (taken(start, start + m[1].length)) continue;
    out.push({ index: start, end: start + m[1].length, cents: toCents(m[1]), currency: 'CAD', uncertain: true });
  }
  return out.filter((m) => m.cents > 0).sort((a, b) => a.index - b.index);
}

export function parseAmountReply(text: string): { cents: number; currency: string } | null {
  const a = findAmounts(text)[0];
  if (a) return { cents: a.cents, currency: a.currency };
  const m = new RegExp(`^\\s*(?:c'?est\\s+|environ\\s+)?(${NUM})\\s*$`, 'i').exec(text.trim());
  return m ? { cents: toCents(m[1]), currency: 'CAD' } : null;
}

type DateResult = { date: string; label: string; uncertain: boolean };

/** Interprète les dates relatives (« hier », « ce matin », « lundi », « le 3 novembre ») dans le fuseau de l'utilisateur. */
export function findDate(text: string, tz: string, now: Date): DateResult | null {
  const t = strip(text);
  const base = DateTime.fromJSDate(now, { zone: tz }).startOf('day').setLocale('fr-CA');
  const res = (d: DateTime, label: string, uncertain = false): DateResult => ({ date: d.toISODate()!, label, uncertain });
  if (/\bavant[- ]hier\b/.test(t)) return res(base.minus({ days: 2 }), 'Avant-hier');
  if (/\bhier\b/.test(t)) return res(base.minus({ days: 1 }), 'Hier');
  if (/\b(aujourd'?hui|ce matin|ce midi|cet apres[- ]midi|ce soir|tantot|a matin|plus tot)\b/.test(t)) return res(base, "Aujourd'hui");
  let m = /\bil y a (\d+) jours?\b/.exec(t);
  if (m) return res(base.minus({ days: +m[1] }), `Il y a ${m[1]} jours`);
  if (/\bla semaine (derniere|passee)\b/.test(t)) return res(base.minus({ days: 7 }), 'La semaine dernière', true);
  m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t);
  if (m) {
    const d = DateTime.fromObject({ year: +m[1], month: +m[2], day: +m[3] }, { zone: tz });
    if (d.isValid) return res(d, d.setLocale('fr-CA').toFormat('d LLLL yyyy'));
  }
  m = new RegExp(`\\b(\\d{1,2})(?:er)?\\s+(${MONTHS.join('|')}|${MONTHS_SHORT.join('|')})\\.?(?:\\s+(\\d{4}))?\\b`).exec(t);
  if (m) {
    let month = MONTHS.indexOf(m[2]) + 1 || MONTHS_SHORT.indexOf(m[2]) + 1;
    let d = DateTime.fromObject({ year: m[3] ? +m[3] : base.year, month, day: +m[1] }, { zone: tz });
    if (!m[3] && d > base) d = d.minus({ years: 1 });
    if (d.isValid) return res(d, d.setLocale('fr-CA').toFormat('d LLLL yyyy'));
  }
  m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(t);
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : base.year;
    let d = DateTime.fromObject({ year: y, month: +m[2], day: +m[1] }, { zone: tz });
    if (!m[3] && d > base) d = d.minus({ years: 1 });
    if (d.isValid) return res(d, d.setLocale('fr-CA').toFormat('d LLLL yyyy'), +m[1] <= 12 && +m[2] <= 12);
  }
  m = new RegExp(`\\b(${WEEKDAYS.join('|')})( dernier| passe)?\\b`).exec(t);
  if (m) {
    const wd = WEEKDAYS.indexOf(m[1]) + 1;
    let diff = (base.weekday - wd + 7) % 7;
    if (diff === 0 && m[2]) diff = 7;
    const d = base.minus({ days: diff });
    return res(d, diff === 0 ? "Aujourd'hui" : `${m[1][0].toUpperCase()}${m[1].slice(1)} dernier`);
  }
  return null;
}

function titleCase(s: string): string {
  if (/[A-Z]/.test(s)) return s;
  return s.replace(/(^|[\s-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
}

export function findMerchant(text: string): string | null {
  const t = text.replace(/ /g, ' ');
  const stop = String.raw`(?=\s+(?:pour|hier|avant-hier|aujourd|ce\s|cet\s|cette\s|il\s+y\s+a|le\s+\d|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|et\s|avec\s|en\s|à\s+\d|a\s+\d|vers|pis|ou\s|car\s|parce|sur\s|la\s+semaine|\d)|\s*[,.;!?()]|\s*$|\s+\d)`;
  const re = new RegExp(String.raw`(?:^|\s)(?:chez|au|aux|à\s+la|a\s+la|à\s+l'|a\s+l'|à|@)\s+(?!\d)([\p{L}\p{N}&'’.\- ]{2,40}?)` + stop, 'iu');
  const m = re.exec(t);
  if (m) {
    const cand = m[1].trim().replace(/^(?:la|le|les|l')\s*/i, '');
    const known = KNOWN_MERCHANTS.find((k) => strip(k) === strip(cand)) || KNOWN_MERCHANTS.find((k) => new RegExp(`(^|[^a-z])${strip(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(strip(cand)));
    if (known) return known;
    if (!/^(la|le|maison|domicile|l'?epicerie|la station|mon|ma|mes|moi|toi)$/i.test(strip(cand))) return titleCase(cand);
  }
  const s = strip(t);
  for (const k of KNOWN_MERCHANTS) {
    const kk = strip(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^a-z])${kk}([^a-z]|$)`).test(s)) return k;
  }
  return null;
}

export function findBudget(text: string): 'perso' | 'mondaix' | null {
  const t = strip(text);
  if (/\bmondaix\b|\bla business\b|\bl'entreprise\b|\bla compagnie\b/.test(t)) return 'mondaix';
  if (/\b(perso|personnel|personnelle)\b/.test(t)) return 'perso';
  return null;
}

const EXPENSE_INTENT = /\b(pay|paye|achet|depens|mis|plein|essence|epicerie|resto|facture|abonnement|commande|cafe|lunch|souper|diner|chez|depense|achat|frais)/;

function splitClauses(text: string): string[] {
  return text
    .split(/\n|;|\s+(?:et|puis|aussi|ainsi que|plus)\s+(?=[^,]*?\d)|,\s+(?=(?:et\s+|puis\s+)?(?:j'ai|j’ai|\d|\$))/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Analyse un message en français courant et renvoie une ou plusieurs dépenses. */
export function parseExpenses(text: string, tz: string, now: Date = new Date()): { items: ParsedExpense[]; intent: boolean } {
  const clauses = splitClauses(text);
  const groups: string[] = [];
  let pendingPrefix = '';
  for (const c of clauses) {
    const has = findAmounts(c).length > 0;
    if (has) {
      groups.push((pendingPrefix ? pendingPrefix + ' ' : '') + c);
      pendingPrefix = '';
    } else if (groups.length) groups[groups.length - 1] += ' ' + c;
    else pendingPrefix = (pendingPrefix ? pendingPrefix + ' ' : '') + c;
  }
  if (!groups.length) {
    const intent = EXPENSE_INTENT.test(strip(text)) || findMerchant(text) !== null;
    if (!intent) return { items: [], intent: false };
    groups.push(text);
  }
  const globalDate = findDate(text, tz, now);
  const globalBudget = /^\s*pour\s+mondaix/i.test(text) ? 'mondaix' : null;
  const todayLabel = { date: DateTime.fromJSDate(now, { zone: tz }).toISODate()!, label: "Aujourd'hui", uncertain: false };
  const items = groups.map((g): ParsedExpense => {
    const amounts = findAmounts(g);
    const a = amounts[0];
    const d = findDate(g, tz, now) || globalDate || todayLabel;
    const st = strip(g);
    const type: ParsedExpense['type'] = /\b(rembours|retour|credit)/.test(st) ? 'refund' : /\b(paie|salaire|recu un virement|vente|vendu)\b/.test(st) ? 'income' : 'expense';
    return {
      raw: g.trim(),
      amountCents: a ? a.cents : null,
      currency: a ? a.currency : 'CAD',
      amountUncertain: a ? a.uncertain || amounts.length > 1 : false,
      merchant: findMerchant(g),
      date: d.date,
      dateLabel: d.label,
      dateUncertain: d.uncertain,
      budgetKey: findBudget(g) || globalBudget,
      type,
      hint: g,
    };
  });
  return { items, intent: true };
}
