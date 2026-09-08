import { asCents, formatCents } from './money.js';

/**
 * Invoice exception workbench — AP control point after dual match.
 *
 * Hard queue = invoices still `variance_flagged` (quantity / price / total
 * variance). `tolerated_match` is NOT in this queue: those invoices already
 * have status `matched` and may proceed to AP approve without a disposition.
 * Soft warnings remain visible on the match matrix.
 *
 * Dispositions (required reason + actor name; integer cents):
 *   accept_variance  — clear the block (status → matched); record accepted total
 *   reject_invoice   — permanently block approve/pay (status → rejected)
 *   return_to_buyer  — park with audit; stays variance_flagged and in the open queue
 */

export const HARD_EXCEPTION_MATCH_STATUSES = Object.freeze([
  'quantity_variance',
  'price_variance',
  'total_variance'
]);

export const TERMINAL_DISPOSITIONS = Object.freeze(['accept_variance', 'reject_invoice']);

export const DISPOSITIONS = Object.freeze([
  'accept_variance',
  'reject_invoice',
  'return_to_buyer'
]);

const DISPOSITION_AUDIT = {
  accept_variance: 'EXCEPTION_ACCEPT_VARIANCE',
  reject_invoice: 'EXCEPTION_REJECT_INVOICE',
  return_to_buyer: 'EXCEPTION_RETURN_TO_BUYER'
};

export class InvoiceExceptionError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'InvoiceExceptionError';
    this.statusCode = statusCode;
  }
}

function requireText(value, field) {
  const text = value == null ? '' : String(value).trim();
  if (!text) {
    throw new InvoiceExceptionError(`${field} is required.`);
  }
  return text;
}

export function isUnresolvedHardException(invoice) {
  return invoice?.status === 'variance_flagged';
}

/** Fail-closed gate for Approve for Payment. */
export function assertCanApprovePayment(invoice) {
  if (!invoice) {
    throw new InvoiceExceptionError('Invoice not found.', 404);
  }
  if (invoice.status === 'rejected') {
    throw new InvoiceExceptionError(
      'Invoice was rejected and cannot be approved for payment.'
    );
  }
  if (invoice.status === 'paid') {
    throw new InvoiceExceptionError('Invoice is already paid.');
  }
  if (invoice.status === 'approved_for_payment') {
    throw new InvoiceExceptionError('Invoice is already approved for payment.');
  }
  if (isUnresolvedHardException(invoice)) {
    throw new InvoiceExceptionError(
      'Unresolved invoice exception. Accept the variance in the Exception Workbench before approving for payment.'
    );
  }
  if (invoice.status !== 'matched') {
    throw new InvoiceExceptionError(
      `Invoice status '${invoice.status}' cannot be approved for payment.`
    );
  }
}

/** Fail-closed gate for mark-paid. Requires prior AP approve. */
export function assertCanMarkPaid(invoice) {
  if (!invoice) {
    throw new InvoiceExceptionError('Invoice not found.', 404);
  }
  if (invoice.status === 'rejected') {
    throw new InvoiceExceptionError('Invoice was rejected and cannot be marked paid.');
  }
  if (invoice.status === 'paid') {
    throw new InvoiceExceptionError('Invoice is already paid.');
  }
  if (isUnresolvedHardException(invoice)) {
    throw new InvoiceExceptionError(
      'Unresolved invoice exception. Resolve it before marking paid.'
    );
  }
  if (invoice.status !== 'approved_for_payment') {
    throw new InvoiceExceptionError(
      'Invoice must be approved for payment before it can be marked paid.'
    );
  }
}

export async function listInvoiceExceptionDispositions(db, invoiceId) {
  return await db.prepare(`
    SELECT id, invoice_id, disposition, reason, actor_name,
           accepted_total_cents, accepted_match_status, created_at
    FROM invoice_exception_dispositions
    WHERE invoice_id = ?
    ORDER BY id ASC
  `).all(invoiceId);
}

export async function getLatestDisposition(db, invoiceId) {
  return await db.prepare(`
    SELECT id, invoice_id, disposition, reason, actor_name,
           accepted_total_cents, accepted_match_status, created_at
    FROM invoice_exception_dispositions
    WHERE invoice_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(invoiceId);
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
      pr.pr_number
    FROM invoices inv
    JOIN purchase_orders po ON inv.po_id = po.id
    JOIN suppliers s ON inv.supplier_id = s.id
    LEFT JOIN purchase_requisitions pr ON po.requisition_id = pr.id
    LEFT JOIN departments d ON pr.department_id = d.id
    WHERE inv.id = ?
  `).get(id);
}

