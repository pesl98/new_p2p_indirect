import { asCents, formatMoney, lineTotalCents, toQty } from './money.js';
import { deploymentCurrency, withDeploymentCurrency } from './currencyConfig.js';
import { MEASURED_SCALE, measuredAmountCents, parseMeasuredMilli } from './measuredQty.js';
import { evaluate3WayMatch, run3WayMatch } from './match.js';
import { assertCanApprovePayment, assertCanMarkPaid, invoicePayableCents } from './invoiceExceptionsService.js';
import {
  assertDuplicateAllowsApprove,
  assertDuplicateAllowsMarkPaid,
  findDuplicateSuspects,
  flagDuplicateSuspectsOnCreate
} from './invoiceDuplicatesService.js';
import { appendComplianceEvent, utcTimestamp } from './complianceAudit.js';
import {
  WEBHOOK_EVENTS,
  enqueueWebhook,
  externalIdFor,
  kickWebhookDispatch
} from './webhookOutbox.js';

const UI_MATCH_ACTOR = Object.freeze({
  actor_user_id: null,
  actor_name: 'System 3-Way Matcher',
  actor_role: null
});

function httpError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function exceptionResult(invoiceStatus) {
  const queued = invoiceStatus === 'variance_flagged';
  return {
    queued,
    workbench: queued ? 'variance_flagged' : null
  };
}

/**
 * UI adapter. Resolves the same defaults the invoice screen always sent,
 * then calls `createSupplierInvoice`. The HTTP body shape is unchanged.
 */
export async function createVendorInvoice(db, payload) {
  const { invoice_number, po_id, supplier_id, invoice_date, due_date, tax_amount, items, notes } = payload;

  if (!items || items.length === 0) {
    throw httpError('Invoice must contain at least one line item.', 400);
  }

  const po = await db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(po_id);
  if (!po) {
    throw httpError('Purchase Order not found.', 404);
  }

  // Normalize before the invoice-number check so a bad measured quantity
  // still fails first, the way this function always did.
  await normalizeInvoiceItems(db, items);

  if (!invoice_number || String(invoice_number).trim() === '') {
    throw httpError('invoice_number is required.', 400);
  }

  try {
    const result = await createSupplierInvoice(db, {
      header: {
        invoice_number,
        po_id,
        supplier_id: supplier_id || po.supplier_id,
        invoice_date: invoice_date || new Date().toISOString().split('T')[0],
        due_date: due_date || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
        tax_amount,
        notes: notes || null
      },
      lines: items,
      actor: UI_MATCH_ACTOR,
      source: 'ui'
    });
    return {
      invoiceId: result.invoiceId,
      matchOutcome: result.matchOutcome,
      duplicate_status: result.duplicate_status,
      duplicate_suspects: result.duplicate_suspects
    };
  } catch (error) {
    if (isUniqueConstraint(error)) {
      throw httpError(
        `Invoice number '${invoice_number}' already exists for this supplier.`,
        400
      );
    }
    throw error;
  }
}

/**
 * Shared supplier-invoice create. The UI route (via `createVendorInvoice`)
 * and `POST /api/integrations/invoices` both call this. Sprint 7b should too.
 *
 * Input is a validated header and lines, plus who is posting and where from.
 * `source` is `ui` or `integration`. `dryRun` evaluates the 3-way match and
 * the duplicate check and returns without writing an invoice, match row,
 * duplicate flag, audit row, or webhook.
 *
 * Persist runs in one transaction: invoice, lines, match, claimed qty,
 * duplicate soft-hold, the `invoice.created` outbox row, and (integration
 * only) the API-key compliance event. The match and the duplicate check run
 * once inside that transaction. `dryRun` is the only path that previews them
 * without writing. Creating an invoice does not approve it, so it does not
 * emit `invoice.approved`. That event is still written by
 * `approveInvoicePayment`, for a UI invoice and an API invoice the same way.
 *
 * @returns Created invoice plus match, duplicate, and exception-queue results.
 *          `exception.queued` means the row is `variance_flagged` and shows
 *          on the existing exception workbench. No parallel queue is written.
 */
