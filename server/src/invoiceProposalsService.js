import { isLowConfidence } from '../../shared/invoiceConfidence.js';
import { deploymentCurrency, withDeploymentCurrency } from './currencyConfig.js';
import { appendComplianceEvent, utcTimestamp } from './complianceAudit.js';
import { createSupplierInvoice } from './invoicesService.js';
import { prepareInboundInvoice } from './integrationConnectors.js';
import { InvoiceOcrError, extractInvoicePdf, isInvoiceOcrConfigured, lowConfidenceFieldNames } from './invoiceOcr.js';
import { isPdfBuffer, safePdfFilename, sha256Pdf } from './invoicePdf.js';
import {
  WEBHOOK_EVENTS,
  enqueueWebhook,
  kickWebhookDispatch
} from './webhookOutbox.js';

const INVOICEABLE = new Set(['issued', 'acknowledged', 'partially_received', 'received']);
const TEXT_FIELDS = ['vendor_name', 'invoice_number', 'invoice_date', 'due_date', 'po_number', 'currency'];
const MONEY_FIELDS = ['net_cents', 'vat_cents', 'gross_cents'];

export class InvoiceProposalError extends Error {
  constructor(message, statusCode = 400, code = 'invalid_proposal', extra = {}) {
    super(message);
    this.name = 'InvoiceProposalError';
    this.statusCode = statusCode;
    this.code = code;
    if (extra.blockers) this.blockers = extra.blockers;
  }
}

/**
 * Default enforce. Only the exact value `off` disables the check.
 * `off` is for a single-person tenant, where the same user uploads and posts.
 */
export function invoiceProposalSodEnforced(env = process.env) {
  return String(env.INVOICE_PROPOSAL_SOD ?? 'enforce').trim().toLowerCase() !== 'off';
}

export function invoiceProposalConfig(env = process.env) {
  return {
    enabled: isInvoiceOcrConfigured(env),
    sod: invoiceProposalSodEnforced(env) ? 'enforce' : 'off'
  };
}

