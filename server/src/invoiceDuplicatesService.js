import { asCents, formatCents } from './money.js';

/**
 * Duplicate invoice detection — AP control after (and independent of) dual match.
 *
 * Exact reuse of (supplier_id, invoice_number) remains a hard UNIQUE fail.
 * This service soft-holds *likely* duplicates:
 *   1. same supplier + same billed cents + invoice_date within ±7 UTC calendar days
 *   2. same supplier + same po_id + same billed cents (different invoice number allowed)
 *
 * Rejected invoices are never candidates. Self is excluded.
 * Dual match still runs as today — this is not a second match engine.
 */

export const DUPLICATE_DATE_WINDOW_DAYS = 7;

export const DUPLICATE_STATUSES = Object.freeze([
  'clear',
  'suspect',
  'confirmed_unique',
  'confirmed_duplicate'
]);

export const MATCH_RULES = Object.freeze({
  SAME_AMOUNT_NEAR_DATE: 'same_amount_near_date',
  SAME_PO_SAME_AMOUNT: 'same_po_same_amount',
  BOTH: 'both'
});

export const RESOLVE_DISPOSITIONS = Object.freeze(['confirm_unique', 'confirm_duplicate']);

export const DUPLICATE_AUDIT = Object.freeze({
  suspected: 'DUPLICATE_SUSPECTED',
  cleared: 'DUPLICATE_CLEARED',
  confirmed: 'DUPLICATE_CONFIRMED'
});

const BLOCKING_DUPLICATE_STATUSES = new Set(['suspect', 'confirmed_duplicate']);

export class InvoiceDuplicateError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'InvoiceDuplicateError';
    this.statusCode = statusCode;
  }
}

function requireText(value, field) {
  const text = value == null ? '' : String(value).trim();
  if (!text) {
    throw new InvoiceDuplicateError(`${field} is required.`);
  }
  return text;
}

/** Normalize a stored invoice_date to UTC YYYY-MM-DD. */
export function utcYmd(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

export function addUtcCalendarDays(ymd, days) {
  const date = utcYmd(ymd);
  if (!date) return null;
  const [year, month, day] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day + Number(days)));
  return dt.toISOString().slice(0, 10);
}

