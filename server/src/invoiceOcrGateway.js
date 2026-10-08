/**
 * Vision extraction through the Vercel AI Gateway (AI SDK).
 * Loaded only when INVOICE_OCR_PROVIDER=gateway. Tests do not import this.
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

  const { output } = await generateText({
    model: modelId,
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
}