export async function createSupplierInvoice(db, {
  header,
  lines,
  actor = null,
  source = 'ui',
  dryRun = false,
  externalId = null,
  now = new Date()
} = {}) {
  if (source !== 'ui' && source !== 'integration') {
    throw httpError('Invoice source must be ui or integration.', 500);
  }
  if (!dryRun && source === 'integration') {
    if (!actor?.actor_name || actor.actor_role !== 'integration') {
      throw httpError('Integration invoice create requires an API key principal.', 500);
    }
  }

  const draft = await buildInvoiceDraft(db, header, lines);
  if (dryRun) {
    const matchOutcome = await evaluate3WayMatch(db, draft.normalizedItems);
    const duplicateSuspects = await findDuplicateSuspects(db, {
      supplierId: draft.supplierId,
      poId: draft.poId,
      totalAmountCents: draft.totalAmount,
      invoiceDate: draft.invoiceDate
    });
    return {
      dry_run: true,
      persisted: false,
      invoiceId: null,
      matchOutcome,
      duplicate_status: duplicateSuspects.length > 0 ? 'suspect' : 'clear',
      duplicate_suspects: duplicateSuspects,
      exception: exceptionResult(matchOutcome.invoiceStatus),
      currency: deploymentCurrency(),
      subtotal: draft.subtotal,
      tax_amount: draft.tax,
      total_amount: draft.totalAmount
    };
  }

  const nested = Boolean(db.inTransaction?.());
  const invoiceTransaction = db.transaction(async () => {
    const invResult = await db.prepare(`
      INSERT INTO invoices (invoice_number, po_id, supplier_id, invoice_date, due_date, subtotal, tax_amount, total_amount, status, match_status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_match', 'pending', ?)
    `).run(
      draft.invoiceNumber,
      draft.poId,
      draft.supplierId,
      draft.invoiceDate,
      draft.dueDate,
      draft.subtotal,
      draft.tax,
      draft.totalAmount,
      draft.notes
    );
    const invoiceId = invResult.lastInsertRowid;

    const insertItem = db.prepare(`
      INSERT INTO invoice_items (invoice_id, po_item_id, description, quantity_invoiced, unit_price, total_price)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const item of draft.normalizedItems) {
      await insertItem.run(
        invoiceId,
        item.po_item_id,
        item.description,
        item.quantity_invoiced,
        item.unit_price,
        item.line_total
      );
    }

    // Match against prior cumulative invoiced qty, then record this claim.
    const persistedMatch = await run3WayMatch(db, invoiceId, draft.poId, draft.normalizedItems);

    for (const item of draft.normalizedItems) {
      await db.prepare(`UPDATE po_items SET quantity_invoiced = quantity_invoiced + ? WHERE id = ?`).run(
        item.quantity_invoiced,
        item.po_item_id
      );
    }

    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('invoice', ?, '3_WAY_MATCHED', 'System 3-Way Matcher', ?)
    `).run(
      invoiceId,
      `Invoice ${draft.invoiceNumber} processed for ${formatMoney(draft.totalAmount)}. Result: ${persistedMatch.overallMatchStatus} (goods: PO+GRN+invoice; consignment: PO+draw-down+invoice; utility/bulk: PO+measured consumption+invoice; services: PO+SES+invoice)`
    );

    // Soft-hold likely duplicates after the invoice exists (same transaction).
    // Dual match is unchanged — this is a separate AP control.
    const duplicate = await flagDuplicateSuspectsOnCreate(db, {
      invoiceId,
      invoiceNumber: draft.invoiceNumber,
      supplierId: draft.supplierId,
      poId: draft.poId,
      totalAmountCents: draft.totalAmount,
      invoiceDate: draft.invoiceDate
    });

    if (source === 'integration') {
      const details = JSON.stringify({
        api_key_id: actor.api_key_id ?? null,
        key_prefix: actor.key_prefix ?? null,
        external_id: externalId || null,
        source: 'integration',
        match_status: persistedMatch.overallMatchStatus,
        status: persistedMatch.invoiceStatus,
        duplicate_status: duplicate.duplicate_status,
        created: true
      });
      await db.prepare(`
        INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
        VALUES ('invoice', ?, 'INTEGRATION_INVOICE_CREATED', ?, ?)
      `).run(invoiceId, actor.actor_name, details);
      await appendComplianceEvent(db, {
        actor_user_id: null,
        actor_name: actor.actor_name,
        actor_role: 'integration',
        action: 'INTEGRATION_INVOICE_CREATED',
        entity_type: 'invoice',
        entity_id: Number(invoiceId),
        details,
        created_at: utcTimestamp(now)
      });
    }

    await enqueueWebhook(db, {
      eventType: WEBHOOK_EVENTS.INVOICE_CREATED,
      entityType: 'invoice',
      entityId: invoiceId,
      data: withDeploymentCurrency({
        invoice_id: Number(invoiceId),
        invoice_number: draft.invoiceNumber,
        supplier_id: Number(draft.supplierId),
        supplier_external_id: await externalIdFor(db, 'supplier', draft.supplierId),
        po_id: Number(draft.poId),
        status: persistedMatch.invoiceStatus,
        match_status: persistedMatch.overallMatchStatus,
        external_id: externalId || null,
        source,
        total_cents: draft.totalAmount
      }),
      now
    });

    return {
      dry_run: false,
      persisted: true,
      invoiceId,
      matchOutcome: persistedMatch,
      duplicate_status: duplicate.duplicate_status,
      duplicate_suspects: duplicate.duplicate_suspects,
      exception: exceptionResult(persistedMatch.invoiceStatus),
      currency: deploymentCurrency(),
      subtotal: draft.subtotal,
      tax_amount: draft.tax,
      total_amount: draft.totalAmount
    };
  });

  const created = await invoiceTransaction();
  if (!nested) kickWebhookDispatch(db);
  return created;
}