function fold(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function sameValue(left, right) {
  if (left == null && right == null) return true;
  if (typeof left === 'number' || typeof right === 'number') {
    if (left == null || right == null) return false;
    return Number(left) === Number(right);
  }
  return String(left) === String(right);
}

function pubSupplier(row) {
  return { id: Number(row.id), name: row.name, code: row.code };
}

function pubPo(row) {
  return {
    id: Number(row.id),
    po_number: row.po_number,
    supplier_id: Number(row.supplier_id),
    status: row.status
  };
}

function presentScored(field) {
  const value = field?.value ?? null;
  const confidence = field?.confidence ?? 0;
  return { value, confidence, highlight: isLowConfidence(confidence) };
}

async function matchVendor(db, vendorName) {
  const suppliers = await db.prepare(
    `SELECT id, name, code FROM suppliers WHERE status != 'inactive' ORDER BY name`
  ).all();
  const target = fold(vendorName);
  if (!target) return { status: 'unmatched', supplier_id: null, suggestions: [] };
  const exact = suppliers.filter((row) => fold(row.name) === target || fold(row.code) === target);
  if (exact.length === 1) {
    return { status: 'exact', supplier_id: Number(exact[0].id), suggestions: exact.map(pubSupplier) };
  }
  if (exact.length > 1) {
    return { status: 'ambiguous', supplier_id: null, suggestions: exact.map(pubSupplier) };
  }
  const partial = suppliers.filter((row) => {
    const name = fold(row.name);
    if (!name) return false;
    const shorter = Math.min(name.length, target.length);
    return shorter >= 4 && (name.includes(target) || target.includes(name));
  });
  if (partial.length === 1) {
    return {
      status: 'suggested',
      supplier_id: Number(partial[0].id),
      suggestions: partial.map(pubSupplier)
    };
  }
  return {
    status: partial.length ? 'ambiguous' : 'unmatched',
    supplier_id: null,
    suggestions: partial.slice(0, 5).map(pubSupplier)
  };
}

async function matchPurchaseOrder(db, poNumber, supplierId) {
  const number = String(poNumber || '').trim();
  if (number) {
    const po = await db.prepare(
      `SELECT id, po_number, supplier_id, status FROM purchase_orders WHERE po_number = ?`
    ).get(number);
    if (po) {
      if (!INVOICEABLE.has(po.status)) {
        return { status: 'not_issued', po_id: null, suggestions: [pubPo(po)] };
      }
      if (supplierId && Number(po.supplier_id) !== Number(supplierId)) {
        return { status: 'vendor_mismatch', po_id: null, suggestions: [pubPo(po)] };
      }
      return {
        status: 'exact',
        po_id: Number(po.id),
        supplier_id: Number(po.supplier_id),
        suggestions: [pubPo(po)]
      };
    }
  }
  if (supplierId) {
    const rows = await db.prepare(`
      SELECT id, po_number, supplier_id, status FROM purchase_orders
      WHERE supplier_id = ?
        AND status IN ('issued', 'acknowledged', 'partially_received', 'received')
      ORDER BY id DESC
      LIMIT 5
    `).all(supplierId);
    if (rows.length === 1) {
      return { status: 'suggested', po_id: Number(rows[0].id), suggestions: rows.map(pubPo) };
    }
    return {
      status: rows.length ? 'ambiguous' : 'unmatched',
      po_id: null,
      suggestions: rows.map(pubPo)
    };
  }
  return { status: 'unmatched', po_id: null, suggestions: [] };
}

async function mapLines(db, ocrLines, poId) {
  const poItems = poId
    ? await db.prepare(
      `SELECT id, po_id, item_description FROM po_items WHERE po_id = ? ORDER BY id`
    ).all(poId)
    : [];
  const unused = poItems.map((item) => ({ ...item, used: false }));
  return ocrLines.map((line) => {
    const desc = fold(line.description?.value);
    let chosen = null;
    const open = unused.filter((item) => !item.used);
    if (ocrLines.length === 1 && open.length === 1) {
      chosen = open[0];
    } else if (desc) {
      const scored = open.map((item) => {
        const itemDesc = fold(item.item_description);
        let score = 0;
        if (itemDesc && itemDesc === desc) score = 100;
        else if (
          itemDesc
          && Math.min(itemDesc.length, desc.length) >= 4
          && (itemDesc.includes(desc) || desc.includes(itemDesc))
        ) score = 70;
        return { item, score };
      }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
      if (scored.length === 1 || (scored.length > 1 && scored[0].score > scored[1].score)) {
        chosen = scored[0].item;
      }
    }
    if (chosen) chosen.used = true;
    return {
      description: line.description?.value ?? null,
      quantity: line.quantity?.value ?? null,
      unit_price_cents: line.unit_price_cents?.value ?? null,
      po_item_id: chosen ? Number(chosen.id) : null
    };
  });
}

function inboundBody(proposalId, working) {
  const body = {
    external_id: proposalId ? `proposal-${proposalId}` : 'proposal-preview',
    invoice_number: working.invoice_number,
    po_id: working.po_id,
    supplier_id: working.supplier_id,
    currency: working.currency,
    invoice_date: working.invoice_date,
    tax_amount: working.vat_cents == null ? 0 : working.vat_cents,
    notes: proposalId ? `Posted from invoice proposal ${proposalId}` : null,
    lines: (working.lines || []).map((line) => ({
      po_item_id: line.po_item_id,
      description: line.description,
      quantity_invoiced: line.quantity,
      unit_price: line.unit_price_cents
    }))
  };
  if (working.due_date) body.due_date = working.due_date;
  return body;
}

const TOTALS_BLOCKERS = new Set(['lines_net_mismatch', 'gross_mismatch']);

function totalsBlockers(working) {
  const blockers = [];
  const lines = Array.isArray(working?.lines) ? working.lines : [];
  let lineNet = 0;
  let linesOk = lines.length > 0;
  for (const line of lines) {
    const qty = Number(line?.quantity);
    const price = Number(line?.unit_price_cents);
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isSafeInteger(price) || price < 0) {
      linesOk = false;
      break;
    }
    const total = qty * price;
    if (!Number.isSafeInteger(total)) {
      linesOk = false;
      break;
    }
    lineNet += total;
  }
  if (!linesOk || (working?.net_cents != null && Number(working.net_cents) !== lineNet)) {
    blockers.push('lines_net_mismatch');
  }
  const net = Number(working?.net_cents);
  const vat = working?.vat_cents == null || working?.vat_cents === '' ? 0 : Number(working.vat_cents);
  const gross = working?.gross_cents == null || working?.gross_cents === '' ? null : Number(working.gross_cents);
  if (gross != null && Number.isSafeInteger(net) && Number.isSafeInteger(vat) && net + vat !== gross) {
    blockers.push('gross_mismatch');
  }
  return blockers;
}

function withTotalsOverride(blockers, overrideReason) {
  const reason = String(overrideReason || '').trim();
  if (!blockers.length) return { ready: true, blockers, override: null };
  if (reason.length > 0 && reason.length <= 500 && blockers.every((code) => TOTALS_BLOCKERS.has(code))) {
    return { ready: true, blockers, override: reason };
  }
  return { ready: false, blockers, override: null };
}

export async function previewProposal(db, proposalId, working, { overrideReason = '' } = {}) {
  const blockers = [];
  if (!working?.supplier_id) blockers.push('vendor_unmatched');
  if (!working?.po_id) blockers.push('po_unmatched');
  if (!working?.invoice_number) blockers.push('invoice_number_required');
  if (!working?.invoice_date) blockers.push('invoice_date_required');
  if (!working?.currency) blockers.push('currency_required');
  else if (String(working.currency).toUpperCase() !== deploymentCurrency()) blockers.push('currency_mismatch');
  const lines = Array.isArray(working?.lines) ? working.lines : [];
  if (lines.length === 0 || lines.some((line) => !line?.po_item_id)) blockers.push('line_unmapped');
  if (blockers.length) {
    return {
      ready: false,
      blockers,
      match: null,
      duplicate_status: null,
      duplicate_suspects: [],
      exception: null
    };
  }
  try {
    const prepared = await prepareInboundInvoice(db, inboundBody(proposalId, working));
    const dry = await createSupplierInvoice(db, {
      header: prepared.header,
      lines: prepared.lines,
      source: 'ui',
      dryRun: true
    });
    const gross = working.gross_cents == null ? null : Number(working.gross_cents);
    const totals = withTotalsOverride(totalsBlockers(working), overrideReason);
    return {
      ready: totals.ready,
      blockers: totals.blockers,
      totals_override: totals.override,
      match: {
        match_status: dry.matchOutcome.overallMatchStatus,
        status: dry.matchOutcome.invoiceStatus
      },
      duplicate_status: dry.duplicate_status,
      duplicate_suspects: dry.duplicate_suspects,
      exception: dry.exception,
      currency: dry.currency,
      subtotal: dry.subtotal,
      tax_amount: dry.tax_amount,
      total_amount: dry.total_amount,
      gross_cents: gross,
      gross_check: gross == null || gross === dry.total_amount ? 'ok' : 'mismatch'
    };
  } catch (error) {
    return {
      ready: false,
      blockers: [error.code || 'proposal_not_ready'],
      message: error.message,
      match: null,
      duplicate_status: null,
      duplicate_suspects: [],
      exception: null
    };
  }
}

function nullableInt(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new InvoiceProposalError('Amount and id fields must be integers', 400, 'invalid_proposal');
  }
  return n;
}

