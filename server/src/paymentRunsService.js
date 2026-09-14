/**
 * AP payment run / payment proposal (batch ACH).
 *
 * Coupa/Ariba-style: select approved_for_payment invoices → numbered draft
 * PAY-YYYY-NNN → execute once. Execute marks every line paid in one
 * transaction via the same applyInvoicePaid path as single mark-paid
 * (status paid + shared payment_reference + PAID audit). Budget actuals
 * already moved at Approve for Payment — this engine must not post them again.
 */

import { asCents, formatCents } from './money.js';
import { nextDocumentNumber } from './docNumbers.js';
import { applyInvoicePaid } from './invoicesService.js';
import { assertCanMarkPaid, invoicePayableCents } from './invoiceExceptionsService.js';
import { assertDuplicateAllowsMarkPaid } from './invoiceDuplicatesService.js';

export const PAYMENT_RUN_STATUSES = Object.freeze(['draft', 'executed', 'cancelled']);
export const OPEN_OR_EXECUTED = Object.freeze(['draft', 'executed']);

export const PAYMENT_RUN_AUDIT = Object.freeze({
  CREATED: 'PAYMENT_RUN_CREATED',
  EXECUTED: 'PAYMENT_RUN_EXECUTED',
  CANCELLED: 'PAYMENT_RUN_CANCELLED'
});

export class PaymentRunError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'PaymentRunError';
    this.statusCode = statusCode;
  }
}

function requireText(value, field) {
  const text = value == null ? '' : String(value).trim();
  if (!text) {
    throw new PaymentRunError(`${field} is required.`);
  }
  return text;
}

function requireUtcDate(value, field = 'payment_date') {
  const text = value == null ? '' : String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new PaymentRunError(`${field} must be a UTC calendar date (YYYY-MM-DD).`);
  }
  return text;
}

function parseRunId(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) {
    throw new PaymentRunError('Payment run id must be a positive integer.');
  }
  return n;
}

export function normalizeInvoiceIds(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const ids = [];
  const seen = new Set();
  for (const value of list) {
    if (value === undefined || value === null || value === '') {
      throw new PaymentRunError('invoice_ids must be positive integers.');
    }
    if (typeof value === 'boolean' || typeof value === 'object') {
      throw new PaymentRunError('invoice_ids must be positive integers.');
    }
    if (typeof value === 'number') {
      if (!Number.isInteger(value) || value <= 0) {
        throw new PaymentRunError('invoice_ids must be positive integers.');
      }
      if (!seen.has(value)) {
        seen.add(value);
        ids.push(value);
      }
      continue;
    }
    const text = String(value).trim();
    if (!/^\d+$/.test(text)) {
      throw new PaymentRunError('invoice_ids must be positive integers.');
    }
    const n = Number(text);
    if (!Number.isInteger(n) || n <= 0) {
      throw new PaymentRunError('invoice_ids must be positive integers.');
    }
    if (!seen.has(n)) {
      seen.add(n);
      ids.push(n);
    }
  }
  if (ids.length === 0) {
    throw new PaymentRunError('Select at least one approved invoice for the payment run.');
  }
  return ids;
}

function mapRunRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    run_number: row.run_number,
    status: row.status,
    payment_date: row.payment_date || null,
    payment_reference: row.payment_reference || null,
    actor_name: row.actor_name,
    billed_total_cents: asCents(row.billed_total_cents),
    payable_total_cents: asCents(row.payable_total_cents),
    invoice_count: Number(row.invoice_count) || 0,
    reason: row.reason || null,
    created_at: row.created_at,
    executed_at: row.executed_at || null,
    cancelled_at: row.cancelled_at || null
  };
}