async function loadMatchContext(db, invoiceId, poId) {
  const items = await db.prepare(`
    SELECT
      ii.*,
      poi.quantity as po_quantity,
      poi.unit_price as po_unit_price,
      poi.total_price as po_total_price,
      poi.quantity_received as po_quantity_received,
      poi.quantity_accepted as po_quantity_accepted,
      poi.line_type as po_line_type,
      poi.item_description as po_description
    FROM invoice_items ii
    JOIN po_items poi ON ii.po_item_id = poi.id
    WHERE ii.invoice_id = ?
  `).all(invoiceId);

  const matchResults = await db.prepare(`
    SELECT mr.*, poi.item_description, poi.line_type
    FROM match_results mr
    LEFT JOIN po_items poi ON mr.po_item_id = poi.id
    WHERE mr.invoice_id = ?
  `).all(invoiceId);

  const receipts = await db.prepare(`
    SELECT gr.*, u.name as received_by_name
    FROM goods_receipts gr
    JOIN users u ON gr.received_by = u.id
    WHERE gr.po_id = ?
    ORDER BY gr.receipt_date DESC
  `).all(poId);

  const serviceSheets = await db.prepare(`
    SELECT ses.*, u.name as created_by_name
    FROM service_entry_sheets ses
    JOIN users u ON ses.created_by = u.id
    WHERE ses.po_id = ?
    ORDER BY ses.id DESC
  `).all(poId);

  const auditLogs = await db.prepare(`
    SELECT id, entity_type, entity_id, action, actor_name, details, created_at
    FROM audit_logs
    WHERE entity_type = 'invoice' AND entity_id = ?
    ORDER BY id ASC
  `).all(invoiceId);

  return { items, matchResults, receipts, serviceSheets, auditLogs };
}

function attachQueueMeta(row, latest) {
  const open = row.status === 'variance_flagged';
  return {
    ...row,
    exception: latest || null,
    queue_state: open ? 'open' : (latest ? 'resolved' : 'not_in_queue'),
    needs_disposition: open
  };
}

/**
 * List invoices for the AP exception workbench.
 * @param {'open'|'resolved'|'all'} queue
 */
export async function listInvoiceExceptions(db, { queue = 'open' } = {}) {
  const filter = String(queue || 'open');
  if (!['open', 'resolved', 'all'].includes(filter)) {
    throw new InvoiceExceptionError("queue must be 'open', 'resolved', or 'all'.");
  }

  const rows = await db.prepare(`
    SELECT
      inv.*,
      po.po_number,
      po.total_amount as po_total_amount,
      s.name as supplier_name,
      s.code as supplier_code,
      (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = inv.id) as items_count,
      (SELECT COUNT(*) FROM match_results WHERE invoice_id = inv.id AND status = 'fail') as fail_variances_count,
      EXISTS(
        SELECT 1 FROM invoice_exception_dispositions d WHERE d.invoice_id = inv.id
      ) as has_disposition
    FROM invoices inv
    JOIN purchase_orders po ON inv.po_id = po.id
    JOIN suppliers s ON inv.supplier_id = s.id
    WHERE
      CASE
        WHEN ? = 'open' THEN inv.status = 'variance_flagged'
        WHEN ? = 'resolved' THEN EXISTS (
          SELECT 1 FROM invoice_exception_dispositions d
          WHERE d.invoice_id = inv.id
            AND d.disposition IN ('accept_variance', 'reject_invoice')
        )
        ELSE (
          inv.status = 'variance_flagged'
          OR EXISTS (
            SELECT 1 FROM invoice_exception_dispositions d
            WHERE d.invoice_id = inv.id
          )
        )
      END
    ORDER BY inv.id DESC
  `).all(filter, filter);

  const withLatest = [];
  for (const row of rows) {
    const latest = await getLatestDisposition(db, row.id);
    withLatest.push(attachQueueMeta(row, latest));
  }
  return withLatest;
}

export async function getInvoiceExceptionDetail(db, id) {
  const invoice = await loadInvoiceHeader(db, id);
  if (!invoice) {
    throw new InvoiceExceptionError('Invoice not found.', 404);
  }

  const { items, matchResults, receipts, serviceSheets, auditLogs } = await loadMatchContext(
    db,
    id,
    invoice.po_id
  );
  const dispositions = await listInvoiceExceptionDispositions(db, id);
  const latest = dispositions.length ? dispositions[dispositions.length - 1] : null;

  return {
    ...attachQueueMeta(invoice, latest),
    items,
    match_results: matchResults,
    receipts,
    service_entry_sheets: serviceSheets,
    exception_dispositions: dispositions,
    audit_logs: auditLogs
  };
}

