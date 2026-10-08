import { isLowConfidence } from '../../shared/invoiceConfidence.js';

const TEXT_FIELDS = ['vendor_name', 'invoice_number', 'invoice_date', 'due_date', 'po_number', 'currency'];
const MONEY_FIELDS = ['net_cents', 'vat_cents', 'gross_cents'];

let testProvider = null;

export class InvoiceOcrError extends Error {
  constructor(message, statusCode = 502, code = 'ocr_failed') {
    super(message);
    this.name = 'InvoiceOcrError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** Tests inject a deterministic extractor. Production never sets this. */
export function setInvoiceOcrProviderForTests(provider) {
  testProvider = provider || null;
}

/**
 * Fail closed. The gateway provider is on only when both env vars are set.
 * A test provider counts as configured for that process.
 */
export function isInvoiceOcrConfigured(env = process.env) {
  if (testProvider) return true;
  const provider = String(env.INVOICE_OCR_PROVIDER || '').trim().toLowerCase();
  if (provider !== 'gateway') return false;
  return String(env.INVOICE_OCR_MODEL || '').trim() !== '';
}

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function emptyText() {
  return { value: null, confidence: 0 };
}

function asTextField(raw, { upper = false, date = false } = {}) {
  if (!raw || typeof raw !== 'object') return emptyText();
  let value = raw.value == null ? '' : String(raw.value).trim();
  if (!value) return { value: null, confidence: clampConfidence(raw.confidence) };
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return emptyText();
  if (upper) value = value.toUpperCase();
  if (value.length > 500) value = value.slice(0, 500);
  return { value, confidence: clampConfidence(raw.confidence) };
}

function asCentsField(raw) {
  if (!raw || typeof raw !== 'object') return { value: null, confidence: 0 };
  if (raw.value == null || raw.value === '') {
    return { value: null, confidence: clampConfidence(raw.confidence) };
  }
  const n = Number(raw.value);
  if (!Number.isSafeInteger(n) || n < 0) return { value: null, confidence: 0 };
  return { value: n, confidence: clampConfidence(raw.confidence) };
}

function asQuantityField(raw) {
  if (!raw || typeof raw !== 'object' || raw.value == null || raw.value === '') {
    return { value: null, confidence: raw ? clampConfidence(raw.confidence) : 0 };
  }
  const n = Number(raw.value);
  if (!Number.isFinite(n) || n <= 0) return { value: null, confidence: 0 };
  return { value: n, confidence: clampConfidence(raw.confidence) };
}

/** Map a provider payload into the proposal field shape. Drops unknown keys. */
export function normalizeExtraction(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const extraction = {};
  for (const field of TEXT_FIELDS) {
    extraction[field] = asTextField(source[field], {
      upper: field === 'currency',
      date: field === 'invoice_date' || field === 'due_date'
    });
  }
  for (const field of MONEY_FIELDS) {
    extraction[field] = asCentsField(source[field]);
  }
  const lines = Array.isArray(source.lines) ? source.lines : [];
  extraction.lines = lines.slice(0, 100).map((line) => ({
    description: asTextField(line?.description),
    quantity: asQuantityField(line?.quantity),
    unit_price_cents: asCentsField(line?.unit_price_cents)
  }));
  return extraction;
}

export function lowConfidenceFieldNames(extraction) {
  const names = [];
  for (const field of [...TEXT_FIELDS, ...MONEY_FIELDS]) {
    if (isLowConfidence(extraction[field]?.confidence)) names.push(field);
  }
  extraction.lines.forEach((line, index) => {
    for (const key of ['description', 'quantity', 'unit_price_cents']) {
      if (isLowConfidence(line[key]?.confidence)) names.push(`lines[${index}].${key}`);
    }
  });
  return names;
}

export async function extractInvoicePdf(pdf, env = process.env) {
  if (!isInvoiceOcrConfigured(env)) {
    throw new InvoiceOcrError(
      'Invoice OCR is not configured. Set INVOICE_OCR_PROVIDER=gateway and INVOICE_OCR_MODEL.',
      503,
      'ocr_not_configured'
    );
  }
  try {
    const raw = testProvider
      ? await testProvider.extract(pdf)
      : await extractWithConfiguredGateway(pdf, env);
    return normalizeExtraction(raw);
  } catch (error) {
    if (error instanceof InvoiceOcrError) throw error;
    if (error?.code === 'ocr_not_configured' || error?.code === 'ocr_provider_unavailable') {
      throw new InvoiceOcrError(error.message, error.statusCode || 503, error.code);
    }
    console.error('invoice OCR:', error?.message || error);
    throw new InvoiceOcrError('Invoice OCR failed', 502, 'ocr_failed');
  }
}

async function extractWithConfiguredGateway(pdf, env) {
  const { extractWithGateway } = await import('./invoiceOcrGateway.js');
  return extractWithGateway(pdf, env);
}