function mapItemRow(row) {
  const billed = asCents(row.billed_total_cents);
  const payable = asCents(row.payable_total_cents);
  return {
    id: row.id,
    run_id: row.run_id,
    invoice_id: row.invoice_id,
    invoice_number: row.invoice_number,
    supplier_id: row.supplier_id,
    supplier_name: row.supplier_name,
    po_id: row.po_id,
    po_number: row.po_number,
    invoice_date: row.invoice_date,
    due_date: row.due_date,
    invoice_status: row.invoice_status,
    match_status: row.match_status,
    duplicate_status: row.duplicate_status || 'clear',
    billed_total_cents: billed,
    payable_total_cents: payable,
    invoice_billed_cents: row.invoice_total_amount != null ? asCents(row.invoice_total_amount) : billed,
    invoice_payable_cents: row.invoice_payable_total_cents != null && row.invoice_payable_total_cents !== ''
      ? asCents(row.invoice_payable_total_cents)
      : (row.invoice_total_amount != null ? asCents(row.invoice_total_amount) : payable),
    has_short_pay: row.invoice_payable_total_cents != null && row.invoice_payable_total_cents !== '',
    payment_reference: row.invoice_payment_reference || null,
    pr_number: row.pr_number || null,
    requester_name: row.requester_name || null
  };
}

const ITEM_SELECT = `
  SELECT
    pri.id,
    pri.run_id,
    pri.invoice_id,
    pri.billed_total_cents,
    pri.payable_total_cents,
    inv.invoice_number,
    inv.supplier_id,
    inv.invoice_date,
    inv.due_date,
    inv.status as invoice_status,
    inv.match_status,
    inv.duplicate_status,
    inv.total_amount as invoice_total_amount,
    inv.payable_total_cents as invoice_payable_total_cents,
    inv.payment_reference as invoice_payment_reference,
    s.name as supplier_name,
    po.id as po_id,
    po.po_number,
    pr.pr_number,
    u.name as requester_name
  FROM payment_run_items pri
  JOIN invoices inv ON pri.invoice_id = inv.id
  JOIN suppliers s ON inv.supplier_id = s.id
  JOIN purchase_orders po ON inv.po_id = po.id
  LEFT JOIN purchase_requisitions pr ON po.requisition_id = pr.id
  LEFT JOIN users u ON pr.requester_id = u.id
`;

async function loadRun(db, id) {
  return db.prepare(`SELECT * FROM payment_runs WHERE id = ?`).get(id);
}

async function loadItems(db, runId) {
  const rows = await db.prepare(`
    ${ITEM_SELECT}
    WHERE pri.run_id = ?
    ORDER BY pri.id ASC
  `).all(runId);
  return (rows || []).map(mapItemRow);
}

async function findBlockingRuns(db, invoiceId, exceptRunId = null) {
  const rows = exceptRunId
    ? await db.prepare(`
        SELECT pr.id, pr.run_number, pr.status
        FROM payment_run_items pri
        JOIN payment_runs pr ON pr.id = pri.run_id
        WHERE pri.invoice_id = ?
          AND pr.status IN ('draft', 'executed')
          AND pr.id != ?
      `).all(invoiceId, exceptRunId)
    : await db.prepare(`
        SELECT pr.id, pr.run_number, pr.status
        FROM payment_run_items pri
        JOIN payment_runs pr ON pr.id = pri.run_id
        WHERE pri.invoice_id = ?
          AND pr.status IN ('draft', 'executed')
      `).all(invoiceId);
  return rows || [];
}

async function loadEligibleInvoice(db, invoiceId) {
  return db.prepare(`
    SELECT
      inv.*,
      po.po_number,
      s.name as supplier_name
    FROM invoices inv
    JOIN purchase_orders po ON inv.po_id = po.id
    JOIN suppliers s ON inv.supplier_id = s.id
    WHERE inv.id = ?
  `).get(invoiceId);
}

