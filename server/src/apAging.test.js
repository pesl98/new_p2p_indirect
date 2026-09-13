import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMemoryDatabase } from './db.js';
import { createApp } from './app.js';
import { loadDbConfig } from './dbConfig.js';
import { createVendorInvoice, approveInvoicePayment, markInvoicePaid } from './invoicesService.js';
import { resolveInvoiceException } from './invoiceExceptionsService.js';
import {
  DEFAULT_DUE_SOON_DAYS,
  agingDayCounts,
  calendarDaysUtc,
  classifyAgingBucket,
  parseAgingBucket,
  parseDueSoonDays,
  utcTodayYmd
} from './apAging.js';
import { listApAging } from './apAgingService.js';

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
      VALUES (1, 2026, 50000000, 0, 0), (4, 2026, 6000000, 0, 0);
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
  dueDate,
  invoiceNumber,
  poId,
  itemId,
  poNumber,
  qty = 1,
  unitPriceCents = 21000,
  supplierId = 4,
  description = 'First Aid Station',
  category = 'Facilities & MRO',
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

describe('AP aging classification', () => {
  test('UTC calendar buckets: overdue, due today, due soon inclusive, later', () => {
    const today = '2026-09-12';
    assert.equal(classifyAgingBucket('2026-09-11', { today }), 'overdue');
    assert.equal(classifyAgingBucket('2026-09-12', { today }), 'due_soon');
    assert.equal(classifyAgingBucket('2026-09-19', { today }), 'due_soon');
    assert.equal(classifyAgingBucket('2026-09-20', { today }), 'later');
    assert.equal(classifyAgingBucket('2026-08-01T15:45:00.000Z', { today }), 'overdue');
    assert.equal(classifyAgingBucket(null, { today }), null);
    assert.equal(DEFAULT_DUE_SOON_DAYS, 7);
  });

  test('custom due-soon window and day counts', () => {
    const today = '2026-09-12';
    assert.equal(classifyAgingBucket('2026-09-15', { today, days: 2 }), 'later');
    assert.equal(classifyAgingBucket('2026-09-14', { today, days: 2 }), 'due_soon');
    assert.deepEqual(agingDayCounts('2026-09-05', { today }), { days_past_due: 7, days_until_due: 0 });
    assert.deepEqual(agingDayCounts('2026-09-15', { today }), { days_past_due: 0, days_until_due: 3 });
    assert.equal(calendarDaysUtc('2026-09-12', '2026-09-12'), 0);
    assert.equal(utcTodayYmd(new Date('2026-09-12T22:15:00.000Z')), '2026-09-12');
  });

  test('query param parsers reject invalid bucket/days', () => {
    assert.equal(parseAgingBucket(undefined), 'all');
    assert.equal(parseAgingBucket('overdue'), 'overdue');
    assert.throws(() => parseAgingBucket('yesterday'), /bucket must be/);
    assert.equal(parseDueSoonDays(undefined), 7);
    assert.equal(parseDueSoonDays('0'), 0);
    assert.throws(() => parseDueSoonDays('-1'), /integer/);
    assert.throws(() => parseDueSoonDays('7.5'), /integer/);
    assert.throws(() => parseDueSoonDays('soon'), /integer/);
  });
});