function nullableText(value, max = 500) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, max);
}

function nullableDate(value, field) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new InvoiceProposalError(`${field} must be YYYY-MM-DD`, 400, 'invalid_date');
  }
  return text;
}

export function parseWorkingCopy(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new InvoiceProposalError('Proposal fields are required', 400, 'invalid_proposal');
  }
  const lines = Array.isArray(body.lines) ? body.lines : [];
  return {
    vendor_name: nullableText(body.vendor_name),
    supplier_id: nullableInt(body.supplier_id),
    invoice_number: nullableText(body.invoice_number, 80),
    invoice_date: nullableDate(body.invoice_date, 'invoice_date'),
    due_date: nullableDate(body.due_date, 'due_date'),
    po_number: nullableText(body.po_number, 80),
    po_id: nullableInt(body.po_id),
    currency: body.currency == null || String(body.currency).trim() === ''
      ? null
      : String(body.currency).trim().toUpperCase(),
    net_cents: nullableInt(body.net_cents),
    vat_cents: nullableInt(body.vat_cents),
    gross_cents: nullableInt(body.gross_cents),
    lines: lines.map((line) => ({
      description: nullableText(line?.description, 2000),
      quantity: line?.quantity == null || line.quantity === '' ? null : Number(line.quantity),
      unit_price_cents: nullableInt(line?.unit_price_cents),
      po_item_id: nullableInt(line?.po_item_id)
    }))
  };
}