function assertInvoiceEligibleForDraft(invoice) {
  if (!invoice) {
    throw new PaymentRunError('Invoice not found.', 404);
  }
  if (invoice.status === 'paid') {
    throw new PaymentRunError(
      `Invoice ${invoice.invoice_number} is already paid and cannot be added to a payment run.`
    );
  }
  if (invoice.status === 'rejected') {
    throw new PaymentRunError(
      `Invoice ${invoice.invoice_number} was rejected and cannot be added to a payment run.`
    );
  }
  if (invoice.status !== 'approved_for_payment') {
    throw new PaymentRunError(
      `Invoice ${invoice.invoice_number} must be approved for payment before it can join a payment run (status '${invoice.status}').`
    );
  }
  assertDuplicateAllowsMarkPaid(invoice);
}

export async function listPaymentRuns(db, { status } = {}) {
  let sql = `
    SELECT *
    FROM payment_runs
    WHERE 1=1
  `;
  const params = [];
  if (status && status !== 'all') {
    if (!PAYMENT_RUN_STATUSES.includes(status)) {
      throw new PaymentRunError(`status must be one of: ${PAYMENT_RUN_STATUSES.join(', ')}, all.`);
    }
    sql += ` AND status = ?`;
    params.push(status);
  }
  sql += ` ORDER BY id DESC`;
  const rows = await db.prepare(sql).all(...params);
  return (rows || []).map(mapRunRow);
}

export async function getPaymentRunDetail(db, id) {
  const runId = parseRunId(id);
  const row = await loadRun(db, runId);
  if (!row) {
    throw new PaymentRunError('Payment run not found.', 404);
  }
  const items = await loadItems(db, runId);
  return { ...mapRunRow(row), items };
}

export async function listEligiblePaymentRunInvoices(db) {
  const rows = await db.prepare(`
    SELECT
      inv.id,
      inv.invoice_number,
      inv.supplier_id,
      inv.invoice_date,
      inv.due_date,
      inv.status,
      inv.match_status,
      inv.duplicate_status,
      inv.total_amount,
      inv.payable_total_cents,
      s.name as supplier_name,
      po.id as po_id,
      po.po_number,
      pr.pr_number,
      u.name as requester_name
    FROM invoices inv
    JOIN suppliers s ON inv.supplier_id = s.id
    JOIN purchase_orders po ON inv.po_id = po.id
    LEFT JOIN purchase_requisitions pr ON po.requisition_id = pr.id
    LEFT JOIN users u ON pr.requester_id = u.id
    WHERE inv.status = 'approved_for_payment'
      AND inv.duplicate_status NOT IN ('suspect', 'confirmed_duplicate')
      AND inv.id NOT IN (
        SELECT pri.invoice_id
        FROM payment_run_items pri
        JOIN payment_runs prun ON prun.id = pri.run_id
        WHERE prun.status IN ('draft', 'executed')
      )
    ORDER BY inv.due_date ASC, inv.id ASC
  `).all();

  return (rows || []).map((row) => {
    const billed = asCents(row.total_amount);
    const payable = row.payable_total_cents != null && row.payable_total_cents !== ''
      ? asCents(row.payable_total_cents)
      : billed;
    return {
      id: row.id,
      invoice_number: row.invoice_number,
      supplier_id: row.supplier_id,
      supplier_name: row.supplier_name,
      po_id: row.po_id,
      po_number: row.po_number,
      invoice_date: row.invoice_date,
      due_date: row.due_date,
      status: row.status,
      match_status: row.match_status,
      duplicate_status: row.duplicate_status || 'clear',
      billed_total_cents: billed,
      payable_total_cents: row.payable_total_cents != null && row.payable_total_cents !== ''
        ? asCents(row.payable_total_cents)
        : null,
      effective_payable_cents: payable,
      has_short_pay: row.payable_total_cents != null && row.payable_total_cents !== '',
      pr_number: row.pr_number || null,
      requester_name: row.requester_name || null
    };
  });
}