/** Attach latest + history for GET /api/invoices/:id. */
export async function attachExceptionToInvoice(db, invoice) {
  if (!invoice) return invoice;
  const dispositions = await listInvoiceExceptionDispositions(db, invoice.id);
  const latest = dispositions.length ? dispositions[dispositions.length - 1] : null;
  return {
    ...invoice,
    exception: latest,
    exception_dispositions: dispositions,
    needs_disposition: invoice.status === 'variance_flagged'
  };
}

function summarizeAcceptedVariances(matchResults, totalCents, matchStatus) {
  const fails = (matchResults || []).filter((row) => row.status === 'fail');
  const parts = [
    `Accepted ${matchStatus} on billed total $${formatCents(totalCents)}`
  ];
  for (const row of fails) {
    const qty = Number(row.qty_variance) || 0;
    const price = asCents(row.price_variance);
    const bits = [];
    if (qty !== 0) bits.push(`qty overage ${qty}`);
    if (price !== 0) bits.push(`price variance ${price}¢`);
    if (bits.length) {
      parts.push(`PO line ${row.po_item_id}: ${bits.join(', ')}`);
    }
  }
  return parts.join('. ');
}

export async function resolveInvoiceException(db, id, payload = {}) {
  const disposition = String(payload.disposition || '').trim();
  if (!DISPOSITIONS.includes(disposition)) {
    throw new InvoiceExceptionError(
      `disposition must be one of: ${DISPOSITIONS.join(', ')}.`
    );
  }
  const reason = requireText(payload.reason, 'reason');
  const actorName = requireText(payload.actor_name, 'actor_name');

  const invoice = await loadInvoiceHeader(db, id);
  if (!invoice) {
    throw new InvoiceExceptionError('Invoice not found.', 404);
  }

  if (invoice.status === 'paid' || invoice.status === 'approved_for_payment') {
    throw new InvoiceExceptionError(
      'Invoice has already progressed to AP approve/pay and cannot take a new exception disposition.'
    );
  }
  if (invoice.status === 'rejected') {
    throw new InvoiceExceptionError('Invoice was already rejected.');
  }
  if (invoice.status !== 'variance_flagged') {
    throw new InvoiceExceptionError(
      'Only variance-flagged invoices can be resolved in the Exception Workbench.'
    );
  }

  const latest = await getLatestDisposition(db, id);
  if (latest && TERMINAL_DISPOSITIONS.includes(latest.disposition)) {
    throw new InvoiceExceptionError(
      `Invoice already has a terminal disposition (${latest.disposition}).`
    );
  }

  const matchResults = await db.prepare(`
    SELECT * FROM match_results WHERE invoice_id = ?
  `).all(id);
  const acceptedTotalCents = asCents(invoice.total_amount);
  const acceptedMatchStatus = invoice.match_status;

  const resolveTransaction = db.transaction(async () => {
    await db.prepare(`
      INSERT INTO invoice_exception_dispositions (
        invoice_id, disposition, reason, actor_name,
        accepted_total_cents, accepted_match_status
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      disposition,
      reason,
      actorName,
      acceptedTotalCents,
      acceptedMatchStatus
    );

    let nextStatus = invoice.status;
    if (disposition === 'accept_variance') {
      nextStatus = 'matched';
      await db.prepare(`UPDATE invoices SET status = ? WHERE id = ?`).run(nextStatus, id);
    } else if (disposition === 'reject_invoice') {
      nextStatus = 'rejected';
      await db.prepare(`UPDATE invoices SET status = ? WHERE id = ?`).run(nextStatus, id);
    }

    const acceptedSummary = summarizeAcceptedVariances(
      matchResults,
      acceptedTotalCents,
      acceptedMatchStatus
    );
    const details = disposition === 'accept_variance'
      ? `${acceptedSummary}. Reason: ${reason}`
      : `Disposition ${disposition} for ${invoice.invoice_number} (billed $${formatCents(acceptedTotalCents)}, match ${acceptedMatchStatus}). Reason: ${reason}`;

    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('invoice', ?, ?, ?, ?)
    `).run(id, DISPOSITION_AUDIT[disposition], actorName, details);

    return { nextStatus, acceptedTotalCents, acceptedMatchStatus, details };
  });

  const outcome = await resolveTransaction();
  const detail = await getInvoiceExceptionDetail(db, id);
  return {
    message: disposition === 'accept_variance'
      ? 'Variance accepted. Invoice may proceed to AP approve for payment.'
      : disposition === 'reject_invoice'
        ? 'Invoice rejected. Approve and pay are permanently blocked.'
        : 'Invoice returned to buyer. Hard exception remains open until accepted or rejected.',
    disposition,
    invoice_status: outcome.nextStatus,
    accepted_total_cents: outcome.acceptedTotalCents,
    accepted_match_status: outcome.acceptedMatchStatus,
    invoice: detail
  };
}