/**
 * Header and lines the UI or the integration connector already validated.
 * PO must exist. Money stays integer cents (`asCents` / line totals).
 */
async function buildInvoiceDraft(db, header = {}, lines) {
  if (!lines || lines.length === 0) {
    throw httpError('Invoice must contain at least one line item.', 400);
  }
  const po = await db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(header.po_id);
  if (!po) {
    throw httpError('Purchase Order not found.', 404);
  }
  if (!header.invoice_number || String(header.invoice_number).trim() === '') {
    throw httpError('invoice_number is required.', 400);
  }
  const normalizedItems = await normalizeInvoiceItems(db, lines);
  const subtotal = normalizedItems.reduce((acc, item) => acc + item.line_total, 0);
  const tax = asCents(header.tax_amount);
  return {
    po,
    poId: header.po_id,
    supplierId: header.supplier_id || po.supplier_id,
    invoiceNumber: header.invoice_number,
    invoiceDate: header.invoice_date,
    dueDate: header.due_date,
    notes: header.notes || null,
    normalizedItems,
    subtotal,
    tax,
    totalAmount: subtotal + tax
  };
}

/** Normalized lines (qty, cents, line total). Used to compare a re-post. */
export async function normalizeSupplierInvoiceLines(db, lines) {
  return normalizeInvoiceItems(db, lines);
}

/**
 * Whole-unit lines keep integer qty. Measured utility and bulk lines accept a
 * decimal quantity in the unit of measure and store milli-units, matching the PO.
 */
async function normalizeInvoiceItems(db, items) {
  const normalized = [];
  for (const item of items) {
    const poItem = item?.po_item_id
      ? await db.prepare(`SELECT quantity_scale FROM po_items WHERE id = ?`).get(item.po_item_id)
      : null;
    const unitPrice = asCents(item.unit_price);
    const measured = Number(poItem?.quantity_scale) === MEASURED_SCALE;
    const quantity = measured
      ? parseMeasuredMilli(item.quantity_invoiced, 'quantity_invoiced')
      : toQty(item.quantity_invoiced);
    normalized.push({
      po_item_id: item.po_item_id,
      description: item.description,
      quantity_invoiced: quantity,
      unit_price: unitPrice,
      line_total: measured
        ? measuredAmountCents(quantity, unitPrice)
        : lineTotalCents(quantity, unitPrice)
    });
  }
  return normalized;
}

function isUniqueConstraint(error) {
  return error?.code === 'SQLITE_CONSTRAINT_UNIQUE'
    || (error?.code === 'SQLITE_CONSTRAINT' && /UNIQUE/i.test(error.message || ''))
    || /UNIQUE constraint failed/i.test(error.message || '');
}

