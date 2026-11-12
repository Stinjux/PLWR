export type ExtractedTransaction = {
  date: string | null; // YYYY-MM-DD
  merchant: string | null;
  amount: number | null; // en unités (ex. 72.30)
  currency: string | null; // ISO 4217
  direction: 'debit' | 'credit';
  categoryHint: string | null;
  uncertainFields: ('date' | 'merchant' | 'amount' | 'currency')[];
  rawText: string | null;
};

export type ExtractionResult = {
  readable: boolean;
  reason?: string | null;
  documentType?: 'receipt' | 'bank_screenshot' | 'other' | null;
  transactions: ExtractedTransaction[];
};

export type OcrWord = { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } };
export type OcrLine = { text: string; confidence: number; words: OcrWord[] };
export type OcrResult = { text: string; lines: OcrLine[]; confidence: number };

export interface VisionProvider {
  name: string;
  extract(image: Buffer, ctx: { mime: string; today: string; ocr: OcrResult | null; userId?: string }): Promise<ExtractionResult>;
}

export class VisionError extends Error {
  kind: 'config' | 'provider' | 'unreadable';
  constructor(kind: VisionError['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}