export async function createPaymentRun(db, { invoice_ids, actor_name, reason } = {}) {
  const ids = normalizeInvoiceIds(invoice_ids);
  const actor = requireText(actor_name, 'actor_name');
  const note = reason == null || String(reason).trim() === '' ? null : String(reason).trim();

  const createTx = db.transaction(async () => {
    const invoices = [];
    let billedTotal = 0;
    let payableTotal = 0;

    for (const invoiceId of ids) {
      const invoice = await loadEligibleInvoice(db, invoiceId);
      if (!invoice) {
        throw new PaymentRunError(`Invoice id ${invoiceId} was not found.`, 404);
      }
      assertInvoiceEligibleForDraft(invoice);
      const blocking = await findBlockingRuns(db, invoiceId);
      if (blocking.length > 0) {
        throw new PaymentRunError(
          `Invoice ${invoice.invoice_number} is already on payment run ${blocking[0].run_number} (${blocking[0].status}).`
        );
      }
      const billed = asCents(invoice.total_amount);
      const payable = invoicePayableCents(invoice);
      if (!Number.isInteger(billed) || !Number.isInteger(payable)) {
        throw new PaymentRunError('Invoice amounts must be integer cents.');
      }
      billedTotal += billed;
      payableTotal += payable;
      invoices.push({ invoice, billed, payable });
    }

    const runNumber = await nextDocumentNumber(db, 'pay');
    const insertRun = await db.prepare(`
      INSERT INTO payment_runs (
        run_number, status, actor_name, billed_total_cents, payable_total_cents, invoice_count, reason
      ) VALUES (?, 'draft', ?, ?, ?, ?, ?)
    `).run(runNumber, actor, billedTotal, payableTotal, invoices.length, note);
    const runId = insertRun.lastInsertRowid;

    const insertItem = db.prepare(`
      INSERT INTO payment_run_items (run_id, invoice_id, billed_total_cents, payable_total_cents)
      VALUES (?, ?, ?, ?)
    `);
    for (const line of invoices) {
      await insertItem.run(runId, line.invoice.id, line.billed, line.payable);
    }

    const numbers = invoices.map((line) => line.invoice.invoice_number).join(', ');
    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('payment_run', ?, ?, ?, ?)
    `).run(
      runId,
      PAYMENT_RUN_AUDIT.CREATED,
      actor,
      `Created payment run ${runNumber} with ${invoices.length} invoice(s) totaling payable $${formatCents(payableTotal)} (billed $${formatCents(billedTotal)}): ${numbers}`
    );

    return runId;
  });

  const runId = await createTx();
  return getPaymentRunDetail(db, runId);
}

export async function executePaymentRun(db, id, {
  payment_date,
  payment_reference,
  actor_name,
  payer_name,
  reason
} = {}) {
  const runId = parseRunId(id);
  const paymentDate = requireUtcDate(payment_date, 'payment_date');
  const paymentRef = requireText(payment_reference, 'payment_reference');
  const note = reason == null || String(reason).trim() === '' ? null : String(reason).trim();

  const executeTx = db.transaction(async () => {
    const run = await loadRun(db, runId);
    if (!run) {
      throw new PaymentRunError('Payment run not found.', 404);
    }
    if (run.status === 'executed') {
      throw new PaymentRunError(
        `Payment run ${run.run_number} is already executed and cannot be executed again.`
      );
    }
    if (run.status === 'cancelled') {
      throw new PaymentRunError(
        `Payment run ${run.run_number} is cancelled and cannot be executed.`
      );
    }
    if (run.status !== 'draft') {
      throw new PaymentRunError(
        `Payment run ${run.run_number} status '${run.status}' cannot be executed.`
      );
    }

    const actor = (actor_name && String(actor_name).trim())
      || (payer_name && String(payer_name).trim())
      || run.actor_name;
    if (!actor) {
      throw new PaymentRunError('actor_name is required.');
    }

    const items = await db.prepare(`
      SELECT pri.*, inv.invoice_number
      FROM payment_run_items pri
      JOIN invoices inv ON inv.id = pri.invoice_id
      WHERE pri.run_id = ?
      ORDER BY pri.id ASC
    `).all(runId);
    if (!items || items.length === 0) {
      throw new PaymentRunError('Payment run has no invoices to execute.');
    }

    const paidLines = [];
    for (const item of items) {
      const invoice = await db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(item.invoice_id);
      if (!invoice) {
        throw new PaymentRunError(`Invoice id ${item.invoice_id} was not found.`, 404);
      }
      try {
        assertCanMarkPaid(invoice);
        assertDuplicateAllowsMarkPaid(invoice);
      } catch (error) {
        const number = invoice.invoice_number || item.invoice_number;
        throw new PaymentRunError(
          `Cannot execute ${run.run_number}: invoice ${number} is no longer approved for payment (${error.message})`,
          error.statusCode || 400
        );
      }
      const paid = await applyInvoicePaid(db, invoice, {
        payment_reference: paymentRef,
        actor
      });
      await db.prepare(`
        INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
        VALUES ('invoice', ?, ?, ?, ?)
      `).run(
        invoice.id,
        PAYMENT_RUN_AUDIT.EXECUTED,
        actor,
        `Paid on payment run ${run.run_number} with shared ACH reference ${paymentRef} (${paid.amount_note})`
      );
      paidLines.push({
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number,
        billed_total_cents: paid.billed_total_cents,
        payable_total_cents: paid.payable_total_cents
      });
    }

    const numbers = paidLines.map((line) => line.invoice_number).join(', ');
    const executeReason = note || run.reason;
    await db.prepare(`
      UPDATE payment_runs
      SET status = 'executed',
          payment_date = ?,
          payment_reference = ?,
          actor_name = ?,
          reason = COALESCE(?, reason),
          executed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(paymentDate, paymentRef, actor, executeReason, runId);

    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('payment_run', ?, ?, ?, ?)
    `).run(
      runId,
      PAYMENT_RUN_AUDIT.EXECUTED,
      actor,
      `Executed payment run ${run.run_number} on ${paymentDate} with ACH ${paymentRef}. ${paidLines.length} invoice(s) marked paid (payable $${formatCents(run.payable_total_cents)}): ${numbers}`
    );

    return paidLines;
  });

  await executeTx();
  return getPaymentRunDetail(db, runId);
}

export async function cancelPaymentRun(db, id, { actor_name, reason } = {}) {
  const runId = parseRunId(id);
  const actor = requireText(actor_name, 'actor_name');
  const note = reason == null || String(reason).trim() === '' ? null : String(reason).trim();

  const cancelTx = db.transaction(async () => {
    const run = await loadRun(db, runId);
    if (!run) {
      throw new PaymentRunError('Payment run not found.', 404);
    }
    if (run.status === 'executed') {
      throw new PaymentRunError(
        `Payment run ${run.run_number} is already executed and cannot be cancelled.`
      );
    }
    if (run.status === 'cancelled') {
      throw new PaymentRunError(`Payment run ${run.run_number} is already cancelled.`);
    }
    if (run.status !== 'draft') {
      throw new PaymentRunError(
        `Payment run ${run.run_number} status '${run.status}' cannot be cancelled.`
      );
    }

    await db.prepare(`
      UPDATE payment_runs
      SET status = 'cancelled',
          cancelled_at = CURRENT_TIMESTAMP,
          reason = COALESCE(?, reason)
      WHERE id = ?
    `).run(note, runId);

    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('payment_run', ?, ?, ?, ?)
    `).run(
      runId,
      PAYMENT_RUN_AUDIT.CANCELLED,
      actor,
      `Cancelled draft payment run ${run.run_number}${note ? `. Reason: ${note}` : ''}`
    );
  });

  await cancelTx();
  return getPaymentRunDetail(db, runId);
}