export async function approveInvoicePayment(db, id, { approver_name, override_reason } = {}) {
  const invoice = await db.prepare(`
    SELECT inv.*, po.requisition_id, pr.department_id
    FROM invoices inv
    JOIN purchase_orders po ON inv.po_id = po.id
    LEFT JOIN purchase_requisitions pr ON po.requisition_id = pr.id
    WHERE inv.id = ?
  `).get(id);

  if (!invoice) {
    const err = new Error('Invoice not found.');
    err.statusCode = 404;
    throw err;
  }

  // Fail closed: free-text override_reason is a note only — it does not unlock
  // variance_flagged invoices. Accept the exception first. Likely-duplicate
  // suspects are a separate AP hold (Duplicate Suspects).
  assertCanApprovePayment(invoice);
  assertDuplicateAllowsApprove(invoice);

  const billedCents = asCents(invoice.total_amount);
  const payableCents = invoicePayableCents(invoice);
  const isShortPay = invoice.payable_total_cents != null && invoice.payable_total_cents !== '';

  const approveTransaction = db.transaction(async () => {
    await db.prepare(`
      UPDATE invoices
      SET status = 'approved_for_payment', notes = COALESCE(?, notes)
      WHERE id = ?
    `).run(override_reason ? `Approved with override: ${override_reason}` : invoice.notes, id);

    // Integer cents: relieve committed and increase actual spent by payable
    // (billed when payable_total_cents is NULL).
    if (invoice.department_id) {
      await db.prepare(`
        UPDATE budgets
        SET committed_amount = MAX(0, committed_amount - ?),
            actual_spent = actual_spent + ?
        WHERE department_id = ? AND fiscal_year = 2026
      `).run(payableCents, payableCents, invoice.department_id);
    }

    const amountNote = isShortPay
      ? `Billed ${formatMoney(billedCents)} → Pay ${formatMoney(payableCents)}`
      : `${formatMoney(payableCents)}`;
    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('invoice', ?, 'APPROVED_FOR_PAYMENT', ?, ?)
    `).run(
      id,
      approver_name || 'Finance Specialist',
      `Approved invoice ${invoice.invoice_number} for ${amountNote} payment`
    );

    await enqueueWebhook(db, {
      eventType: WEBHOOK_EVENTS.INVOICE_APPROVED,
      entityType: 'invoice',
      entityId: id,
      data: withDeploymentCurrency({
        invoice_id: Number(id),
        invoice_number: invoice.invoice_number,
        supplier_id: Number(invoice.supplier_id),
        supplier_external_id: await externalIdFor(db, 'supplier', invoice.supplier_id),
        po_id: Number(invoice.po_id),
        status: 'approved_for_payment',
        billed_total_cents: billedCents,
        payable_total_cents: payableCents
      })
    });
  });

  await approveTransaction();
  kickWebhookDispatch(db);
  return {
    message: isShortPay
      ? `Invoice approved for payment successfully. Billed ${formatMoney(billedCents)} → Pay ${formatMoney(payableCents)}.`
      : 'Invoice approved for payment successfully.',
    billed_total_cents: billedCents,
    payable_total_cents: payableCents
  };
}

/**
 * Shared mark-paid write: status → paid, payment_reference, PAID audit.
 * Does **not** post budget actuals — those move at Approve for Payment.
 * Call inside an existing transaction (payment-run execute) or wrap via markInvoicePaid.
 */
export async function applyInvoicePaid(db, invoice, { payment_reference, actor } = {}) {
  const ref = payment_reference || `ACH-${Date.now().toString().slice(-6)}`;
  const billedCents = asCents(invoice.total_amount);
  const payableCents = invoicePayableCents(invoice);
  const isShortPay = invoice.payable_total_cents != null && invoice.payable_total_cents !== '';
  const amountNote = isShortPay
    ? `Billed ${formatMoney(billedCents)} → Pay ${formatMoney(payableCents)}`
    : `${formatMoney(payableCents)}`;
  const actorName = actor || 'Finance Lead';

  await db.prepare(`
    UPDATE invoices
    SET status = 'paid', payment_reference = ?
    WHERE id = ?
  `).run(ref, invoice.id);

  await db.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
    VALUES ('invoice', ?, 'PAID', ?, ?)
  `).run(invoice.id, actorName, `Marked as paid with reference ${ref} (${amountNote})`);

  return {
    payment_reference: ref,
    billed_total_cents: billedCents,
    payable_total_cents: payableCents,
    is_short_pay: isShortPay,
    amount_note: amountNote
  };
}

export async function markInvoicePaid(db, id, { payment_reference, payer_name, actor_name } = {}) {
  const invoice = await db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(id);
  if (!invoice) {
    const err = new Error('Invoice not found.');
    err.statusCode = 404;
    throw err;
  }
  assertCanMarkPaid(invoice);
  assertDuplicateAllowsMarkPaid(invoice);

  const ref = payment_reference || `ACH-${Date.now().toString().slice(-6)}`;
  const actor = payer_name || actor_name || 'Finance Lead';

  const payTransaction = db.transaction(async () => {
    return applyInvoicePaid(db, invoice, { payment_reference: ref, actor });
  });

  const paid = await payTransaction();
  return {
    message: paid.is_short_pay
      ? `Invoice marked as paid. Billed ${formatMoney(paid.billed_total_cents)} → Pay ${formatMoney(paid.payable_total_cents)}.`
      : 'Invoice marked as paid.',
    payment_reference: paid.payment_reference,
    billed_total_cents: paid.billed_total_cents,
    payable_total_cents: paid.payable_total_cents
  };
}