function workingFromExtraction(extraction, vendor, po, lines) {
  return {
    vendor_name: extraction.vendor_name.value,
    supplier_id: vendor.supplier_id,
    invoice_number: extraction.invoice_number.value,
    invoice_date: extraction.invoice_date.value,
    due_date: extraction.due_date.value,
    po_number: extraction.po_number.value,
    po_id: po.po_id,
    currency: extraction.currency.value,
    net_cents: extraction.net_cents.value,
    vat_cents: extraction.vat_cents.value,
    gross_cents: extraction.gross_cents.value,
    lines
  };
}

function unboundGuess(match, idKey) {
  if (match.status === 'exact') return match;
  return { ...match, [idKey]: null };
}

async function resolveExtraction(db, extraction) {
  const vendorMatch = await matchVendor(db, extraction.vendor_name.value);
  const vendorForPo = vendorMatch.status === 'exact' ? vendorMatch.supplier_id : null;
  const poMatch = await matchPurchaseOrder(db, extraction.po_number.value, vendorForPo);
  let vendor = unboundGuess(vendorMatch, 'supplier_id');
  const po = unboundGuess(poMatch, 'po_id');
  if (vendor.status === 'unmatched' && po.status === 'exact' && po.supplier_id) {
    const supplier = await db.prepare(
      `SELECT id, name, code FROM suppliers WHERE id = ?`
    ).get(po.supplier_id);
    vendor = {
      status: 'from_po',
      supplier_id: null,
      suggestions: supplier ? [pubSupplier(supplier)] : vendor.suggestions
    };
  }
  const lines = await mapLines(db, extraction.lines, po.po_id);
  const working = workingFromExtraction(extraction, vendor, po, lines);
  return { vendor, po, working };
}

const PROPOSAL_COLUMNS = `
  id, status, pdf_filename, pdf_sha256, pdf_size, ocr_json, baseline_json, working_json,
  vendor_match_json, po_match_json, preview_json, uploaded_by_user_id, uploaded_by_name,
  uploaded_by_role, api_key_id, source, posted_invoice_id, rejected_reason,
  rejected_by_user_id, created_at, updated_at
`;

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function diffWorkingCopies(baseline, edited) {
  const diffs = [];
  const scalars = [
    'vendor_name', 'supplier_id', 'invoice_number', 'invoice_date', 'due_date',
    'po_number', 'po_id', 'currency', 'net_cents', 'vat_cents', 'gross_cents'
  ];
  for (const field of scalars) {
    if (!sameValue(baseline?.[field] ?? null, edited?.[field] ?? null)) {
      diffs.push({ field, ocr: baseline?.[field] ?? null, edited: edited?.[field] ?? null });
    }
  }
  const left = baseline?.lines || [];
  const right = edited?.lines || [];
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    const a = left[index] || {};
    const b = right[index] || {};
    for (const key of ['description', 'quantity', 'unit_price_cents', 'po_item_id']) {
      if (!sameValue(a[key] ?? null, b[key] ?? null)) {
        diffs.push({
          field: `lines[${index}].${key}`,
          ocr: a[key] ?? null,
          edited: b[key] ?? null
        });
      }
    }
  }
  return diffs;
}

async function presentRow(db, row, { livePreview = false } = {}) {
  const ocr = parseJson(row.ocr_json, {});
  const baseline = parseJson(row.baseline_json, {});
  const working = parseJson(row.working_json, {});
  const preview = livePreview && row.status === 'proposed'
    ? await previewProposal(db, row.id, working)
    : parseJson(row.preview_json, { ready: false, blockers: [] });
  const vendorMatch = parseJson(row.vendor_match_json, {});
  const poMatch = parseJson(row.po_match_json, {});
  const low = lowConfidenceFieldNames(ocr);
  if (['suggested', 'from_po', 'ambiguous'].includes(vendorMatch.status)) low.push('supplier_id');
  if (['suggested', 'ambiguous'].includes(poMatch.status)) low.push('po_id');
  const fields = {};
  for (const name of [...TEXT_FIELDS, ...MONEY_FIELDS]) {
    fields[name] = presentScored(ocr[name]);
  }
  fields.lines = (ocr.lines || []).map((line) => ({
    description: presentScored(line.description),
    quantity: presentScored(line.quantity),
    unit_price_cents: presentScored(line.unit_price_cents)
  }));
  return {
    id: Number(row.id),
    status: row.status,
    filename: row.pdf_filename,
    sha256: row.pdf_sha256,
    byte_size: Number(row.pdf_size),
    source: row.source,
    uploaded_by_user_id: row.uploaded_by_user_id == null ? null : Number(row.uploaded_by_user_id),
    uploaded_by_name: row.uploaded_by_name,
    uploaded_by_role: row.uploaded_by_role,
    api_key_id: row.api_key_id == null ? null : Number(row.api_key_id),
    created_at: row.created_at,
    updated_at: row.updated_at,
    fields,
    low_confidence_fields: low,
    baseline,
    working,
    vendor_match: vendorMatch,
    po_match: poMatch,
    preview,
    posted_invoice_id: row.posted_invoice_id == null ? null : Number(row.posted_invoice_id),
    rejected_reason: row.rejected_reason,
    rejected_by_user_id: row.rejected_by_user_id == null ? null : Number(row.rejected_by_user_id)
  };
}