/** Signed UTC calendar-day delta (b − a). Time-of-day is ignored. */
export function utcCalendarDaysBetween(a, b) {
  const left = utcYmd(a);
  const right = utcYmd(b);
  if (!left || !right) return null;
  const [ay, am, ad] = left.split('-').map(Number);
  const [by, bm, bd] = right.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

export function isWithinUtcDateWindow(a, b, days = DUPLICATE_DATE_WINDOW_DAYS) {
  const delta = utcCalendarDaysBetween(a, b);
  if (delta == null) return false;
  return Math.abs(delta) <= days;
}

export function normalizeDuplicateStatus(value) {
  const status = value == null || value === '' ? 'clear' : String(value);
  return DUPLICATE_STATUSES.includes(status) ? status : 'clear';
}

export function isDuplicateBlocked(invoice) {
  return BLOCKING_DUPLICATE_STATUSES.has(normalizeDuplicateStatus(invoice?.duplicate_status));
}

/** Fail-closed gate for Approve for Payment. */
export function assertDuplicateAllowsApprove(invoice) {
  const status = normalizeDuplicateStatus(invoice?.duplicate_status);
  if (status === 'suspect') {
    throw new InvoiceDuplicateError(
      'Likely duplicate invoice. Clear or confirm it in Duplicate Suspects before approving for payment.'
    );
  }
  if (status === 'confirmed_duplicate') {
    throw new InvoiceDuplicateError(
      'Invoice was confirmed as a duplicate and cannot be approved for payment.'
    );
  }
}

/** Fail-closed gate for mark-paid. */
export function assertDuplicateAllowsMarkPaid(invoice) {
  const status = normalizeDuplicateStatus(invoice?.duplicate_status);
  if (status === 'suspect') {
    throw new InvoiceDuplicateError(
      'Likely duplicate invoice. Resolve it in Duplicate Suspects before marking paid.'
    );
  }
  if (status === 'confirmed_duplicate') {
    throw new InvoiceDuplicateError(
      'Invoice was confirmed as a duplicate and cannot be marked paid.'
    );
  }
}

/**
 * Classify one candidate against an incoming invoice (integer cents, UTC dates).
 * Returns a match_rule or null. Rejected / self / other supplier / amount mismatch miss.
 */
export function classifyDuplicateMatch(incoming, candidate) {
  if (!incoming || !candidate) return null;
  if (incoming.id != null && candidate.id != null && Number(incoming.id) === Number(candidate.id)) {
    return null;
  }
  if (candidate.status === 'rejected') return null;
  if (Number(candidate.supplier_id) !== Number(incoming.supplier_id)) return null;

  const incomingCents = asCents(incoming.total_amount);
  const candidateCents = asCents(candidate.total_amount);
  if (incomingCents !== candidateCents) return null;

  const nearDate = isWithinUtcDateWindow(
    incoming.invoice_date,
    candidate.invoice_date,
    DUPLICATE_DATE_WINDOW_DAYS
  );
  const samePo = Number(candidate.po_id) === Number(incoming.po_id);

  if (nearDate && samePo) return MATCH_RULES.BOTH;
  if (nearDate) return MATCH_RULES.SAME_AMOUNT_NEAR_DATE;
  if (samePo) return MATCH_RULES.SAME_PO_SAME_AMOUNT;
  return null;
}

function mapCandidateRow(row, matchRule) {
  return {
    id: row.id,
    invoice_number: row.invoice_number,
    po_id: row.po_id,
    po_number: row.po_number,
    supplier_id: row.supplier_id,
    supplier_name: row.supplier_name,
    invoice_date: row.invoice_date,
    total_amount: asCents(row.total_amount),
    billed_total_cents: asCents(row.total_amount),
    status: row.status,
    match_status: row.match_status,
    duplicate_status: normalizeDuplicateStatus(row.duplicate_status),
    match_rule: matchRule
  };
}

export async function findDuplicateSuspects(db, {
  invoiceId = null,
  supplierId,
  poId,
  totalAmountCents,
  invoiceDate
} = {}) {
  const supplier = Number(supplierId);
  const po = Number(poId);
  const billed = asCents(totalAmountCents);
  const date = utcYmd(invoiceDate);
  if (!Number.isInteger(supplier) || supplier <= 0) return [];
  if (!Number.isInteger(billed)) return [];
  if (!date) return [];

  const rows = await db.prepare(`
    SELECT
      inv.id,
      inv.invoice_number,
      inv.po_id,
      inv.supplier_id,
      inv.invoice_date,
      inv.total_amount,
      inv.status,
      inv.match_status,
      inv.duplicate_status,
      po.po_number,
      s.name as supplier_name
    FROM invoices inv
    JOIN purchase_orders po ON inv.po_id = po.id
    JOIN suppliers s ON inv.supplier_id = s.id
    WHERE inv.supplier_id = ?
      AND inv.total_amount = ?
      AND inv.status != 'rejected'
      AND (? IS NULL OR inv.id != ?)
  `).all(supplier, billed, invoiceId, invoiceId);

  const incoming = {
    id: invoiceId,
    supplier_id: supplier,
    po_id: po,
    total_amount: billed,
    invoice_date: date
  };

  const suspects = [];
  for (const row of rows) {
    const matchRule = classifyDuplicateMatch(incoming, row);
    if (matchRule) suspects.push(mapCandidateRow(row, matchRule));
  }
  return suspects;
}

async function insertFlagRows(db, invoiceId, invoiceDate, billedCents, suspects) {
  const insertFlag = db.prepare(`
    INSERT INTO invoice_duplicate_flags (
      invoice_id, candidate_invoice_id, match_rule,
      billed_total_cents, candidate_billed_total_cents,
      invoice_date, candidate_invoice_date, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open')
  `);

  for (const suspect of suspects) {
    await insertFlag.run(
      invoiceId,
      suspect.id,
      suspect.match_rule,
      billedCents,
      suspect.billed_total_cents,
      invoiceDate,
      utcYmd(suspect.invoice_date),
      // status is literal 'open' in SQL
    );
  }
}

function summarizeSuspects(invoiceNumber, billedCents, invoiceDate, suspects) {
  const parts = suspects.map((row) => {
    const rule = row.match_rule === MATCH_RULES.BOTH
      ? 'same amount + near date and same PO + amount'
      : row.match_rule === MATCH_RULES.SAME_PO_SAME_AMOUNT
        ? 'same PO + billed amount'
        : 'same billed amount + invoice date within ±7 UTC days';
    return `${row.invoice_number} (${row.status}, ${row.billed_total_cents}¢, ${row.invoice_date}, ${rule})`;
  });
  return `Likely duplicate ${invoiceNumber}: billed ${billedCents}¢ ($${formatCents(billedCents)}) on ${invoiceDate}. Candidates: ${parts.join('; ')}`;
}

/**
 * Run inside the invoice-create transaction after the new row exists.
 * Creates the invoice either way; on hit sets duplicate_status=suspect,
 * writes flag rows, and audits DUPLICATE_SUSPECTED.
 */
export async function flagDuplicateSuspectsOnCreate(db, {
  invoiceId,
  invoiceNumber,
  supplierId,
  poId,
  totalAmountCents,
  invoiceDate
}) {
  const billed = asCents(totalAmountCents);
  const date = utcYmd(invoiceDate) || new Date().toISOString().slice(0, 10);
  const suspects = await findDuplicateSuspects(db, {
    invoiceId,
    supplierId,
    poId,
    totalAmountCents: billed,
    invoiceDate: date
  });

  if (suspects.length === 0) {
    return {
      duplicate_status: 'clear',
      duplicate_suspects: []
    };
  }

  await db.prepare(`
    UPDATE invoices SET duplicate_status = 'suspect' WHERE id = ?
  `).run(invoiceId);

  await insertFlagRows(db, invoiceId, date, billed, suspects);

  const details = summarizeSuspects(invoiceNumber, billed, date, suspects);
  await db.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
    VALUES ('invoice', ?, ?, 'System Duplicate Detector', ?)
  `).run(invoiceId, DUPLICATE_AUDIT.suspected, details);

  return {
    duplicate_status: 'suspect',
    duplicate_suspects: suspects
  };
}

export async function listDuplicateFlags(db, invoiceId) {
  return await db.prepare(`
    SELECT
      f.id,
      f.invoice_id,
      f.candidate_invoice_id,
      f.match_rule,
      f.billed_total_cents,
      f.candidate_billed_total_cents,
      f.invoice_date,
      f.candidate_invoice_date,
      f.status,
      f.reason,
      f.actor_name,
      f.created_at,
      f.resolved_at,
      cand.invoice_number as candidate_invoice_number,
      cand.status as candidate_status,
      cand.match_status as candidate_match_status,
      cand.duplicate_status as candidate_duplicate_status,
      cand.po_id as candidate_po_id,
      cand.total_amount as candidate_total_amount,
      po.po_number as candidate_po_number,
      s.name as candidate_supplier_name
    FROM invoice_duplicate_flags f
    JOIN invoices cand ON cand.id = f.candidate_invoice_id
    JOIN purchase_orders po ON cand.po_id = po.id
    JOIN suppliers s ON cand.supplier_id = s.id
    WHERE f.invoice_id = ?
    ORDER BY f.id ASC
  `).all(invoiceId);
}

function attachDuplicateMeta(row, flags) {
  const billed = asCents(row.total_amount);
  const payable = row.payable_total_cents == null || row.payable_total_cents === ''
    ? null
    : asCents(row.payable_total_cents);
  const duplicateStatus = normalizeDuplicateStatus(row.duplicate_status);
  const open = duplicateStatus === 'suspect';
  return {
    ...row,
    billed_total_cents: billed,
    effective_payable_cents: payable == null ? billed : payable,
    has_short_pay: payable != null,
    duplicate_status: duplicateStatus,
    duplicate_flags: flags,
    duplicate_suspects: flags.map((flag) => ({
      id: flag.candidate_invoice_id,
      flag_id: flag.id,
      invoice_number: flag.candidate_invoice_number,
      po_id: flag.candidate_po_id,
      po_number: flag.candidate_po_number,
      supplier_name: flag.candidate_supplier_name,
      invoice_date: flag.candidate_invoice_date,
      total_amount: asCents(flag.candidate_total_amount),
      billed_total_cents: asCents(flag.candidate_billed_total_cents),
      status: flag.candidate_status,
      match_status: flag.candidate_match_status,
      duplicate_status: normalizeDuplicateStatus(flag.candidate_duplicate_status),
      match_rule: flag.match_rule,
      flag_status: flag.status
    })),
    queue_state: open ? 'open' : (flags.length ? 'resolved' : 'not_in_queue'),
    needs_duplicate_review: open
  };
}

async function loadInvoiceHeader(db, id) {
  return await db.prepare(`
    SELECT
      inv.*,
      po.po_number,
      po.total_amount as po_total_amount,
      po.issue_date as po_issue_date,
      po.status as po_status,
      po.requisition_id,
      s.name as supplier_name,
      s.code as supplier_code,
      s.payment_terms as supplier_terms,
      d.id as department_id,
      d.name as department_name,
      pr.pr_number,
      pr.requester_id,
      req.name as requester_name
    FROM invoices inv
    JOIN purchase_orders po ON inv.po_id = po.id
    JOIN suppliers s ON inv.supplier_id = s.id
    LEFT JOIN purchase_requisitions pr ON po.requisition_id = pr.id
    LEFT JOIN departments d ON pr.department_id = d.id
    LEFT JOIN users req ON pr.requester_id = req.id
    WHERE inv.id = ?
  `).get(id);
}

/**
 * List invoices for the AP duplicate-suspect queue.
 * @param {'open'|'resolved'|'all'} queue
 */
export async function listInvoiceDuplicates(db, { queue = 'open' } = {}) {
  const filter = String(queue || 'open');
  if (!['open', 'resolved', 'all'].includes(filter)) {
    throw new InvoiceDuplicateError("queue must be 'open', 'resolved', or 'all'.");
  }

  const rows = await db.prepare(`
    SELECT
      inv.*,
      po.po_number,
      po.total_amount as po_total_amount,
      s.name as supplier_name,
      s.code as supplier_code,
      (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = inv.id) as items_count,
      EXISTS(
        SELECT 1 FROM invoice_duplicate_flags f WHERE f.invoice_id = inv.id
      ) as has_duplicate_flag
    FROM invoices inv
    JOIN purchase_orders po ON inv.po_id = po.id
    JOIN suppliers s ON inv.supplier_id = s.id
    WHERE
      CASE
        WHEN ? = 'open' THEN inv.duplicate_status = 'suspect'
        WHEN ? = 'resolved' THEN inv.duplicate_status IN ('confirmed_unique', 'confirmed_duplicate')
        ELSE (
          inv.duplicate_status IN ('suspect', 'confirmed_unique', 'confirmed_duplicate')
          OR EXISTS (
            SELECT 1 FROM invoice_duplicate_flags f WHERE f.invoice_id = inv.id
          )
        )
      END
    ORDER BY inv.id DESC
  `).all(filter, filter);

  const withFlags = [];
  for (const row of rows) {
    const flags = await listDuplicateFlags(db, row.id);
    withFlags.push(attachDuplicateMeta(row, flags));
  }
  return withFlags;
}

export async function getInvoiceDuplicateDetail(db, id) {
  const invoice = await loadInvoiceHeader(db, id);
  if (!invoice) {
    throw new InvoiceDuplicateError('Invoice not found.', 404);
  }

  const flags = await listDuplicateFlags(db, id);
  const items = await db.prepare(`
    SELECT
      ii.*,
      poi.quantity as po_quantity,
      poi.unit_price as po_unit_price,
      poi.item_description as po_description
    FROM invoice_items ii
    JOIN po_items poi ON ii.po_item_id = poi.id
    WHERE ii.invoice_id = ?
  `).all(id);

  const auditLogs = await db.prepare(`
    SELECT id, entity_type, entity_id, action, actor_name, details, created_at
    FROM audit_logs
    WHERE entity_type = 'invoice' AND entity_id = ?
    ORDER BY id ASC
  `).all(id);

  const candidateIds = [...new Set(flags.map((flag) => flag.candidate_invoice_id))];
  const candidates = [];
  for (const candidateId of candidateIds) {
    const header = await loadInvoiceHeader(db, candidateId);
    if (header) {
      const candidateFlags = await listDuplicateFlags(db, candidateId);
      candidates.push(attachDuplicateMeta(header, candidateFlags));
    }
  }

  return {
    ...attachDuplicateMeta(invoice, flags),
    items,
    audit_logs: auditLogs,
    candidates
  };
}

/** Attach flags + status for GET /api/invoices/:id. */
export async function attachDuplicateToInvoice(db, invoice) {
  if (!invoice) return invoice;
  const flags = await listDuplicateFlags(db, invoice.id);
  return attachDuplicateMeta(invoice, flags);
}

export async function resolveInvoiceDuplicate(db, id, payload = {}) {
  const disposition = String(payload.disposition || '').trim();
  if (!RESOLVE_DISPOSITIONS.includes(disposition)) {
    throw new InvoiceDuplicateError(
      `disposition must be one of: ${RESOLVE_DISPOSITIONS.join(', ')}.`
    );
  }
  const reason = requireText(payload.reason, 'reason');
  const actorName = requireText(payload.actor_name, 'actor_name');

  const invoice = await loadInvoiceHeader(db, id);
  if (!invoice) {
    throw new InvoiceDuplicateError('Invoice not found.', 404);
  }

  if (invoice.status === 'paid' || invoice.status === 'approved_for_payment') {
    throw new InvoiceDuplicateError(
      'Invoice has already progressed to AP approve/pay and cannot take a new duplicate disposition.'
    );
  }
  if (normalizeDuplicateStatus(invoice.duplicate_status) !== 'suspect') {
    throw new InvoiceDuplicateError(
      `Only suspect invoices can be resolved in Duplicate Suspects (current: ${normalizeDuplicateStatus(invoice.duplicate_status)}).`
    );
  }

  const billedTotalCents = asCents(invoice.total_amount);
  const flagStatus = disposition === 'confirm_unique' ? 'confirmed_unique' : 'confirmed_duplicate';
  const nextDuplicateStatus = flagStatus;
  const auditAction = disposition === 'confirm_unique'
    ? DUPLICATE_AUDIT.cleared
    : DUPLICATE_AUDIT.confirmed;

  const resolveTransaction = db.transaction(async () => {
    if (disposition === 'confirm_unique') {
      await db.prepare(`
        UPDATE invoices SET duplicate_status = ? WHERE id = ?
      `).run(nextDuplicateStatus, id);
    } else {
      // Coupa-style: confirming a duplicate voids the new invoice so it
      // cannot be approved or paid. The candidate (original) is unchanged.
      await db.prepare(`
        UPDATE invoices SET duplicate_status = ?, status = 'rejected' WHERE id = ?
      `).run(nextDuplicateStatus, id);
    }

    await db.prepare(`
      UPDATE invoice_duplicate_flags
      SET status = ?, reason = ?, actor_name = ?, resolved_at = CURRENT_TIMESTAMP
      WHERE invoice_id = ? AND status = 'open'
    `).run(flagStatus, reason, actorName, id);

    const details = disposition === 'confirm_unique'
      ? `Cleared duplicate hold on ${invoice.invoice_number} (billed ${billedTotalCents}¢ / $${formatCents(billedTotalCents)}). Confirm unique. Reason: ${reason}`
      : `Confirmed duplicate ${invoice.invoice_number} (billed ${billedTotalCents}¢ / $${formatCents(billedTotalCents)}). Invoice rejected/voided. Reason: ${reason}`;

    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('invoice', ?, ?, ?, ?)
    `).run(id, auditAction, actorName, details);

    return { details, billedTotalCents };
  });

  const outcome = await resolveTransaction();
  const detail = await getInvoiceDuplicateDetail(db, id);
  const message = disposition === 'confirm_unique'
    ? 'Invoice confirmed unique. Approve for Payment may proceed if the invoice is matched and any hard exception is resolved.'
    : 'Invoice confirmed as a duplicate and rejected. Approve and pay are permanently blocked.';

  return {
    message,
    disposition,
    invoice_status: detail.status,
    duplicate_status: detail.duplicate_status,
    billed_total_cents: outcome.billedTotalCents,
    invoice: detail
  };
}
