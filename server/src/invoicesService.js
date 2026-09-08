import { asCents, formatCents, lineTotalCents, toQty } from './money.js';
import { run3WayMatch } from './match.js';
import { assertCanApprovePayment, assertCanMarkPaid } from './invoiceExceptionsService.js';

/**
 * Persist a vendor invoice, run 3-way match against prior cumulative invoiced
 * qty, then always record this claim on `po_items.quantity_invoiced` for audit.
 * All money fields are integer cents.
 */
export async function createVendorInvoice(db, payload) {
  const { invoice_number, po_id, supplier_id, invoice_date, due_date, tax_amount, items, notes } = payload;

  if (!items || items.length === 0) {
    const err = new Error('Invoice must contain at least one line item.');
    err.statusCode = 400;
    throw err;
  }

  const po = await db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(po_id);
  if (!po) {
    const err = new Error('Purchase Order not found.');
    err.statusCode = 404;
    throw err;
  }

  const normalizedItems = items.map((item) => ({
    po_item_id: item.po_item_id,
    description: item.description,
    quantity_invoiced: toQty(item.quantity_invoiced),
    unit_price: asCents(item.unit_price)
  }));

  const calculatedSubtotal = normalizedItems.reduce(
    (acc, item) => acc + lineTotalCents(item.quantity_invoiced, item.unit_price),
    0
  );
  const tax = asCents(tax_amount);
  const totalAmount = calculatedSubtotal + tax;

  if (!invoice_number || String(invoice_number).trim() === '') {
    const err = new Error('invoice_number is required.');
    err.statusCode = 400;
    throw err;
  }

  const resolvedSupplierId = supplier_id || po.supplier_id;

  const invoiceTransaction = db.transaction(async () => {
    const insertInvoice = db.prepare(`
      INSERT INTO invoices (invoice_number, po_id, supplier_id, invoice_date, due_date, subtotal, tax_amount, total_amount, status, match_status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_match', 'pending', ?)
    `);
    const invResult = await insertInvoice.run(
      invoice_number,
      po_id,
      resolvedSupplierId,
      invoice_date || new Date().toISOString().split('T')[0],
      due_date || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
      calculatedSubtotal,
      tax,
      totalAmount,
      notes || null
    );

    const invoiceId = invResult.lastInsertRowid;

    const insertItem = db.prepare(`
      INSERT INTO invoice_items (invoice_id, po_item_id, description, quantity_invoiced, unit_price, total_price)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const item of normalizedItems) {
      await insertItem.run(
        invoiceId,
        item.po_item_id,
        item.description,
        item.quantity_invoiced,
        item.unit_price,
        lineTotalCents(item.quantity_invoiced, item.unit_price)
      );
    }

    // Match against prior cumulative invoiced qty, then record this claim.
    const matchOutcome = await run3WayMatch(db, invoiceId, po_id, normalizedItems);

    for (const item of normalizedItems) {
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
      `Invoice ${invoice_number} processed for $${formatCents(totalAmount)}. Result: ${matchOutcome.overallMatchStatus} (goods: PO+GRN+invoice; services: PO+SES+invoice)`
    );

    return { invoiceId, matchOutcome };
  });

  try {
    return await invoiceTransaction();
  } catch (error) {
    if (isUniqueConstraint(error)) {
      const err = new Error(
        `Invoice number '${invoice_number}' already exists for this supplier.`
      );
      err.statusCode = 400;
      throw err;
    }
    throw error;
  }
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
  // variance_flagged invoices. Accept the exception first.
  assertCanApprovePayment(invoice);

  const approveTransaction = db.transaction(async () => {
    await db.prepare(`
      UPDATE invoices
      SET status = 'approved_for_payment', notes = COALESCE(?, notes)
      WHERE id = ?
    `).run(override_reason ? `Approved with override: ${override_reason}` : invoice.notes, id);

    // Integer cents: relieve committed, increase actual spent.
    if (invoice.department_id) {
      await db.prepare(`
        UPDATE budgets
        SET committed_amount = MAX(0, committed_amount - ?),
            actual_spent = actual_spent + ?
        WHERE department_id = ? AND fiscal_year = 2026
      `).run(invoice.total_amount, invoice.total_amount, invoice.department_id);
    }

    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('invoice', ?, 'APPROVED_FOR_PAYMENT', ?, ?)
    `).run(
      id,
      approver_name || 'Finance Specialist',
      `Approved invoice ${invoice.invoice_number} for $${formatCents(invoice.total_amount)} payment`
    );
  });

  await approveTransaction();
  return { message: 'Invoice approved for payment successfully.' };
}

export async function markInvoicePaid(db, id, { payment_reference, payer_name } = {}) {
  const invoice = await db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(id);
  if (!invoice) {
    const err = new Error('Invoice not found.');
    err.statusCode = 404;
    throw err;
  }
  assertCanMarkPaid(invoice);

  const ref = payment_reference || `ACH-${Date.now().toString().slice(-6)}`;

  const payTransaction = db.transaction(async () => {
    await db.prepare(`
      UPDATE invoices
      SET status = 'paid', payment_reference = ?
      WHERE id = ?
    `).run(ref, id);

    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('invoice', ?, 'PAID', ?, ?)
    `).run(id, payer_name || 'Finance Lead', `Marked as paid with reference ${ref}`);
  });

  await payTransaction();
  return { message: 'Invoice marked as paid.', payment_reference: ref };
}