async function loadRow(db, id) {
  const row = await db.prepare(`SELECT ${PROPOSAL_COLUMNS} FROM invoice_proposals WHERE id = ?`).get(id);
  if (!row) throw new InvoiceProposalError('Invoice proposal not found', 404, 'proposal_not_found');
  return row;
}

function requireProposalId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new InvoiceProposalError('Invoice proposal not found', 404, 'proposal_not_found');
  }
  return id;
}

async function audit(db, actor, action, proposalId, details, now) {
  await appendComplianceEvent(db, {
    actor_user_id: actor.userId ?? null,
    actor_name: actor.name,
    actor_role: actor.role,
    action,
    entity_type: 'invoice_proposal',
    entity_id: Number(proposalId),
    details: JSON.stringify(details),
    created_at: utcTimestamp(now)
  });
}

export async function compileInvoiceProposal(db, { pdf, filename } = {}) {
  if (!isInvoiceOcrConfigured()) {
    throw new InvoiceOcrError(
      'Invoice OCR is not configured. Set INVOICE_OCR_PROVIDER=gateway and INVOICE_OCR_MODEL.',
      503,
      'ocr_not_configured'
    );
  }
  if (!isPdfBuffer(pdf)) {
    throw new InvoiceProposalError('The file is not a PDF', 400, 'not_a_pdf');
  }
  const extraction = await extractInvoicePdf(pdf);
  const resolved = await resolveExtraction(db, extraction);
  const preview = await previewProposal(db, 0, resolved.working);
  return {
    pdf,
    filename: safePdfFilename(filename),
    digest: sha256Pdf(pdf),
    extraction,
    resolved,
    preview
  };
}

