/**
 * Vision extraction through the Vercel AI Gateway (AI SDK).
 * Loaded only when INVOICE_OCR_PROVIDER=gateway.
 * Tests may import ocrCallLimits. They must not call extractWithGateway.
 *
 * Model id is INVOICE_OCR_MODEL, a gateway string such as google/gemini-2.5-flash.
 * Auth is AI_GATEWAY_API_KEY, or Vercel OIDC when the function runs on Vercel.
 * The PDF bytes are sent inline. They are not uploaded to a public file store.
 */

const PROMPT = [
  'Extract the supplier invoice in this PDF.',
  'Return only the structured object.',
  'Amounts are integer cents of the invoice currency (12.50 is 1250).',
  'Dates are YYYY-MM-DD or null.',
  'confidence is a number from 0 to 1 for that field. Use a low score when the page is unclear.',
  'Lines are the billed rows: description, quantity, and unit price in cents.',
  'Do not invent a vendor, invoice number, or PO number that is not on the page.'
].join(' ');

/** The upload function's maxDuration. Two attempts, one backoff, and app work must fit. */
export const OCR_MAX_DURATION_MS = 60_000;
const OCR_RESERVED_MS = 10_000;
const OCR_RETRY_BACKOFF_MS = 1_000;
const OCR_MAX_RETRIES = 1;

export function ocrAttemptCapMs() {
  return Math.floor((OCR_MAX_DURATION_MS - OCR_RESERVED_MS - OCR_RETRY_BACKOFF_MS) / (OCR_MAX_RETRIES + 1));
}

/** One retry. The timeout is per attempt and is capped so both attempts fit in maxDuration. */
export function ocrCallLimits(env = process.env) {
  const cap = ocrAttemptCapMs();
  const raw = Number(env.INVOICE_OCR_TIMEOUT_MS);
  const requested = Number.isInteger(raw) && raw >= 1000 ? raw : 20000;
  return {
    timeoutMs: Math.min(requested, cap),
    maxRetries: OCR_MAX_RETRIES,
    backoffMs: OCR_RETRY_BACKOFF_MS
  };
}

function unavailable(message) {
  const error = new Error(message);
  error.statusCode = 503;
  error.code = 'ocr_provider_unavailable';
  return error;
}

export async function extractWithGateway(pdf, env = process.env) {
  const modelId = String(env.INVOICE_OCR_MODEL || '').trim();
  if (!modelId) throw unavailable('INVOICE_OCR_MODEL is not set');

  let ai;
  let zod;
  try {
    ai = await import('ai');
    zod = await import('zod');
  } catch (error) {
    throw unavailable(`OCR provider packages are not installed (${error.message})`);
  }

  const { generateText, Output } = ai;
  const { z } = zod;
  const scoredText = z.object({
    value: z.string().nullable(),
    confidence: z.number()
  });
  const scoredCents = z.object({
    value: z.number().int().nullable(),
    confidence: z.number()
  });
  const scoredQty = z.object({
    value: z.number().nullable(),
    confidence: z.number()
  });
  const schema = z.object({
    vendor_name: scoredText,
    invoice_number: scoredText,
    invoice_date: scoredText,
    due_date: scoredText,
    po_number: scoredText,
    currency: scoredText,
    net_cents: scoredCents,
    vat_cents: scoredCents,
    gross_cents: scoredCents,
    lines: z.array(z.object({
      description: scoredText,
      quantity: scoredQty,
      unit_price_cents: scoredCents
    }))
  });

  const limits = ocrCallLimits(env);
  let lastError = null;
  for (let attempt = 0; attempt <= limits.maxRetries; attempt += 1) {
    try {
      const { output } = await generateText({
        model: modelId,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(limits.timeoutMs),
        output: Output.object({
          schema,
          name: 'SupplierInvoice',
          description: 'Fields read from one supplier invoice PDF'
        }),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              {
                type: 'file',
                mediaType: 'application/pdf',
                filename: 'invoice.pdf',
                data: pdf
              }
            ]
          }
        ]
      });
      if (!output || typeof output !== 'object') {
        const error = new Error('Invoice OCR returned no structured fields');
        error.statusCode = 502;
        error.code = 'ocr_failed';
        throw error;
      }
      return output;
    } catch (error) {
      if (error?.code === 'ocr_failed' || error?.code === 'ocr_provider_unavailable') throw error;
      lastError = error;
      const retryable = error?.name === 'AbortError'
        || error?.name === 'TimeoutError'
        || /timeout|network|fetch|ECONN|429|502|503/i.test(String(error?.message || ''));
      if (!retryable || attempt >= limits.maxRetries) break;
      await new Promise((resolve) => {
        setTimeout(resolve, limits.backoffMs);
      });
    }
  }
  const failed = new Error(lastError?.message || 'Invoice OCR failed');
  failed.statusCode = 502;
  failed.code = 'ocr_failed';
  throw failed;
}
