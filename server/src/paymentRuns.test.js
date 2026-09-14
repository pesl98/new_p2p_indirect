import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMemoryDatabase } from './db.js';
import { createApp } from './app.js';
import { loadDbConfig } from './dbConfig.js';
import { createVendorInvoice, approveInvoicePayment, markInvoicePaid } from './invoicesService.js';
import { resolveInvoiceException } from './invoiceExceptionsService.js';
import { getDocumentTrail } from './documentTrailService.js';
import { nextDocumentNumber } from './docNumbers.js';
import {
  PAYMENT_RUN_AUDIT,
  cancelPaymentRun,
  createPaymentRun,
  executePaymentRun,
  getPaymentRunDetail,
  listEligiblePaymentRunInvoices,
  listPaymentRuns,
  normalizeInvoiceIds
} from './paymentRunsService.js';

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', async () => {
      try {
        const { port } = server.address();
        await fn(`http://127.0.0.1:${port}`);
        server.close(() => resolve());
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

async function json(response) {
  return { status: response.status, body: await response.json() };
}

async function createTestDb() {
  const db = await createMemoryDatabase();
  await db.exec(`
    INSERT INTO departments (id, code, name) VALUES (1, 'MKT', 'Marketing'), (4, 'HRP', 'HR');
    INSERT INTO users (id, name, email, role, department_id, approval_limit) VALUES
      (1, 'David Miller', 'david@example.com', 'finance', 1, 15000000),
      (2, 'Alice Chen', 'alice@example.com', 'requester', 1, 0),
      (8, 'Sofia Berg', 'sofia@example.com', 'approver', 4, 1000000);
    INSERT INTO suppliers (id, name, code) VALUES
      (1, 'TechSupply Global', 'SUP-TSG'),
      (3, 'WorkSpace Ergonomics Depot', 'SUP-WED'),
      (4, 'FacilityCare & Janitorial Pro', 'SUP-FCJ');
    INSERT INTO budgets (department_id, fiscal_year, total_budget, committed_amount, actual_spent)
      VALUES (1, 2026, 50000000, 100000, 0), (4, 2026, 6000000, 0, 0);
  `);
  return db;
}

async function insertPoLine(db, {
  ordered,
  received,
  unitPriceCents,
  invoiced = 0,
  accepted = 0,
  lineType = 'goods',
  category = 'IT Hardware',
  description = 'Test Monitor',
  poId = 1,
  itemId = 1,
  poNumber = 'PO-TEST-001',
  supplierId = 1,
  requisitionId = null
}) {
  const existingPo = await db.prepare(`SELECT id FROM purchase_orders WHERE id = ?`).get(poId);
  if (!existingPo) {
    await db.prepare(`
      INSERT INTO purchase_orders (id, po_number, requisition_id, supplier_id, created_by, status, total_amount, issue_date)
      VALUES (?, ?, ?, ?, 1, 'partially_received', ?, '2026-09-01')
    `).run(poId, poNumber, requisitionId, supplierId, ordered * unitPriceCents);
  }

  await db.prepare(`
    INSERT INTO po_items (id, po_id, item_description, category, quantity, unit_price, total_price, quantity_received, quantity_accepted, quantity_invoiced, line_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    itemId,
    poId,
    description,
    category,
    ordered,
    unitPriceCents,
    ordered * unitPriceCents,
    received,
    accepted,
    invoiced,
    lineType
  );
}

function invoicePayload({
  qty,
  unitPriceCents,
  invoiceNumber = 'INV-TEST-1',
  poId = 1,
  itemId = 1,
  description = 'Test Monitor',
  dueDate = '2026-10-04',
  invoiceDate = '2026-09-04',
  supplierId = 1
}) {
  return {
    invoice_number: invoiceNumber,
    po_id: poId,
    supplier_id: supplierId,
    invoice_date: invoiceDate,
    due_date: dueDate,
    tax_amount: 0,
    items: [
      {
        po_item_id: itemId,
        description,
        quantity_invoiced: qty,
        unit_price: unitPriceCents
      }
    ]
  };
}

async function createMatchedApproved(db, {
  dueDate = '2026-09-20',
  invoiceNumber,
  poId,
  itemId,
  poNumber,
  qty = 1,
  unitPriceCents = 7200,
  supplierId = 3,
  description = 'Espresso Beans',
  category = 'Office Supplies',
  requisitionId = null
}) {
  await insertPoLine(db, {
    ordered: qty,
    received: qty,
    unitPriceCents,
    poId,
    itemId,
    poNumber,
    supplierId,
    description,
    category,
    requisitionId
  });
  const created = await createVendorInvoice(db, invoicePayload({
    qty,
    unitPriceCents,
    invoiceNumber,
    poId,
    itemId,
    description,
    dueDate,
    supplierId
  }));
  await approveInvoicePayment(db, created.invoiceId, { approver_name: 'David Miller' });
  return created;
}

describe('payment run invoice id parsing', () => {
  test('rejects empty, float, and non-integer selections', () => {
    assert.throws(() => normalizeInvoiceIds([]), /at least one/);
    assert.throws(() => normalizeInvoiceIds(undefined), /at least one/);
    assert.throws(() => normalizeInvoiceIds([1.5]), /positive integers/);
    assert.throws(() => normalizeInvoiceIds(['12.0']), /positive integers/);
    assert.throws(() => normalizeInvoiceIds([0]), /positive integers/);
    assert.deepEqual(normalizeInvoiceIds(['11', 12, 12]), [11, 12]);
  });
});

describe('payment run draft', () => {
  test('creates a numbered draft from approved invoices with integer-cent snapshots', async () => {
    const db = await createTestDb();
    const a = await createMatchedApproved(db, {
      invoiceNumber: 'INV-WED-4419',
      poId: 13,
      itemId: 13,
      poNumber: 'PO-2026-013',
      unitPriceCents: 7200,
      supplierId: 3
    });
    const b = await createMatchedApproved(db, {
      invoiceNumber: 'INV-FCJ-9920',
      poId: 14,
      itemId: 14,
      poNumber: 'PO-2026-014',
      unitPriceCents: 14500,
      supplierId: 4,
      description: 'Sanitizer Stand',
      category: 'Facilities & MRO'
    });

    const run = await createPaymentRun(db, {
      invoice_ids: [a.invoiceId, b.invoiceId],
      actor_name: 'David Miller',
      reason: 'September ACH batch'
    });

    assert.match(run.run_number, /^PAY-20\d{2}-\d{3}$/);
    assert.equal(run.status, 'draft');
    assert.equal(run.invoice_count, 2);
    assert.equal(run.billed_total_cents, 21700);
    assert.equal(run.payable_total_cents, 21700);
    assert.equal(Number.isInteger(run.billed_total_cents), true);
    assert.equal(Number.isInteger(run.payable_total_cents), true);
    assert.equal(run.items.length, 2);
    assert.deepEqual(run.items.map((row) => row.invoice_number), ['INV-WED-4419', 'INV-FCJ-9920']);

    const audit = await db.prepare(`
      SELECT action, actor_name FROM audit_logs
      WHERE entity_type = 'payment_run' AND entity_id = ? AND action = ?
    `).get(run.id, PAYMENT_RUN_AUDIT.CREATED);
    assert.equal(audit.actor_name, 'David Miller');

    const listed = await listPaymentRuns(db);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].run_number, run.run_number);

    const eligible = await listEligiblePaymentRunInvoices(db);
    assert.equal(eligible.length, 0);
  });

  test('rejects empty, unmatched, duplicate-suspect, and already-on-run invoices', async () => {
    const db = await createTestDb();
    await assert.rejects(
      () => createPaymentRun(db, { invoice_ids: [], actor_name: 'David Miller' }),
      (err) => err.statusCode === 400 && /at least one/.test(err.message)
    );
    await assert.rejects(
      () => createPaymentRun(db, { invoice_ids: [1], actor_name: '' }),
      (err) => err.statusCode === 400 && /actor_name/.test(err.message)
    );

    await insertPoLine(db, {
      ordered: 1, received: 1, unitPriceCents: 34900, poId: 1, itemId: 1, poNumber: 'PO-A', supplierId: 3
    });
    const matched = await createVendorInvoice(db, invoicePayload({
      qty: 1, unitPriceCents: 34900, invoiceNumber: 'INV-MATCHED', poId: 1, itemId: 1, supplierId: 3
    }));
    await assert.rejects(
      () => createPaymentRun(db, { invoice_ids: [matched.invoiceId], actor_name: 'David Miller' }),
      (err) => err.statusCode === 400 && /approved for payment/.test(err.message)
    );

    await insertPoLine(db, {
      ordered: 4, received: 2, unitPriceCents: 74900, poId: 2, itemId: 2, poNumber: 'PO-HARD', supplierId: 1
    });
    const flagged = await createVendorInvoice(db, invoicePayload({
      qty: 4, unitPriceCents: 79900, invoiceNumber: 'INV-TSG-11029', poId: 2, itemId: 2, supplierId: 1
    }));
    await assert.rejects(
      () => createPaymentRun(db, { invoice_ids: [flagged.invoiceId], actor_name: 'David Miller' }),
      (err) => err.statusCode === 400 && /approved for payment/.test(err.message)
    );

    const approved = await createMatchedApproved(db, {
      invoiceNumber: 'INV-WED-4419',
      poId: 13,
      itemId: 13,
      poNumber: 'PO-2026-013',
      unitPriceCents: 7200,
      supplierId: 3
    });
    await createPaymentRun(db, {
      invoice_ids: [approved.invoiceId],
      actor_name: 'David Miller'
    });
    await assert.rejects(
      () => createPaymentRun(db, { invoice_ids: [approved.invoiceId], actor_name: 'David Miller' }),
      (err) => err.statusCode === 400 && /already on payment run/.test(err.message)
    );

    const suspect = await createMatchedApproved(db, {
      invoiceNumber: 'INV-TSG-6611',
      poId: 12,
      itemId: 12,
      poNumber: 'PO-DUP-B',
      unitPriceCents: 9900,
      supplierId: 1,
      description: 'Mouse',
      category: 'IT Hardware'
    });
    await db.prepare(`UPDATE invoices SET duplicate_status = 'suspect' WHERE id = ?`).run(suspect.invoiceId);
    await assert.rejects(
      () => createPaymentRun(db, { invoice_ids: [suspect.invoiceId], actor_name: 'David Miller' }),
      (err) => err.statusCode === 400 && /duplicate/i.test(err.message)
    );
  });

  test('snapshots short-pay payable cents, not billed', async () => {
    const db = await createTestDb();
    await insertPoLine(db, {
      ordered: 1, received: 1, unitPriceCents: 21000, poId: 8, itemId: 8, poNumber: 'PO-2026-008', supplierId: 4,
      description: 'First Aid', category: 'Facilities & MRO'
    });
    const created = await createVendorInvoice(db, invoicePayload({
      qty: 1, unitPriceCents: 22000, invoiceNumber: 'INV-FCJ-8810', poId: 8, itemId: 8, supplierId: 4,
      description: 'First Aid'
    }));
    await resolveInvoiceException(db, created.invoiceId, {
      disposition: 'short_pay',
      payable_total_cents: 21000,
      reason: 'Pay PO price.',
      actor_name: 'David Miller'
    });
    await approveInvoicePayment(db, created.invoiceId, { approver_name: 'David Miller' });

    const run = await createPaymentRun(db, {
      invoice_ids: [created.invoiceId],
      actor_name: 'David Miller'
    });
    assert.equal(run.billed_total_cents, 22000);
    assert.equal(run.payable_total_cents, 21000);
    assert.equal(run.items[0].has_short_pay, true);
    assert.equal(run.items[0].payable_total_cents, 21000);
  });
});

describe('payment run execute and cancel', () => {
  test('execute marks every line paid with a shared ACH reference', async () => {
    const db = await createTestDb();
    const a = await createMatchedApproved(db, {
      invoiceNumber: 'INV-WED-4419', poId: 13, itemId: 13, poNumber: 'PO-PAY-013',
      unitPriceCents: 7200, supplierId: 3
    });
    const b = await createMatchedApproved(db, {
      invoiceNumber: 'INV-FCJ-9920', poId: 14, itemId: 14, poNumber: 'PO-PAY-014',
      unitPriceCents: 14500, supplierId: 4, description: 'Sanitizer', category: 'Facilities & MRO'
    });
    const draft = await createPaymentRun(db, {
      invoice_ids: [a.invoiceId, b.invoiceId],
      actor_name: 'David Miller'
    });

    const executed = await executePaymentRun(db, draft.id, {
      payment_date: '2026-09-14',
      payment_reference: 'ACH-PAY-4419',
      actor_name: 'David Miller'
    });
    assert.equal(executed.status, 'executed');
    assert.equal(executed.payment_reference, 'ACH-PAY-4419');
    assert.equal(executed.payment_date, '2026-09-14');

    for (const invoiceId of [a.invoiceId, b.invoiceId]) {
      const invoice = await db.prepare(`SELECT status, payment_reference FROM invoices WHERE id = ?`).get(invoiceId);
      assert.equal(invoice.status, 'paid');
      assert.equal(invoice.payment_reference, 'ACH-PAY-4419');
      const paidAudit = await db.prepare(`
        SELECT action, details FROM audit_logs
        WHERE entity_type = 'invoice' AND entity_id = ? AND action = 'PAID'
      `).get(invoiceId);
      assert.match(paidAudit.details, /ACH-PAY-4419/);
      const runAudit = await db.prepare(`
        SELECT action FROM audit_logs
        WHERE entity_type = 'invoice' AND entity_id = ? AND action = ?
      `).get(invoiceId, PAYMENT_RUN_AUDIT.EXECUTED);
      assert.equal(runAudit.action, PAYMENT_RUN_AUDIT.EXECUTED);
    }

    await assert.rejects(
      () => executePaymentRun(db, draft.id, {
        payment_date: '2026-09-15',
        payment_reference: 'ACH-AGAIN',
        actor_name: 'David Miller'
      }),
      (err) => err.statusCode === 400 && /already executed/.test(err.message)
    );
  });

  test('execute posts budget actuals once (approve path, not a second engine)', async () => {
    const db = await createTestDb();
    await db.prepare(`
      INSERT INTO purchase_requisitions (id, pr_number, requester_id, department_id, status, total_amount)
      VALUES (9, 'PR-2026-009', 8, 4, 'converted_to_po', 11600)
    `).run();
    const created = await createMatchedApproved(db, {
      invoiceNumber: 'INV-WED-3308',
      poId: 9,
      itemId: 9,
      poNumber: 'PO-2026-009',
      qty: 2,
      unitPriceCents: 5800,
      supplierId: 3,
      description: 'Copy Paper',
      category: 'Office Supplies',
      requisitionId: 9
    });
    const afterApprove = await db.prepare(
      `SELECT actual_spent, committed_amount FROM budgets WHERE department_id = 4 AND fiscal_year = 2026`
    ).get();
    assert.equal(afterApprove.actual_spent, 11600);

    const run = await createPaymentRun(db, {
      invoice_ids: [created.invoiceId],
      actor_name: 'David Miller'
    });
    await executePaymentRun(db, run.id, {
      payment_date: '2026-09-14',
      payment_reference: 'ACH-HR-3308',
      actor_name: 'David Miller'
    });
    const afterPay = await db.prepare(
      `SELECT actual_spent, committed_amount FROM budgets WHERE department_id = 4 AND fiscal_year = 2026`
    ).get();
    assert.equal(afterPay.actual_spent, 11600);
    assert.equal(afterPay.committed_amount, afterApprove.committed_amount);
  });

  test('cancel draft frees invoices; refuse cancel after execute', async () => {
    const db = await createTestDb();
    const a = await createMatchedApproved(db, {
      invoiceNumber: 'INV-WED-4419', poId: 13, itemId: 13, poNumber: 'PO-PAY-013',
      unitPriceCents: 7200, supplierId: 3
    });
    const draft = await createPaymentRun(db, {
      invoice_ids: [a.invoiceId],
      actor_name: 'David Miller'
    });
    const cancelled = await cancelPaymentRun(db, draft.id, {
      actor_name: 'Elena Rostova',
      reason: 'Need a different mix'
    });
    assert.equal(cancelled.status, 'cancelled');
    const eligible = await listEligiblePaymentRunInvoices(db);
    assert.equal(eligible.length, 1);
    assert.equal(eligible[0].invoice_number, 'INV-WED-4419');

    const again = await createPaymentRun(db, {
      invoice_ids: [a.invoiceId],
      actor_name: 'David Miller'
    });
    await executePaymentRun(db, again.id, {
      payment_date: '2026-09-14',
      payment_reference: 'ACH-1',
      actor_name: 'David Miller'
    });
    await assert.rejects(
      () => cancelPaymentRun(db, again.id, { actor_name: 'David Miller' }),
      (err) => err.statusCode === 400 && /already executed/.test(err.message)
    );
  });

  test('execute refuses if any invoice left the approved state (transactional)', async () => {
    const db = await createTestDb();
    const a = await createMatchedApproved(db, {
      invoiceNumber: 'INV-WED-4419', poId: 13, itemId: 13, poNumber: 'PO-PAY-013',
      unitPriceCents: 7200, supplierId: 3
    });
    const b = await createMatchedApproved(db, {
      invoiceNumber: 'INV-FCJ-9920', poId: 14, itemId: 14, poNumber: 'PO-PAY-014',
      unitPriceCents: 14500, supplierId: 4, description: 'Sanitizer', category: 'Facilities & MRO'
    });
    const run = await createPaymentRun(db, {
      invoice_ids: [a.invoiceId, b.invoiceId],
      actor_name: 'David Miller'
    });
    await markInvoicePaid(db, a.invoiceId, {
      payment_reference: 'ACH-SINGLE',
      actor_name: 'David Miller'
    });

    await assert.rejects(
      () => executePaymentRun(db, run.id, {
        payment_date: '2026-09-14',
        payment_reference: 'ACH-BATCH',
        actor_name: 'David Miller'
      }),
      (err) => err.statusCode === 400 && /no longer approved/.test(err.message)
    );

    const still = await db.prepare(`SELECT status, payment_reference FROM invoices WHERE id = ?`).get(b.invoiceId);
    assert.equal(still.status, 'approved_for_payment');
    assert.equal(still.payment_reference, null);
    const header = await getPaymentRunDetail(db, run.id);
    assert.equal(header.status, 'draft');
  });

  test('execute requires a UTC payment date and ACH reference', async () => {
    const db = await createTestDb();
    const a = await createMatchedApproved(db, {
      invoiceNumber: 'INV-WED-4419', poId: 13, itemId: 13, poNumber: 'PO-PAY-013',
      unitPriceCents: 7200, supplierId: 3
    });
    const run = await createPaymentRun(db, {
      invoice_ids: [a.invoiceId],
      actor_name: 'David Miller'
    });
    await assert.rejects(
      () => executePaymentRun(db, run.id, {
        payment_date: '09/14/2026',
        payment_reference: 'ACH-1',
        actor_name: 'David Miller'
      }),
      (err) => err.statusCode === 400 && /YYYY-MM-DD/.test(err.message)
    );
    await assert.rejects(
      () => executePaymentRun(db, run.id, {
        payment_date: '2026-09-14',
        payment_reference: '  ',
        actor_name: 'David Miller'
      }),
      (err) => err.statusCode === 400 && /payment_reference/.test(err.message)
    );
  });
});

describe('payment run document trail honesty', () => {
  test('surfaces PAYMENT_RUN_EXECUTED only when the invoice audit row exists', async () => {
    const db = await createTestDb();
    const created = await createMatchedApproved(db, {
      invoiceNumber: 'INV-WED-4419', poId: 13, itemId: 13, poNumber: 'PO-PAY-013',
      unitPriceCents: 7200, supplierId: 3
    });
    const before = await getDocumentTrail(db, { q: 'INV-WED-4419' });
    const invoiceBefore = before.purchase_orders[0].invoices[0];
    assert.equal((invoiceBefore.payment_run_events || []).length, 0);
    assert.ok(!before.timeline.some((event) => event.kind === 'payment_run'));

    const run = await createPaymentRun(db, {
      invoice_ids: [created.invoiceId],
      actor_name: 'David Miller'
    });
    const afterCreate = await getDocumentTrail(db, { q: 'INV-WED-4419' });
    assert.ok(!afterCreate.timeline.some((event) => event.kind === 'payment_run'));

    await executePaymentRun(db, run.id, {
      payment_date: '2026-09-14',
      payment_reference: 'ACH-PAY-4419',
      actor_name: 'David Miller'
    });
    const after = await getDocumentTrail(db, { q: 'INV-WED-4419' });
    const invoice = after.purchase_orders[0].invoices[0];
    assert.equal(invoice.payment_run_events.length, 1);
    assert.equal(invoice.payment_run_events[0].action, PAYMENT_RUN_AUDIT.EXECUTED);
    const event = after.timeline.find((row) => row.kind === 'payment_run');
    assert.ok(event);
    assert.equal(event.title, 'Payment run executed');
    assert.equal(event.tab, 'payment_runs');
    assert.match(event.details, /PAY-/);
    assert.match(event.details, /ACH-PAY-4419/);
    assert.ok(after.timeline.some((row) => row.kind === 'ap_event' && row.title === 'Marked paid'));
  });
});

describe('GET /api/payment-runs', () => {
  test('lists, creates, executes, and cancels over HTTP', async () => {
    const db = await createTestDb();
    const a = await createMatchedApproved(db, {
      invoiceNumber: 'INV-WED-4419', poId: 13, itemId: 13, poNumber: 'PO-PAY-013',
      unitPriceCents: 7200, supplierId: 3
    });
    const b = await createMatchedApproved(db, {
      invoiceNumber: 'INV-FCJ-9920', poId: 14, itemId: 14, poNumber: 'PO-PAY-014',
      unitPriceCents: 14500, supplierId: 4, description: 'Sanitizer', category: 'Facilities & MRO'
    });
    const extra = await createMatchedApproved(db, {
      invoiceNumber: 'INV-TSG-5508', poId: 10, itemId: 10, poNumber: 'PO-2026-010',
      unitPriceCents: 39900, supplierId: 1, description: 'Dock', category: 'IT Hardware'
    });
    const app = createApp({ db, config: loadDbConfig({}) });

    await withServer(app, async (base) => {
      const eligible = await json(await fetch(`${base}/api/payment-runs/eligible-invoices`));
      assert.equal(eligible.status, 200);
      assert.equal(eligible.body.length, 3);

      const empty = await json(await fetch(`${base}/api/payment-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_ids: [], actor_name: 'David Miller' })
      }));
      assert.equal(empty.status, 400);

      const created = await json(await fetch(`${base}/api/payment-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invoice_ids: [a.invoiceId, b.invoiceId],
          actor_name: 'David Miller'
        })
      }));
      assert.equal(created.status, 201);
      assert.equal(created.body.status, 'draft');
      assert.equal(created.body.items.length, 2);

      const listed = await json(await fetch(`${base}/api/payment-runs`));
      assert.equal(listed.status, 200);
      assert.equal(listed.body.length, 1);

      const detail = await json(await fetch(`${base}/api/payment-runs/${created.body.id}`));
      assert.equal(detail.status, 200);
      assert.equal(detail.body.run_number, created.body.run_number);

      const executed = await json(await fetch(`${base}/api/payment-runs/${created.body.id}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payment_date: '2026-09-14',
          payment_reference: 'ACH-HTTP-1',
          actor_name: 'David Miller'
        })
      }));
      assert.equal(executed.status, 200);
      assert.equal(executed.body.status, 'executed');

      const reexec = await json(await fetch(`${base}/api/payment-runs/${created.body.id}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payment_date: '2026-09-14',
          payment_reference: 'ACH-HTTP-2',
          actor_name: 'David Miller'
        })
      }));
      assert.equal(reexec.status, 400);

      const cancelDraft = await json(await fetch(`${base}/api/payment-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invoice_ids: [extra.invoiceId],
          actor_name: 'David Miller'
        })
      }));
      assert.equal(cancelDraft.status, 201);
      const cancelled = await json(await fetch(`${base}/api/payment-runs/${cancelDraft.body.id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor_name: 'Elena Rostova', reason: 'Hold' })
      }));
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.body.status, 'cancelled');

      const missing = await json(await fetch(`${base}/api/payment-runs/999`));
      assert.equal(missing.status, 404);
    });
  });
});

describe('payment run numbering', () => {
  test('PAY MAX-suffix skips gaps independently of PR', async () => {
    const db = await createTestDb();
    await db.prepare(`
      INSERT INTO payment_runs (run_number, status, actor_name, billed_total_cents, payable_total_cents, invoice_count)
      VALUES ('PAY-2026-001', 'cancelled', 'David Miller', 0, 0, 0),
             ('PAY-2026-003', 'cancelled', 'David Miller', 0, 0, 0)
    `).run();
    assert.equal(await nextDocumentNumber(db, 'pay', 2026), 'PAY-2026-004');
    assert.equal(await nextDocumentNumber(db, 'pr', 2026), 'PR-2026-001');
  });
});
