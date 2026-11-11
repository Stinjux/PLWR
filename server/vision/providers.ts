import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { config } from '../config.ts';
import { findAmounts, findDate, findMerchant } from '../services/expenseParser.ts';
import { type ExtractionResult, type ExtractedTransaction, type VisionProvider, VisionError } from './types.ts';

// ---------------------------------------------------------------------------
// Fournisseur par défaut : Claude (Anthropic), appelé depuis le serveur uniquement.
// ---------------------------------------------------------------------------

const TxSchema = z.object({
  date: z.string().nullable().describe('Date de la transaction au format YYYY-MM-DD, ou null si illisible'),
  merchant: z.string().nullable().describe('Nom du commerçant tel qu’affiché, sans numéro de carte'),
  amount: z.number().nullable().describe('Montant positif, en unités (ex. 72.30)'),
  currency: z.string().nullable().describe('Code ISO 4217 (CAD par défaut si le symbole est $ au Canada)'),
  direction: z.enum(['debit', 'credit']).describe('debit = dépense, credit = remboursement ou dépôt'),
  categoryHint: z.string().nullable().describe('Catégorie probable en français (ex. Essence, Épicerie, Restaurant)'),
  uncertainFields: z.array(z.enum(['date', 'merchant', 'amount', 'currency'])).describe('Champs lus avec incertitude'),
  rawText: z.string().nullable().describe('Texte brut de la ligne'),
});

const ResultSchema = z.object({
  readable: z.boolean(),
  reason: z.string().nullable(),
  documentType: z.enum(['receipt', 'bank_screenshot', 'other']).nullable(),
  transactions: z.array(TxSchema),
});

const SYSTEM = `Tu extrais des transactions financières à partir d'images (reçus, captures d'application bancaire, relevés).
Règles :
- Un reçu = une seule transaction (le TOTAL payé, taxes incluses). Une capture bancaire peut contenir plusieurs transactions : une entrée par ligne.
- Ignore les soldes, les totaux de période et les lignes qui ne sont pas des transactions.
- Les dates relatives (« Aujourd'hui », « Hier ») se calculent à partir de la date du jour fournie. Si l'année manque, choisis l'année la plus récente qui ne soit pas dans le futur.
- Montants : nombre positif. Les virgules décimales françaises (72,30) valent 72.30.
- Ne recopie jamais un numéro de carte complet ; certaines zones peuvent avoir été masquées en noir volontairement.
- Indique dans uncertainFields chaque champ difficile à lire ou deviné.
- Si l'image ne contient aucune transaction lisible, renvoie readable=false avec une raison courte en français.`;

export const anthropicProvider: VisionProvider = {
  name: 'anthropic',
  async extract(image, ctx) {
    if (!config.vision.anthropicKey) throw new VisionError('config', 'Clé ANTHROPIC_API_KEY manquante sur le serveur');
    const client = new Anthropic({ apiKey: config.vision.anthropicKey, timeout: config.vision.timeoutMs, maxRetries: 1 });
    try {
      const response = await client.beta.messages.parse({
        model: config.vision.anthropicModel,
        max_tokens: 8000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low', format: betaZodOutputFormat(ResultSchema) },
        system: SYSTEM,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.toString('base64') } },
              { type: 'text', text: `Date du jour : ${ctx.today} (fuseau America/Toronto). Extrais les transactions de cette image.` },
            ],
          },
        ],
      });
      if (response.stop_reason === 'refusal') throw new VisionError('provider', 'Le fournisseur a refusé de lire cette image');
      if (!response.parsed_output) throw new VisionError('provider', 'Réponse du fournisseur illisible');
      return response.parsed_output as ExtractionResult;
    } catch (e: any) {
      if (e instanceof VisionError) throw e;
      if (e instanceof Anthropic.AuthenticationError) throw new VisionError('config', 'Clé API du fournisseur refusée');
      if (e instanceof Anthropic.RateLimitError) throw new VisionError('provider', 'Fournisseur surchargé (limite atteinte), réessaie plus tard');
      if (e instanceof Anthropic.APIConnectionError) throw new VisionError('provider', 'Fournisseur injoignable');
      if (e instanceof Anthropic.APIError) throw new VisionError('provider', `Erreur du fournisseur (${e.status ?? '?'})`);
      throw new VisionError('provider', 'Lecture impossible');
    }
  },
};

// ---------------------------------------------------------------------------
// Fournisseur « local » : OCR Tesseract + heuristiques. Sans clé, hors ligne,
// moins précis. Utile en secours, en démo et pour les tests.
// ---------------------------------------------------------------------------

const MONTH_ABBR: Record<string, number> = { janv: 1, jan: 1, fevr: 2, fev: 2, feb: 2, mars: 3, mar: 3, avr: 4, apr: 4, mai: 5, may: 5, juin: 6, jun: 6, juil: 7, jul: 7, aout: 8, aug: 8, sept: 9, sep: 9, oct: 10, nov: 11, dec: 12 };