describe('AP aging queue', () => {
  test('lists approved_for_payment rows with buckets, payable cents, and requester', async () => {
    const db = await createTestDb();
    await db.prepare(`
      INSERT INTO purchase_requisitions (id, pr_number, requester_id, department_id, status, total_amount)
      VALUES (9, 'PR-2026-009', 8, 4, 'converted_to_po', 11600)
    `).run();

    await createMatchedApproved(db, {
      dueDate: '2026-08-31',
      invoiceNumber: 'INV-FCJ-8810',
      poId: 8,
      itemId: 8,
      poNumber: 'PO-2026-008',
      unitPriceCents: 21000,
      supplierId: 4
    });
    await db.prepare(`UPDATE invoices SET payable_total_cents = 19900 WHERE invoice_number = 'INV-FCJ-8810'`).run();

    await createMatchedApproved(db, {
      dueDate: '2026-09-15',
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

    await createMatchedApproved(db, {
      dueDate: '2026-10-03',
      invoiceNumber: 'INV-TSG-5508',
      poId: 10,
      itemId: 10,
      poNumber: 'PO-2026-010',
      unitPriceCents: 39900,
      supplierId: 1,
      description: 'CalDigit Dock',
      category: 'IT Hardware'
    });

    const all = await listApAging(db, { today: '2026-09-12', days: 7 });
    assert.equal(all.date_basis, 'utc_calendar_date');
    assert.equal(all.as_of, '2026-09-12');
    assert.equal(all.days, 7);
    assert.equal(all.bucket, 'all');
    assert.equal(all.counts.overdue, 1);
    assert.equal(all.counts.due_soon, 1);
    assert.equal(all.counts.later, 1);
    assert.equal(all.counts.open_payable, 3);
    assert.equal(all.invoices.length, 3);
    assert.deepEqual(all.invoices.map((row) => row.invoice_number), [
      'INV-FCJ-8810',
      'INV-WED-3308',
      'INV-TSG-5508'
    ]);

    const overdue = all.invoices[0];
    assert.equal(overdue.aging_bucket, 'overdue');
    assert.equal(overdue.days_past_due, 12);
    assert.equal(overdue.total_amount, 21000);
    assert.equal(overdue.payable_total_cents, 19900);
    assert.equal(overdue.effective_payable_cents, 19900);
    assert.equal(overdue.has_short_pay, true);
    assert.equal(overdue.billed_total_cents, 21000);

    const dueSoon = all.invoices[1];
    assert.equal(dueSoon.aging_bucket, 'due_soon');
    assert.equal(dueSoon.days_until_due, 3);
    assert.equal(dueSoon.payable_total_cents, null);
    assert.equal(dueSoon.effective_payable_cents, 11600);
    assert.equal(dueSoon.has_short_pay, false);
    assert.equal(dueSoon.requester_name, 'Sofia Berg');
    assert.equal(dueSoon.pr_number, 'PR-2026-009');

    const later = all.invoices[2];
    assert.equal(later.aging_bucket, 'later');
    assert.equal(later.days_until_due, 21);

    const overdueOnly = await listApAging(db, { bucket: 'overdue', today: '2026-09-12' });
    assert.equal(overdueOnly.invoices.length, 1);
    assert.equal(overdueOnly.invoices[0].invoice_number, 'INV-FCJ-8810');
  });

  test('empty buckets return no rows; matched/paid stay off the default pay queue', async () => {
    const db = await createTestDb();
    await insertPoLine(db, {
      ordered: 2, received: 2, unitPriceCents: 129500, poId: 1, itemId: 1, poNumber: 'PO-A', supplierId: 3
    });
    const paid = await createVendorInvoice(db, invoicePayload({
      qty: 2, unitPriceCents: 129500, invoiceNumber: 'INV-WED-9042', poId: 1, itemId: 1, dueDate: '2026-10-17', supplierId: 3
    }));
    await approveInvoicePayment(db, paid.invoiceId, { approver_name: 'David Miller' });
    await markInvoicePaid(db, paid.invoiceId, { payment_reference: 'ACH-1017-WED9042', payer_name: 'David Miller' });

    await insertPoLine(db, {
      ordered: 1, received: 1, unitPriceCents: 1250000, poId: 3, itemId: 3, poNumber: 'PO-B', supplierId: 1,
      lineType: 'service', accepted: 1, category: 'Consulting & Professional Services', description: 'SOC 2'
    });
    await createVendorInvoice(db, invoicePayload({
      qty: 1, unitPriceCents: 1250000, invoiceNumber: 'INV-AAD-5501', poId: 3, itemId: 3, dueDate: '2026-11-21', supplierId: 1
    }));

    await insertPoLine(db, {
      ordered: 4, received: 2, unitPriceCents: 74900, poId: 2, itemId: 2, poNumber: 'PO-C', supplierId: 1
    });
    await createVendorInvoice(db, invoicePayload({
      qty: 4, unitPriceCents: 79900, invoiceNumber: 'INV-TSG-11029', poId: 2, itemId: 2, dueDate: '2026-10-03', supplierId: 1
    }));

    const open = await listApAging(db, { today: '2026-09-12' });
    assert.equal(open.counts.open_payable, 0);
    assert.equal(open.invoices.length, 0);
    assert.equal(open.counts.overdue, 0);
    assert.equal(open.counts.due_soon, 0);
    assert.equal(open.counts.later, 0);
    assert.ok(open.ready_to_approve.some((row) => row.invoice_number === 'INV-AAD-5501'));
    assert.ok(!open.invoices.some((row) => row.invoice_number === 'INV-WED-9042'));
    assert.ok(!open.invoices.some((row) => row.invoice_number === 'INV-TSG-11029'));
    assert.ok(!open.ready_to_approve.some((row) => row.invoice_number === 'INV-TSG-11029'));

    const paidQueue = await listApAging(db, { bucket: 'paid', today: '2026-09-12' });
    assert.equal(paidQueue.invoices.length, 1);
    assert.equal(paidQueue.invoices[0].invoice_number, 'INV-WED-9042');
    assert.equal(paidQueue.invoices[0].aging_bucket, 'later');
    assert.equal(paidQueue.counts.paid, 1);

    const ready = await listApAging(db, { bucket: 'ready_to_approve', today: '2026-09-12' });
    assert.equal(ready.invoices[0].invoice_number, 'INV-AAD-5501');
    assert.equal(ready.invoices[0].status, 'matched');
  });

  test('seed-demo numbers stay out of the open payable queue until approved', async () => {
    const db = await createTestDb();
    await insertPoLine(db, {
      ordered: 3, received: 2, unitPriceCents: 9900, poId: 6, itemId: 6, poNumber: 'PO-2026-006', supplierId: 1
    });
    await createVendorInvoice(db, invoicePayload({
      qty: 3, unitPriceCents: 9900, invoiceNumber: 'INV-TSG-22041', poId: 6, itemId: 6, dueDate: '2026-10-07', supplierId: 1
    }));

    const queue = await listApAging(db, { today: '2026-09-12' });
    const numbers = [
      ...queue.invoices.map((row) => row.invoice_number),
      ...queue.ready_to_approve.map((row) => row.invoice_number)
    ];
    assert.ok(!numbers.includes('INV-TSG-22041'));
    assert.ok(!numbers.includes('INV-TSG-11029'));
    assert.equal(queue.counts.open_payable, 0);
  });

  test('fail-closed mark-paid is unchanged (must be approved_for_payment)', async () => {
    const db = await createTestDb();
    await insertPoLine(db, {
      ordered: 2, received: 2, unitPriceCents: 14500, poId: 5, itemId: 5, poNumber: 'PO-FCJ', supplierId: 4
    });
    const matched = await createVendorInvoice(db, invoicePayload({
      qty: 2, unitPriceCents: 14500, invoiceNumber: 'INV-MATCHED', poId: 5, itemId: 5, supplierId: 4
    }));

    await assert.rejects(
      () => markInvoicePaid(db, matched.invoiceId, { payment_reference: 'ACH-1', actor_name: 'David Miller' }),
      (err) => err.statusCode === 400 && /approved for payment/.test(err.message)
    );

    await insertPoLine(db, {
      ordered: 4, received: 2, unitPriceCents: 74900, poId: 2, itemId: 2, poNumber: 'PO-HARD', supplierId: 1
    });
    const flagged = await createVendorInvoice(db, invoicePayload({
      qty: 4, unitPriceCents: 79900, invoiceNumber: 'INV-HARD', poId: 2, itemId: 2, supplierId: 1
    }));
    await assert.rejects(
      () => markInvoicePaid(db, flagged.invoiceId, { payment_reference: 'ACH-2', payer_name: 'David Miller' }),
      (err) => err.statusCode === 400 && /exception|approved for payment/.test(err.message)
    );

    await resolveInvoiceException(db, flagged.invoiceId, {
      disposition: 'reject_invoice',
      reason: 'Do not pay.',
      actor_name: 'David Miller'
    });
    await assert.rejects(
      () => markInvoicePaid(db, flagged.invoiceId, { payment_reference: 'ACH-3' }),
      (err) => err.statusCode === 400 && /rejected/.test(err.message)
    );
  });

  test('mark-paid from the aging path writes the same PAID audit action', async () => {
    const db = await createTestDb();
    const created = await createMatchedApproved(db, {
      dueDate: '2026-08-20',
      invoiceNumber: 'INV-AGE-PAY',
      poId: 11,
      itemId: 11,
      poNumber: 'PO-AGE-011',
      unitPriceCents: 21000,
      supplierId: 4
    });

    const paid = await markInvoicePaid(db, created.invoiceId, {
      payment_reference: 'ACH-AGING-1',
      actor_name: 'David Miller'
    });
    assert.equal(paid.payment_reference, 'ACH-AGING-1');
    const invoice = await db.prepare(`SELECT status FROM invoices WHERE id = ?`).get(created.invoiceId);
    assert.equal(invoice.status, 'paid');
    const audit = await db.prepare(`
      SELECT action, actor_name, details FROM audit_logs
      WHERE entity_type = 'invoice' AND entity_id = ? AND action = 'PAID'
    `).get(created.invoiceId);
    assert.equal(audit.action, 'PAID');
    assert.equal(audit.actor_name, 'David Miller');
    assert.match(audit.details, /ACH-AGING-1/);

    const after = await listApAging(db, { today: '2026-09-12' });
    assert.equal(after.counts.open_payable, 0);
    assert.equal(after.counts.paid, 1);
  });
});

describe('GET /api/ap-aging', () => {
  test('returns buckets and rejects invalid query params', async () => {
    const db = await createTestDb();
    await createMatchedApproved(db, {
      dueDate: '2026-08-01',
      invoiceNumber: 'INV-HTTP-1',
      poId: 20,
      itemId: 20,
      poNumber: 'PO-HTTP-20',
      unitPriceCents: 21000,
      supplierId: 4
    });
    const app = createApp({ db, config: loadDbConfig({}) });

    await withServer(app, async (base) => {
      const listed = await json(await fetch(`${base}/api/ap-aging?today=2026-09-12`));
      assert.equal(listed.status, 200);
      assert.equal(listed.body.counts.overdue, 1);
      assert.equal(listed.body.invoices[0].invoice_number, 'INV-HTTP-1');

      const alias = await json(await fetch(`${base}/api/payment-queue?bucket=overdue&today=2026-09-12`));
      assert.equal(alias.status, 200);
      assert.equal(alias.body.invoices.length, 1);

      const empty = await json(await fetch(`${base}/api/ap-aging?bucket=due_soon&today=2026-09-12`));
      assert.equal(empty.status, 200);
      assert.equal(empty.body.invoices.length, 0);

      const badBucket = await json(await fetch(`${base}/api/ap-aging?bucket=yesterday`));
      assert.equal(badBucket.status, 400);

      const badDays = await json(await fetch(`${base}/api/ap-aging?days=-3`));
      assert.equal(badDays.status, 400);

      const skipApprove = await json(await fetch(`${base}/api/invoices/${listed.body.invoices[0].id}/mark-paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payment_reference: 'ACH-X', actor_name: 'David Miller' })
      }));
      assert.equal(skipApprove.status, 200);
      assert.match(skipApprove.body.message, /marked as paid/i);
    });
  });
});