async function storeInvoiceProposal(db, draft, actor, now) {
  const stamp = utcTimestamp(now);
  const id = await db.transaction(async () => {
    const inserted = await db.prepare(`
      INSERT INTO invoice_proposals (
        status, pdf_filename, pdf_sha256, pdf_size, ocr_json, baseline_json,
        working_json, vendor_match_json, po_match_json, preview_json,
        uploaded_by_user_id, uploaded_by_name, uploaded_by_role, api_key_id, source,
        created_at, updated_at
      ) VALUES (
        'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).run(
      draft.filename,
      draft.digest,
      draft.pdf.length,
      JSON.stringify(draft.extraction),
      JSON.stringify(draft.resolved.working),
      JSON.stringify(draft.resolved.working),
      JSON.stringify(draft.resolved.vendor),
      JSON.stringify(draft.resolved.po),
      JSON.stringify(draft.preview),
      actor.userId ?? null,
      actor.name,
      actor.role,
      actor.apiKeyId ?? null,
      actor.source,
      stamp,
      stamp
    );
    const proposalId = Number(inserted.lastInsertRowid);
    await db.prepare(`
      INSERT INTO invoice_proposal_files (proposal_id, pdf_bytes) VALUES (?, ?)
    `).run(proposalId, draft.pdf);
    const actorDetails = {
      filename: draft.filename,
      sha256: draft.digest,
      byte_size: draft.pdf.length,
      source: actor.source,
      api_key_id: actor.apiKeyId ?? null
    };
    await audit(db, actor, 'INVOICE_PROPOSAL_UPLOADED', proposalId, actorDetails, now);
    await audit(db, actor, 'INVOICE_PROPOSAL_EXTRACTED', proposalId, {
      ...actorDetails,
      vendor_name: draft.extraction.vendor_name.value,
      invoice_number: draft.extraction.invoice_number.value,
      po_number: draft.extraction.po_number.value,
      currency: draft.extraction.currency.value,
      line_count: draft.extraction.lines.length,
      supplier_id: draft.resolved.working.supplier_id,
      po_id: draft.resolved.working.po_id,
      low_confidence_fields: lowConfidenceFieldNames(draft.extraction)
    }, now);
    return proposalId;
  })();

  return presentRow(db, await loadRow(db, id), { livePreview: true });
}

function uploadLimitPerMinute(env = process.env) {
  const raw = Number(env.INVOICE_PROPOSAL_UPLOADS_PER_MINUTE);
  if (Number.isInteger(raw) && raw >= 1 && raw <= 600) return raw;
  return 10;
}

async function assertUiUploadRate(db, actor, now) {
  if (actor?.source !== 'ui' || actor.userId == null) return;
  const since = utcTimestamp(new Date(now.getTime() - 60_000));
  const stamp = utcTimestamp(now);
  const limit = uploadLimitPerMinute();
  await proposalTransaction(db)(async () => {
    const row = await db.prepare(`
      SELECT COUNT(*) AS n FROM invoice_proposal_upload_attempts
      WHERE user_id = ? AND created_at >= ?
    `).get(actor.userId, since);
    if (Number(row?.n || 0) >= limit) {
      throw new InvoiceProposalError('Too many invoice uploads. Try again in a minute.', 429, 'rate_limited');
    }
    await db.prepare(`
      INSERT INTO invoice_proposal_upload_attempts (user_id, created_at) VALUES (?, ?)
    `).run(actor.userId, stamp);
  })();
}

export async function uploadInvoiceProposal(db, { pdf, filename, actor, now = new Date(), draft = null } = {}) {
  await assertUiUploadRate(db, actor, now);
  const compiled = draft || await compileInvoiceProposal(db, { pdf, filename });
  return storeInvoiceProposal(db, compiled, actor, now);
}

function pageBounds(limit, offset) {
  const cap = Number(limit);
  const skip = Number(offset);
  return {
    limit: Number.isInteger(cap) && cap >= 1 && cap <= 100 ? cap : 50,
    offset: Number.isInteger(skip) && skip >= 0 ? skip : 0
  };
}

export async function listInvoiceProposals(db, { status = 'proposed', limit, offset } = {}) {
  const allowed = new Set(['proposed', 'posted', 'rejected', 'all']);
  const filter = allowed.has(status) ? status : 'proposed';
  const page = pageBounds(limit, offset);
  const fetched = filter === 'all'
    ? await db.prepare(
      `SELECT ${PROPOSAL_COLUMNS} FROM invoice_proposals ORDER BY id DESC LIMIT ? OFFSET ?`
    ).all(page.limit + 1, page.offset)
    : await db.prepare(
      `SELECT ${PROPOSAL_COLUMNS} FROM invoice_proposals WHERE status = ? ORDER BY id DESC LIMIT ? OFFSET ?`
    ).all(filter, page.limit + 1, page.offset);
  const hasMore = fetched.length > page.limit;
  const rows = hasMore ? fetched.slice(0, page.limit) : fetched;
  const proposals = [];
  for (const row of rows) proposals.push(await presentRow(db, row, { livePreview: false }));
  return { proposals, limit: page.limit, offset: page.offset, has_more: hasMore };
}

export async function getInvoiceProposal(db, rawId) {
  const row = await loadRow(db, requireProposalId(rawId));
  return presentRow(db, row, { livePreview: true });
}

export async function readProposalPdf(db, rawId) {
  const id = requireProposalId(rawId);
  const row = await db.prepare(`
    SELECT f.pdf_bytes, p.pdf_filename
    FROM invoice_proposal_files f
    JOIN invoice_proposals p ON p.id = f.proposal_id
    WHERE f.proposal_id = ?
  `).get(id);
  if (!row) throw new InvoiceProposalError('Invoice proposal not found', 404, 'proposal_not_found');
  const bytes = Buffer.isBuffer(row.pdf_bytes) ? row.pdf_bytes : Buffer.from(row.pdf_bytes);
  return { bytes, filename: safePdfFilename(row.pdf_filename) };
}

export async function listProposalOptions(db) {
  const suppliers = await db.prepare(
    `SELECT id, name, code FROM suppliers WHERE status != 'inactive' ORDER BY name`
  ).all();
  const purchaseOrders = await db.prepare(`
    SELECT id, po_number, supplier_id, status FROM purchase_orders
    WHERE status IN ('issued', 'acknowledged', 'partially_received', 'received')
    ORDER BY id DESC
    LIMIT 100
  `).all();
  const ids = purchaseOrders.map((row) => Number(row.id));
  let poItems = [];
  if (ids.length) {
    const marks = ids.map(() => '?').join(',');
    poItems = await db.prepare(`
      SELECT id, po_id, item_description, unit_price FROM po_items
      WHERE po_id IN (${marks})
      ORDER BY id
    `).all(...ids);
  }
  return {
    suppliers: suppliers.map(pubSupplier),
    purchase_orders: purchaseOrders.map(pubPo),
    po_items: poItems.map((row) => ({
      id: Number(row.id),
      po_id: Number(row.po_id),
      description: row.item_description,
      unit_price_cents: Number(row.unit_price)
    }))
  };
}

function sodError(message) {
  return new InvoiceProposalError(message, 403, 'sod_violation');
}

async function assertCanDecide(db, row, actor) {
  if (row.status !== 'proposed') {
    throw new InvoiceProposalError('This proposal is already closed', 409, 'proposal_not_open');
  }
  if (!invoiceProposalSodEnforced()) return;
  if (row.uploaded_by_user_id != null && Number(row.uploaded_by_user_id) === Number(actor.userId)) {
    throw sodError('The uploader cannot post this proposal. Another finance user must approve it.');
  }
  if (row.api_key_id != null) {
    const key = await db.prepare(
      `SELECT created_by_user_id FROM api_keys WHERE id = ?`
    ).get(row.api_key_id);
    if (key && Number(key.created_by_user_id) === Number(actor.userId)) {
      throw sodError('The person who created the uploading API key cannot post this proposal.');
    }
  }
}

function closedProposal() {
  return new InvoiceProposalError('This proposal is already closed', 409, 'proposal_not_open');
}

function isUniqueConstraint(error) {
  return error?.code === 'SQLITE_CONSTRAINT_UNIQUE'
    || (error?.code === 'SQLITE_CONSTRAINT' && /UNIQUE/i.test(error.message || ''))
    || /UNIQUE constraint failed/i.test(error.message || '');
}

function isSnapshotConflict(error) {
  const code = String(error?.code || '');
  return code === 'SQLITE_BUSY_SNAPSHOT'
    || code === 'SQLITE_BUSY'
    || /SQLITE_BUSY/i.test(String(error?.message || ''));
}

function proposalTransaction(db) {
  return typeof db.immediateTransaction === 'function'
    ? db.immediateTransaction.bind(db)
    : db.transaction.bind(db);
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Retry a lost write lock. Local SQLite returns SQLITE_BUSY at once so this
 * process can finish the writer that already holds the lock.
 */
async function runProposalWrite(fn) {
  let last;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (!isSnapshotConflict(error) || attempt === 7) throw error;
      await wait(25);
    }
  }
  throw last;
}

async function postWorking(db, rawId, actor, working, { edited, now, overrideReason = '' }) {
  const id = requireProposalId(rawId);
  const row = await loadRow(db, id);
  await assertCanDecide(db, row, actor);
  // Match preview stays outside the write lock. createSupplierInvoice matches once inside it.
  const preview = await previewProposal(db, id, working, { overrideReason });
  if (!preview.ready) {
    throw new InvoiceProposalError(
      'The proposal is not ready to post',
      400,
      'proposal_not_ready',
      { blockers: preview.blockers }
    );
  }
  const baseline = parseJson(row.baseline_json, {});
  const diffs = edited ? diffWorkingCopies(baseline, working) : [];
  const nested = Boolean(db.inTransaction?.());
  const outcome = await runProposalWrite(() => proposalTransaction(db)(async () => {
    if (diffs.length) {
      await audit(db, actor, 'INVOICE_PROPOSAL_EDITED', id, { diffs }, now);
    }
    const stamp = utcTimestamp(now);
    const claimed = await db.prepare(`
      UPDATE invoice_proposals
      SET status = 'posted', working_json = ?, updated_at = ?
      WHERE id = ? AND status = 'proposed'
    `).run(JSON.stringify(working), stamp, id);
    if (!claimed.changes) throw closedProposal();
    const prepared = await prepareInboundInvoice(db, inboundBody(id, working));
    let created;
    try {
      created = await createSupplierInvoice(db, {
        header: prepared.header,
        lines: prepared.lines,
        source: 'ui',
        dryRun: false,
        now
      });
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new InvoiceProposalError(
          'An invoice with this number already exists for the supplier',
          409,
          'duplicate_invoice_number'
        );
      }
      throw error;
    }
    await db.prepare(`
      UPDATE invoice_proposals
      SET preview_json = ?, posted_invoice_id = ?, updated_at = ?
      WHERE id = ? AND status = 'posted'
    `).run(JSON.stringify(preview), created.invoiceId, stamp, id);
    const postedDetails = {
      invoice_id: Number(created.invoiceId),
      match_status: created.matchOutcome.overallMatchStatus,
      status: created.matchOutcome.invoiceStatus,
      duplicate_status: created.duplicate_status,
      exception_queued: created.exception.queued,
      api_key_id: row.api_key_id == null ? null : Number(row.api_key_id),
      source: row.source
    };
    if (preview.totals_override) postedDetails.totals_override = preview.totals_override;
    await audit(db, actor, 'INVOICE_PROPOSAL_POSTED', id, postedDetails, now);
    await enqueueWebhook(db, {
      eventType: WEBHOOK_EVENTS.INVOICE_PROPOSAL_POSTED,
      entityType: 'invoice_proposal',
      entityId: id,
      data: withDeploymentCurrency({
        proposal_id: id,
        status: 'posted',
        invoice_id: Number(created.invoiceId),
        invoice_number: working.invoice_number,
        supplier_id: working.supplier_id,
        po_id: working.po_id,
        extracted_currency: working.currency,
        source: row.source,
        match_status: created.matchOutcome.overallMatchStatus,
        totals_override: preview.totals_override || null
      }),
      now
    });
    return {
      invoiceId: Number(created.invoiceId),
      match_status: created.matchOutcome.overallMatchStatus,
      status: created.matchOutcome.invoiceStatus,
      duplicate_status: created.duplicate_status,
      exception: created.exception
    };
  })());
  if (!nested) kickWebhookDispatch(db);
  const proposal = await getInvoiceProposal(db, id);
  return { proposal, invoice: outcome };
}

export async function approveInvoiceProposal(db, rawId, actor, now = new Date(), overrideReason = '') {
  const row = await loadRow(db, requireProposalId(rawId));
  return postWorking(db, row.id, actor, parseJson(row.working_json, {}), {
    edited: false,
    now,
    overrideReason
  });
}

export async function editAndPostInvoiceProposal(db, rawId, actor, body, now = new Date()) {
  const working = parseWorkingCopy(body);
  return postWorking(db, rawId, actor, working, {
    edited: true,
    now,
    overrideReason: body?.override_reason ?? ''
  });
}

export async function rejectInvoiceProposal(db, rawId, actor, reason, now = new Date()) {
  const text = String(reason || '').trim();
  if (!text || text.length > 500) {
    throw new InvoiceProposalError('A rejection reason is required', 400, 'rejection_reason_required');
  }
  const id = requireProposalId(rawId);
  const nested = Boolean(db.inTransaction?.());
  await runProposalWrite(() => proposalTransaction(db)(async () => {
    const row = await loadRow(db, id);
    const stamp = utcTimestamp(now);
    const updated = await db.prepare(`
      UPDATE invoice_proposals
      SET status = 'rejected', rejected_reason = ?, rejected_by_user_id = ?, updated_at = ?
      WHERE id = ? AND status = 'proposed'
    `).run(text, actor.userId ?? null, stamp, id);
    if (!updated.changes) throw closedProposal();
    await audit(db, actor, 'INVOICE_PROPOSAL_REJECTED', id, { reason: text }, now);
    const working = parseJson(row.working_json, {});
    await enqueueWebhook(db, {
      eventType: WEBHOOK_EVENTS.INVOICE_PROPOSAL_REJECTED,
      entityType: 'invoice_proposal',
      entityId: id,
      data: withDeploymentCurrency({
        proposal_id: id,
        status: 'rejected',
        reason: text,
        invoice_number: working.invoice_number,
        supplier_id: working.supplier_id,
        po_id: working.po_id,
        extracted_currency: working.currency,
        source: row.source
      }),
      now
    });
  })());
  if (!nested) kickWebhookDispatch(db);
  return getInvoiceProposal(db, id);
}

export function sessionProposalActor(user) {
  return {
    userId: Number(user.id),
    name: user.name,
    role: user.role,
    source: 'ui',
    apiKeyId: null
  };
}

export function integrationProposalActor(key) {
  return {
    userId: null,
    name: key.name,
    role: 'integration',
    source: 'integration',
    apiKeyId: Number(key.id)
  };
}