function lineDate(text: string, today: string): string | null {
  const d = findDate(text, 'America/Toronto', DateTime.fromISO(today, { zone: 'America/Toronto' }).set({ hour: 12 }).toJSDate());
  if (d) return d.date;
  const t = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const m = /\b(\d{1,2})\s*([a-z]{3,5})\.?(?![a-z])/.exec(t) || null;
  if (m && MONTH_ABBR[m[2]]) {
    const ref = DateTime.fromISO(today);
    let dt = DateTime.fromObject({ year: ref.year, month: MONTH_ABBR[m[2]], day: +m[1] });
    if (dt > ref) dt = dt.minus({ years: 1 });
    if (dt.isValid) return dt.toISODate();
  }
  return null;
}

export const localProvider: VisionProvider = {
  name: 'local',
  async extract(_image, ctx) {
    const ocr = ctx.ocr;
    if (!ocr || ocr.text.replace(/\s/g, '').length < 6) return { readable: false, reason: 'Aucun texte détecté dans l’image', transactions: [] };
    const lines = ocr.lines.filter((l) => l.text.trim());
    const isReceipt = /\b(sous[- ]?total|total|tps|tvq|gst|qst|hst)\b/i.test(ocr.text) && lines.length > 3;
    const out: ExtractedTransaction[] = [];
    if (isReceipt) {
      const totalLine = [...lines].reverse().find((l) => /\btotal\b/i.test(l.text) && !/sous/i.test(l.text) && findAmounts(l.text.replace(/(\d)\s*$/, '$1 $')).length);
      const amountLine = totalLine?.text || '';
      const amt = findAmounts(/\$/.test(amountLine) ? amountLine : amountLine + ' $');
      const merchantLine = lines.find((l) => /[a-z]{3,}/i.test(l.text) && !/\d{3,}/.test(l.text));
      const date = lines.map((l) => lineDate(l.text, ctx.today)).find(Boolean) || null;
      out.push({
        date,
        merchant: merchantLine ? merchantLine.text.replace(/[^\p{L}\p{N}&' -]/gu, '').trim() : null,
        amount: amt.length ? amt[amt.length - 1].cents / 100 : null,
        currency: 'CAD',
        direction: 'debit',
        categoryHint: null,
        uncertainFields: ['merchant', ...(date ? [] : ['date' as const]), ...((totalLine?.confidence ?? 0) < 80 ? ['amount' as const] : [])],
        rawText: amountLine || null,
      });
    } else {
      let lastDate: string | null = null;
      for (const l of lines) {
        const d = lineDate(l.text, ctx.today);
        const amts = findAmounts(/\$|cad|usd/i.test(l.text) ? l.text : l.text.replace(/(-?\d+[.,]\d{2})(?!\d)/g, '$1 $'));
        if (!amts.length) {
          if (d) lastDate = d;
          continue;
        }
        const a = amts[amts.length - 1];
        let merchant = l.text
          .slice(0, a.index)
          .replace(/\b\d{4}-\d{2}-\d{2}\b/, '')
          .replace(/^\s*\d{1,2}\s*[a-zéû]{3,5}\.?(\s+\d{4})?(?![a-z])/i, '')
          .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/, '')
          .replace(/[|•·]+/g, ' ')
          .replace(/[-–]\s*$/, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (!/[a-z]{2,}/i.test(merchant)) merchant = findMerchant(l.text) || '';
        if (/^(solde|total|balance|disponible)/i.test(merchant)) continue;
        const credit = /(^|\s)\+\s?\d|dépôt|depot|rembours|credit|crédit|virement reçu/i.test(l.text);
        const date = d || lastDate;
        out.push({
          date,
          merchant: merchant || null,
          amount: a.cents / 100,
          currency: a.currency,
          direction: credit ? 'credit' : 'debit',
          categoryHint: null,
          uncertainFields: [...(l.confidence < 80 ? (['merchant', 'amount'] as const) : []), ...(date ? [] : (['date'] as const))],
          rawText: l.text,
        });
      }
    }
    if (!out.length) return { readable: false, reason: 'Aucune transaction reconnue dans le texte de l’image', transactions: [] };
    return { readable: true, documentType: isReceipt ? 'receipt' : 'bank_screenshot', transactions: out };
  },
};

/** Simule une panne du fournisseur (pour tester la saisie manuelle de secours). */
export const mockErrorProvider: VisionProvider = {
  name: 'mock-error',
  async extract() {
    throw new VisionError('provider', 'Erreur simulée du fournisseur de lecture');
  },
};

export function getProvider(name = config.vision.provider): VisionProvider {
  switch (name) {
    case 'local':
      return localProvider;
    case 'mock-error':
      return mockErrorProvider;
    case 'anthropic':
    default:
      return anthropicProvider;
  }
}
