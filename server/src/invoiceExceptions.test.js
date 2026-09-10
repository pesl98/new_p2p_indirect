import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from './db.js';
import { createVendorInvoice, approveInvoicePayment, markInvoicePaid } from './invoicesService.js';
import { priceToleranceCents } from './match.js';
import {
  listInvoiceExceptions,
  listBuyerInbox,
  getInvoiceExceptionDetail,
  resolveInvoiceException,
  respondBuyerInbox,
  attachExceptionToInvoice,
  BUYER_RESPONSE_DISPOSITION,
  BUYER_RESPONSE_AUDIT
} from './invoiceExceptionsService.js';

async function createTestDb() {
  const db = await createMemoryDatabase();
  await db.exec(`
    INSERT INTO departments (id, code, name) VALUES (1, 'MKT', 'Marketing'), (2, 'ITE', 'IT');
    INSERT INTO users (id, name, email, role, department_id, approval_limit) VALUES
      (1, 'David Miller', 'david@example.com', 'finance', 1, 15000000),
      (2, 'Alice Chen', 'alice@example.com', 'requester', 1, 0),
      (3, 'Priya Nair', 'priya@example.com', 'requester', 2, 0);
    INSERT INTO suppliers (id, name, code) VALUES (1, 'Vendor Co', 'SUP-1');
    INSERT INTO budgets (department_id, fiscal_year, total_budget, committed_amount, actual_spent)
      VALUES (1, 2026, 50000000, 0, 0), (2, 2026, 32000000, 0, 0);
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
  poNumber = 'PO-TEST-001'
}) {
  const existingPo = await db.prepare(`SELECT id FROM purchase_orders WHERE id = ?`).get(poId);
  if (!existingPo) {
    await db.prepare(`
      INSERT INTO purchase_orders (id, po_number, supplier_id, created_by, status, total_amount, issue_date)
      VALUES (?, ?, 1, 1, 'partially_received', ?, '2026-09-01')
    `).run(poId, poNumber, ordered * unitPriceCents);
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
  description = 'Test Monitor'
}) {
  return {
    invoice_number: invoiceNumber,
    po_id: poId,
    supplier_id: 1,
    invoice_date: '2026-09-04',
    due_date: '2026-10-04',
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

async function createFlaggedInvoice(db, {
  qty = 4,
  received = 2,
  ordered = 4,
  poPrice = 74900,
  billedPrice = 79900,
  invoiceNumber = 'INV-EX-1',
  poId = 1,
  itemId = 1,
  poNumber = 'PO-EX-001'
} = {}) {
  await insertPoLine(db, {
    ordered,
    received,
    unitPriceCents: poPrice,
    poId,
    itemId,
    poNumber
  });
  return await createVendorInvoice(db, invoicePayload({
    qty,
    unitPriceCents: billedPrice,
    invoiceNumber,
    poId,
    itemId
  }));
}

describe('invoice exception queue', () => {
  test('open queue includes variance_flagged and excludes perfect / tolerated / paid', async () => {
    const db = await createTestDb();

    await insertPoLine(db, {
      ordered: 2, received: 2, unitPriceCents: 129500, poId: 1, itemId: 1, poNumber: 'PO-A'
    });
    const perfect = await createVendorInvoice(db, invoicePayload({
      qty: 2, unitPriceCents: 129500, invoiceNumber: 'INV-PERFECT', poId: 1, itemId: 1
    }));

    const poPrice = 74900;
    const tolerance = priceToleranceCents(poPrice);
    await insertPoLine(db, {
      ordered: 2, received: 2, unitPriceCents: poPrice, poId: 2, itemId: 2, poNumber: 'PO-B'
    });
    const tolerated = await createVendorInvoice(db, invoicePayload({
      qty: 2, unitPriceCents: poPrice + tolerance, invoiceNumber: 'INV-TOL', poId: 2, itemId: 2
    }));

    const flagged = await createFlaggedInvoice(db, {
      invoiceNumber: 'INV-HARD', poId: 3, itemId: 3, poNumber: 'PO-C'
    });

    const open = await listInvoiceExceptions(db, { queue: 'open' });
    const openIds = open.map((row) => row.id);
    assert.ok(openIds.includes(flagged.invoiceId));
    assert.ok(!openIds.includes(perfect.invoiceId));
    assert.ok(!openIds.includes(tolerated.invoiceId));
    assert.equal(open[0].queue_state, 'open');
    assert.equal(open[0].needs_disposition, true);

    const toleratedRow = await db.prepare(`SELECT status, match_status FROM invoices WHERE id = ?`).get(tolerated.invoiceId);
    assert.equal(toleratedRow.status, 'matched');
    assert.equal(toleratedRow.match_status, 'tolerated_match');
  });

  test('detail payload includes match_results, receipt basis, and empty prior disposition', async () => {
    const db = await createTestDb();
    const created = await createFlaggedInvoice(db);
    const detail = await getInvoiceExceptionDetail(db, created.invoiceId);

    assert.equal(detail.status, 'variance_flagged');
    assert.equal(detail.match_status, 'total_variance');
    assert.equal(detail.match_results.length, 1);
    assert.equal(detail.match_results[0].received_qty, 2);
    assert.equal(detail.match_results[0].invoiced_qty, 4);
    assert.equal(detail.match_results[0].price_variance, 5000);
    assert.equal(detail.items[0].po_quantity_received, 2);
    assert.deepEqual(detail.exception_dispositions, []);
    assert.equal(detail.exception, null);
    assert.ok(Array.isArray(detail.audit_logs));
  });

  test('resolved queue lists terminal dispositions only', async () => {
    const db = await createTestDb();
    const accept = await createFlaggedInvoice(db, {
      invoiceNumber: 'INV-ACC', poId: 1, itemId: 1, poNumber: 'PO-ACC'
    });
    const reject = await createFlaggedInvoice(db, {
      invoiceNumber: 'INV-REJ', poId: 2, itemId: 2, poNumber: 'PO-REJ'
    });
    const parked = await createFlaggedInvoice(db, {
      invoiceNumber: 'INV-RET', poId: 3, itemId: 3, poNumber: 'PO-RET'
    });

    await resolveInvoiceException(db, accept.invoiceId, {
      disposition: 'accept_variance',
      reason: 'Buyer confirmed backorder will arrive; pay billed amount.',
      actor_name: 'David Miller'
    });
    await resolveInvoiceException(db, reject.invoiceId, {
      disposition: 'reject_invoice',
      reason: 'Vendor billed unreceived units. Return invoice.',
      actor_name: 'David Miller'
    });
    await resolveInvoiceException(db, parked.invoiceId, {
      disposition: 'return_to_buyer',
      reason: 'Need receiving to confirm remaining two monitors.',
      actor_name: 'David Miller'
    });

    const resolved = await listInvoiceExceptions(db, { queue: 'resolved' });
    const resolvedIds = resolved.map((row) => row.id);
    assert.ok(resolvedIds.includes(accept.invoiceId));
    assert.ok(resolvedIds.includes(reject.invoiceId));
    assert.ok(!resolvedIds.includes(parked.invoiceId), 'return_to_buyer stays open, not resolved');

    const open = await listInvoiceExceptions(db, { queue: 'open' });
    const openIds = open.map((row) => row.id);
    assert.ok(openIds.includes(parked.invoiceId));
    assert.ok(!openIds.includes(accept.invoiceId));
    assert.ok(!openIds.includes(reject.invoiceId));
  });
});

describe('invoice exception dispositions', () => {
  test('accept_variance records cents, writes audit, and unlocks approve', async () => {
    const db = await createTestDb();
    const created = await createFlaggedInvoice(db, { billedPrice: 79900, qty: 4 });
    const billedCents = 4 * 79900;

    await assert.rejects(
      () => approveInvoicePayment(db, created.invoiceId, { approver_name: 'David Miller' }),
      (err) => err.statusCode === 400 && /Unresolved invoice exception/.test(err.message)
    );

    const resolved = await resolveInvoiceException(db, created.invoiceId, {
      disposition: 'accept_variance',
      reason: 'VP Marketing authorized the $50/unit overage and partial shipment.',
      actor_name: 'David Miller'
    });

    assert.equal(resolved.disposition, 'accept_variance');
    assert.equal(resolved.invoice_status, 'matched');
    assert.equal(resolved.accepted_total_cents, billedCents);
    assert.equal(resolved.accepted_match_status, 'total_variance');

    const invoice = await db.prepare(`SELECT status, match_status, total_amount FROM invoices WHERE id = ?`).get(created.invoiceId);
    assert.equal(invoice.status, 'matched');
    assert.equal(invoice.match_status, 'total_variance');
    assert.equal(invoice.total_amount, billedCents);

    const disposition = await db.prepare(`
      SELECT * FROM invoice_exception_dispositions WHERE invoice_id = ?
    `).get(created.invoiceId);
    assert.equal(disposition.disposition, 'accept_variance');
    assert.equal(disposition.accepted_total_cents, billedCents);
    assert.equal(disposition.actor_name, 'David Miller');
    assert.ok(disposition.reason.includes('VP Marketing'));

    const audit = await db.prepare(`
      SELECT * FROM audit_logs WHERE entity_type = 'invoice' AND entity_id = ? AND action = 'EXCEPTION_ACCEPT_VARIANCE'
    `).get(created.invoiceId);
    assert.ok(audit);
    assert.equal(audit.actor_name, 'David Miller');
    assert.ok(audit.details.includes('$3196.00'));

    const approve = await approveInvoicePayment(db, created.invoiceId, {
      approver_name: 'David Miller'
    });
    assert.match(approve.message, /approved for payment/i);

    const after = await db.prepare(`SELECT status FROM invoices WHERE id = ?`).get(created.invoiceId);
    assert.equal(after.status, 'approved_for_payment');
  });

  test('reject_invoice blocks approve and mark-paid', async () => {
    const db = await createTestDb();
    const created = await createFlaggedInvoice(db);

    await resolveInvoiceException(db, created.invoiceId, {
      disposition: 'reject_invoice',
      reason: 'Quantity and price both fail. Do not pay.',
      actor_name: 'Elena Rostova'
    });

    const invoice = await db.prepare(`SELECT status FROM invoices WHERE id = ?`).get(created.invoiceId);
    assert.equal(invoice.status, 'rejected');

    const audit = await db.prepare(`
      SELECT * FROM audit_logs WHERE entity_id = ? AND action = 'EXCEPTION_REJECT_INVOICE'
    `).get(created.invoiceId);
    assert.ok(audit);
    assert.equal(audit.actor_name, 'Elena Rostova');

    await assert.rejects(
      () => approveInvoicePayment(db, created.invoiceId, { approver_name: 'David Miller' }),
      (err) => err.statusCode === 400 && /rejected/.test(err.message)
    );
    await assert.rejects(
      () => markInvoicePaid(db, created.invoiceId, { payer_name: 'David Miller' }),
      (err) => err.statusCode === 400 && /rejected/.test(err.message)
    );
  });

  test('return_to_buyer stays blocked and can later be accepted', async () => {
    const db = await createTestDb();
    const created = await createFlaggedInvoice(db);

    await resolveInvoiceException(db, created.invoiceId, {
      disposition: 'return_to_buyer',
      reason: 'Ask Alice whether the remaining monitors were received off-system.',
      actor_name: 'David Miller'
    });

    const parked = await db.prepare(`SELECT status FROM invoices WHERE id = ?`).get(created.invoiceId);
    assert.equal(parked.status, 'variance_flagged');

    await assert.rejects(
      () => approveInvoicePayment(db, created.invoiceId, { approver_name: 'David Miller' }),
      (err) => err.statusCode === 400 && /Unresolved invoice exception/.test(err.message)
    );

    const accepted = await resolveInvoiceException(db, created.invoiceId, {
      disposition: 'accept_variance',
      reason: 'Buyer confirmed remaining units; accept billed cents.',
      actor_name: 'David Miller'
    });
    assert.equal(accepted.invoice_status, 'matched');
    assert.equal(accepted.accepted_total_cents, 4 * 79900);

    const history = await db.prepare(`
      SELECT disposition FROM invoice_exception_dispositions WHERE invoice_id = ? ORDER BY id
    `).all(created.invoiceId);
    assert.deepEqual(history.map((row) => row.disposition), ['return_to_buyer', 'accept_variance']);
  });

  test('unresolved hard exception cannot be marked paid even if someone skips approve', async () => {
    const db = await createTestDb();
    const created = await createFlaggedInvoice(db);

    await assert.rejects(
      () => markInvoicePaid(db, created.invoiceId, { payer_name: 'David Miller' }),
      (err) => err.statusCode === 400 && /Unresolved invoice exception/.test(err.message)
    );
  });

  test('matched invoice still cannot be marked paid before approve', async () => {
    const db = await createTestDb();
    await insertPoLine(db, { ordered: 1, received: 1, unitPriceCents: 10000 });
    const created = await createVendorInvoice(db, invoicePayload({
      qty: 1, unitPriceCents: 10000, invoiceNumber: 'INV-OK'
    }));

    await assert.rejects(
      () => markInvoicePaid(db, created.invoiceId, { payer_name: 'David Miller' }),
      (err) => err.statusCode === 400 && /approved for payment/.test(err.message)
    );
  });

  test('reason and actor_name are required; perfect match cannot be resolved', async () => {
    const db = await createTestDb();
    await insertPoLine(db, { ordered: 1, received: 1, unitPriceCents: 5000 });
    const perfect = await createVendorInvoice(db, invoicePayload({
      qty: 1, unitPriceCents: 5000, invoiceNumber: 'INV-P'
    }));

    const flagged = await createFlaggedInvoice(db, {
      invoiceNumber: 'INV-F', poId: 2, itemId: 2, poNumber: 'PO-F'
    });

    await assert.rejects(
      () => resolveInvoiceException(db, flagged.invoiceId, {
        disposition: 'accept_variance', actor_name: 'David Miller'
      }),
      (err) => err.statusCode === 400 && /reason is required/.test(err.message)
    );
    await assert.rejects(
      () => resolveInvoiceException(db, flagged.invoiceId, {
        disposition: 'accept_variance', reason: '   ', actor_name: 'David Miller'
      }),
      (err) => err.statusCode === 400 && /reason is required/.test(err.message)
    );
    await assert.rejects(
      () => resolveInvoiceException(db, flagged.invoiceId, {
        disposition: 'accept_variance', reason: 'ok'
      }),
      (err) => err.statusCode === 400 && /actor_name is required/.test(err.message)
    );
    await assert.rejects(
      () => resolveInvoiceException(db, perfect.invoiceId, {
        disposition: 'accept_variance',
        reason: 'should not work',
        actor_name: 'David Miller'
      }),
      (err) => err.statusCode === 400 && /variance-flagged/.test(err.message)
    );
  });

  test('cannot accept after reject; attachExceptionToInvoice exposes history', async () => {
    const db = await createTestDb();
    const created = await createFlaggedInvoice(db);
    await resolveInvoiceException(db, created.invoiceId, {
      disposition: 'reject_invoice',
      reason: 'Do not pay this invoice.',
      actor_name: 'David Miller'
    });

    await assert.rejects(
      () => resolveInvoiceException(db, created.invoiceId, {
        disposition: 'accept_variance',
        reason: 'changed my mind',
        actor_name: 'David Miller'
      }),
      (err) => err.statusCode === 400 && /already rejected/.test(err.message)
    );

    const invoice = await db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(created.invoiceId);
    const attached = await attachExceptionToInvoice(db, invoice);
    assert.equal(attached.exception.disposition, 'reject_invoice');
    assert.equal(attached.exception_dispositions.length, 1);
    assert.equal(attached.needs_disposition, false);
    assert.equal(attached.exception.accepted_total_cents, 4 * 79900);
  });
});

async function createFlaggedInvoiceOnBudget(db, {
  qty = 4,
  received = 2,
  ordered = 4,
  poPrice = 74900,
  billedPrice = 79900,
  invoiceNumber = 'INV-SP-1',
  committed = 299600
} = {}) {
  await db.prepare(`
    INSERT INTO purchase_requisitions (pr_number, requester_id, department_id, status, total_amount)
    VALUES (?, 1, 1, 'converted_to_po', ?)
  `).run(`PR-${invoiceNumber}`, ordered * poPrice);
  const pr = await db.prepare(`SELECT id FROM purchase_requisitions WHERE pr_number = ?`).get(`PR-${invoiceNumber}`);
  await db.prepare(`
    INSERT INTO purchase_orders (po_number, requisition_id, supplier_id, created_by, status, total_amount, issue_date)
    VALUES (?, ?, 1, 1, 'partially_received', ?, '2026-09-01')
  `).run(`PO-${invoiceNumber}`, pr.id, ordered * poPrice);
  const po = await db.prepare(`SELECT id FROM purchase_orders WHERE po_number = ?`).get(`PO-${invoiceNumber}`);
  await db.prepare(`
    INSERT INTO po_items (po_id, item_description, category, quantity, unit_price, total_price, quantity_received, quantity_accepted, quantity_invoiced, line_type)
    VALUES (?, 'Test Monitor', 'IT Hardware', ?, ?, ?, ?, 0, 0, 'goods')
  `).run(po.id, ordered, poPrice, ordered * poPrice, received);
  const item = await db.prepare(`SELECT id FROM po_items WHERE po_id = ?`).get(po.id);
  await db.prepare(`
    UPDATE budgets SET committed_amount = ? WHERE department_id = 1 AND fiscal_year = 2026
  `).run(committed);
  return await createVendorInvoice(db, invoicePayload({
    qty,
    unitPriceCents: billedPrice,
    invoiceNumber,
    poId: po.id,
    itemId: item.id
  }));
}

describe('invoice exception short_pay', () => {
  test('short_pay rejects payable >= billed, negative, float, missing reason, and non-flagged invoices', async () => {
    const db = await createTestDb();
    const flagged = await createFlaggedInvoice(db, {
      invoiceNumber: 'INV-SP-VAL', poId: 1, itemId: 1, poNumber: 'PO-SP-VAL'
    });
    const billedCents = 4 * 79900;

    await insertPoLine(db, { ordered: 1, received: 1, unitPriceCents: 5000, poId: 2, itemId: 2, poNumber: 'PO-OK' });
    const perfect = await createVendorInvoice(db, invoicePayload({
      qty: 1, unitPriceCents: 5000, invoiceNumber: 'INV-OK-SP', poId: 2, itemId: 2
    }));

    await assert.rejects(
      () => resolveInvoiceException(db, flagged.invoiceId, {
        disposition: 'short_pay',
        reason: 'Pay billed',
        actor_name: 'David Miller',
        payable_total_cents: billedCents
      }),
      (err) => err.statusCode === 400 && /accept_variance/.test(err.message)
    );
    await assert.rejects(
      () => resolveInvoiceException(db, flagged.invoiceId, {
        disposition: 'short_pay',
        reason: 'Overpay',
        actor_name: 'David Miller',
        payable_total_cents: billedCents + 1
      }),
      (err) => err.statusCode === 400 && /cannot exceed/.test(err.message)
    );
    await assert.rejects(
      () => resolveInvoiceException(db, flagged.invoiceId, {
        disposition: 'short_pay',
        reason: 'Negative',
        actor_name: 'David Miller',
        payable_total_cents: -1
      }),
      (err) => err.statusCode === 400 && /≥ 0|>= 0/.test(err.message)
    );
    await assert.rejects(
      () => resolveInvoiceException(db, flagged.invoiceId, {
        disposition: 'short_pay',
        reason: 'Float',
        actor_name: 'David Miller',
        payable_total_cents: 149800.5
      }),
      (err) => err.statusCode === 400 && /integer number of cents/.test(err.message)
    );
    await assert.rejects(
      () => resolveInvoiceException(db, flagged.invoiceId, {
        disposition: 'short_pay',
        actor_name: 'David Miller',
        payable_total_cents: 149800
      }),
      (err) => err.statusCode === 400 && /reason is required/.test(err.message)
    );
    await assert.rejects(
      () => resolveInvoiceException(db, flagged.invoiceId, {
        disposition: 'short_pay',
        reason: 'Missing payable',
        actor_name: 'David Miller'
      }),
      (err) => err.statusCode === 400 && /payable_total_cents/.test(err.message)
    );
    await assert.rejects(
      () => resolveInvoiceException(db, perfect.invoiceId, {
        disposition: 'short_pay',
        reason: 'should not work',
        actor_name: 'David Miller',
        payable_total_cents: 100
      }),
      (err) => err.statusCode === 400 && /variance-flagged/.test(err.message)
    );
  });

  test('short_pay clears the block, keeps billed total, writes audit cents, and unlocks approve', async () => {
    const db = await createTestDb();
    const created = await createFlaggedInvoice(db, { billedPrice: 79900, qty: 4 });
    const billedCents = 4 * 79900;
    const payableCents = 2 * 74900;

    const resolved = await resolveInvoiceException(db, created.invoiceId, {
      disposition: 'short_pay',
      reason: 'Pay received qty at PO price only.',
      actor_name: 'David Miller',
      payable_total_cents: payableCents
    });

    assert.equal(resolved.disposition, 'short_pay');
    assert.equal(resolved.invoice_status, 'matched');
    assert.equal(resolved.accepted_total_cents, payableCents);
    assert.equal(resolved.billed_total_cents, billedCents);
    assert.equal(resolved.payable_total_cents, payableCents);
    assert.equal(resolved.accepted_match_status, 'total_variance');

    const invoice = await db.prepare(`
      SELECT status, match_status, total_amount, payable_total_cents FROM invoices WHERE id = ?
    `).get(created.invoiceId);
    assert.equal(invoice.status, 'matched');
    assert.equal(invoice.match_status, 'total_variance');
    assert.equal(invoice.total_amount, billedCents);
    assert.equal(invoice.payable_total_cents, payableCents);

    const disposition = await db.prepare(`
      SELECT * FROM invoice_exception_dispositions WHERE invoice_id = ?
    `).get(created.invoiceId);
    assert.equal(disposition.disposition, 'short_pay');
    assert.equal(disposition.accepted_total_cents, payableCents);
    assert.equal(disposition.billed_total_cents, billedCents);

    const audit = await db.prepare(`
      SELECT * FROM audit_logs WHERE entity_type = 'invoice' AND entity_id = ? AND action = 'EXCEPTION_SHORT_PAY'
    `).get(created.invoiceId);
    assert.ok(audit);
    assert.equal(audit.actor_name, 'David Miller');
    assert.ok(audit.details.includes(`${billedCents}¢`));
    assert.ok(audit.details.includes(`${payableCents}¢`));
    assert.ok(audit.details.includes(`${billedCents - payableCents}¢`));

    const approve = await approveInvoicePayment(db, created.invoiceId, {
      approver_name: 'David Miller'
    });
    assert.match(approve.message, /Billed \$3196\.00 → Pay \$1498\.00/);
    const after = await db.prepare(`SELECT status FROM invoices WHERE id = ?`).get(created.invoiceId);
    assert.equal(after.status, 'approved_for_payment');
  });

  test('approve and mark-paid budget movement uses payable cents, not billed', async () => {
    const db = await createTestDb();
    const billedCents = 4 * 79900;
    const payableCents = 2 * 74900;
    const committed = 299600;
    const created = await createFlaggedInvoiceOnBudget(db, { committed });

    await resolveInvoiceException(db, created.invoiceId, {
      disposition: 'short_pay',
      reason: 'Short-pay unreceived units and price overage.',
      actor_name: 'Elena Rostova',
      payable_total_cents: payableCents
    });

    const invoice = await db.prepare(`SELECT total_amount, payable_total_cents FROM invoices WHERE id = ?`).get(created.invoiceId);
    assert.equal(invoice.total_amount, billedCents);
    assert.equal(invoice.payable_total_cents, payableCents);

    await approveInvoicePayment(db, created.invoiceId, { approver_name: 'David Miller' });
    const afterApprove = await db.prepare(`
      SELECT committed_amount, actual_spent FROM budgets WHERE department_id = 1 AND fiscal_year = 2026
    `).get();
    assert.equal(afterApprove.actual_spent, payableCents);
    assert.equal(afterApprove.committed_amount, committed - payableCents);

    const paid = await markInvoicePaid(db, created.invoiceId, { payer_name: 'David Miller' });
    assert.equal(paid.payable_total_cents, payableCents);
    assert.equal(paid.billed_total_cents, billedCents);
    const afterPay = await db.prepare(`
      SELECT status, total_amount, payable_total_cents FROM invoices WHERE id = ?
    `).get(created.invoiceId);
    assert.equal(afterPay.status, 'paid');
    assert.equal(afterPay.total_amount, billedCents);
    assert.equal(afterPay.payable_total_cents, payableCents);

    const budgetAfterPay = await db.prepare(`
      SELECT committed_amount, actual_spent FROM budgets WHERE department_id = 1 AND fiscal_year = 2026
    `).get();
    assert.equal(budgetAfterPay.actual_spent, payableCents);
  });

  test('short_pay is terminal and listed on the resolved queue', async () => {
    const db = await createTestDb();
    const created = await createFlaggedInvoice(db);

    await resolveInvoiceException(db, created.invoiceId, {
      disposition: 'short_pay',
      reason: 'Pay GRN quantity at PO price.',
      actor_name: 'David Miller',
      payable_total_cents: 100
    });

    await assert.rejects(
      () => resolveInvoiceException(db, created.invoiceId, {
        disposition: 'accept_variance',
        reason: 'changed my mind',
        actor_name: 'David Miller'
      }),
      (err) => err.statusCode === 400 && /terminal disposition|already progressed|variance-flagged/.test(err.message)
    );

    const resolved = await listInvoiceExceptions(db, { queue: 'resolved' });
    assert.ok(resolved.some((row) => row.id === created.invoiceId));
    const open = await listInvoiceExceptions(db, { queue: 'open' });
    assert.ok(!open.some((row) => row.id === created.invoiceId));
  });
});

async function createFlaggedInvoiceForRequester(db, {
  requesterId = 2,
  departmentId = 1,
  qty = 4,
  received = 2,
  ordered = 4,
  poPrice = 74900,
  billedPrice = 79900,
  invoiceNumber = 'INV-BUYER-1'
} = {}) {
  await db.prepare(`
    INSERT INTO purchase_requisitions (pr_number, requester_id, department_id, status, total_amount)
    VALUES (?, ?, ?, 'converted_to_po', ?)
  `).run(`PR-${invoiceNumber}`, requesterId, departmentId, ordered * poPrice);
  const pr = await db.prepare(`SELECT id FROM purchase_requisitions WHERE pr_number = ?`).get(`PR-${invoiceNumber}`);
  await db.prepare(`
    INSERT INTO purchase_orders (po_number, requisition_id, supplier_id, created_by, status, total_amount, issue_date)
    VALUES (?, ?, 1, 1, 'partially_received', ?, '2026-09-01')
  `).run(`PO-${invoiceNumber}`, pr.id, ordered * poPrice);
  const po = await db.prepare(`SELECT id FROM purchase_orders WHERE po_number = ?`).get(`PO-${invoiceNumber}`);
  await db.prepare(`
    INSERT INTO po_items (po_id, item_description, category, quantity, unit_price, total_price, quantity_received, quantity_accepted, quantity_invoiced, line_type)
    VALUES (?, 'Test Monitor', 'IT Hardware', ?, ?, ?, ?, 0, 0, 'goods')
  `).run(po.id, ordered, poPrice, ordered * poPrice, received);
  const item = await db.prepare(`SELECT id FROM po_items WHERE po_id = ?`).get(po.id);
  return await createVendorInvoice(db, invoicePayload({
    qty,
    unitPriceCents: billedPrice,
    invoiceNumber,
    poId: po.id,
    itemId: item.id
  }));
}

describe('buyer inbox for return_to_buyer', () => {
  test('queue lists only return_to_buyer parks; flagged-without-return and terminal stay out', async () => {
    const db = await createTestDb();
    const parked = await createFlaggedInvoiceForRequester(db, { invoiceNumber: 'INV-PARK' });
    const flaggedOnly = await createFlaggedInvoiceForRequester(db, { invoiceNumber: 'INV-OPEN' });
    const accepted = await createFlaggedInvoiceForRequester(db, { invoiceNumber: 'INV-ACC' });

    await resolveInvoiceException(db, parked.invoiceId, {
      disposition: 'return_to_buyer',
      reason: 'Confirm remaining units with the requester.',
      actor_name: 'David Miller'
    });
    await resolveInvoiceException(db, accepted.invoiceId, {
      disposition: 'accept_variance',
      reason: 'Pay billed amount.',
      actor_name: 'David Miller'
    });

    const inbox = await listBuyerInbox(db);
    const ids = inbox.map((row) => row.id);
    assert.ok(ids.includes(parked.invoiceId));
    assert.ok(!ids.includes(flaggedOnly.invoiceId));
    assert.ok(!ids.includes(accepted.invoiceId));
    assert.equal(inbox[0].status, 'variance_flagged');
    assert.equal(inbox[0].exception.disposition, 'return_to_buyer');
    assert.match(inbox[0].exception.reason, /Confirm remaining units/);
  });

  test('buyer respond requires reason and actor_name; wrong status is 400', async () => {
    const db = await createTestDb();
    const parked = await createFlaggedInvoiceForRequester(db, { invoiceNumber: 'INV-RESP' });
    await resolveInvoiceException(db, parked.invoiceId, {
      disposition: 'return_to_buyer',
      reason: 'Need buyer confirmation.',
      actor_name: 'David Miller'
    });

    const flaggedOnly = await createFlaggedInvoiceForRequester(db, { invoiceNumber: 'INV-NO-RET' });

    await assert.rejects(
      () => respondBuyerInbox(db, parked.invoiceId, {
        actor_name: 'Alice Chen'
      }),
      (err) => err.statusCode === 400 && /reason is required/.test(err.message)
    );
    await assert.rejects(
      () => respondBuyerInbox(db, parked.invoiceId, {
        reason: '   ',
        actor_name: 'Alice Chen'
      }),
      (err) => err.statusCode === 400 && /reason is required/.test(err.message)
    );
    await assert.rejects(
      () => respondBuyerInbox(db, parked.invoiceId, {
        reason: 'Third unit arrived off-system.'
      }),
      (err) => err.statusCode === 400 && /actor_name is required/.test(err.message)
    );
    await assert.rejects(
      () => respondBuyerInbox(db, flaggedOnly.invoiceId, {
        reason: 'Should not work — never returned.',
        actor_name: 'Alice Chen'
      }),
      (err) => err.statusCode === 400 && /not currently parked as return_to_buyer/.test(err.message)
    );
  });

  test('buyer respond writes buyer_response + EXCEPTION_BUYER_RESPONDED and stays variance_flagged', async () => {
    const db = await createTestDb();
    const parked = await createFlaggedInvoiceForRequester(db, { invoiceNumber: 'INV-NOTE' });
    await resolveInvoiceException(db, parked.invoiceId, {
      disposition: 'return_to_buyer',
      reason: 'Was the third monitor received off-system?',
      actor_name: 'David Miller'
    });

    const result = await respondBuyerInbox(db, parked.invoiceId, {
      reason: 'Yes — remaining units arrived via desk drop. Ready for AP.',
      actor_name: 'Alice Chen'
    });

    assert.equal(result.disposition, BUYER_RESPONSE_DISPOSITION);
    assert.equal(result.invoice_status, 'variance_flagged');
    assert.equal(result.invoice.status, 'variance_flagged');
    assert.equal(result.invoice.exception.disposition, BUYER_RESPONSE_DISPOSITION);
    assert.match(result.invoice.exception.reason, /desk drop/);

    const invoice = await db.prepare(`SELECT status FROM invoices WHERE id = ?`).get(parked.invoiceId);
    assert.equal(invoice.status, 'variance_flagged');

    const history = await db.prepare(`
      SELECT disposition, reason, actor_name FROM invoice_exception_dispositions
      WHERE invoice_id = ? ORDER BY id
    `).all(parked.invoiceId);
    assert.deepEqual(history.map((row) => row.disposition), ['return_to_buyer', 'buyer_response']);
    assert.equal(history[1].actor_name, 'Alice Chen');

    const audit = await db.prepare(`
      SELECT * FROM audit_logs
      WHERE entity_type = 'invoice' AND entity_id = ? AND action = ?
    `).get(parked.invoiceId, BUYER_RESPONSE_AUDIT);
    assert.ok(audit);
    assert.equal(audit.actor_name, 'Alice Chen');
    assert.ok(audit.details.includes('Ready for AP'));
    assert.ok(audit.details.includes('desk drop'));

    const after = await listBuyerInbox(db);
    assert.ok(!after.some((row) => row.id === parked.invoiceId), 'responded invoice leaves the buyer inbox');

    await assert.rejects(
      () => respondBuyerInbox(db, parked.invoiceId, {
        reason: 'Second note.',
        actor_name: 'Alice Chen'
      }),
      (err) => err.statusCode === 400 && /not currently parked as return_to_buyer/.test(err.message)
    );
  });

  test('AP can accept, short-pay, or reject after a buyer response', async () => {
    const db = await createTestDb();
    const acceptInv = await createFlaggedInvoiceForRequester(db, { invoiceNumber: 'INV-BA' });
    const shortInv = await createFlaggedInvoiceForRequester(db, { invoiceNumber: 'INV-BS' });
    const rejectInv = await createFlaggedInvoiceForRequester(db, { invoiceNumber: 'INV-BR' });

    for (const created of [acceptInv, shortInv, rejectInv]) {
      await resolveInvoiceException(db, created.invoiceId, {
        disposition: 'return_to_buyer',
        reason: 'Need requester note.',
        actor_name: 'David Miller'
      });
      await respondBuyerInbox(db, created.invoiceId, {
        reason: 'Confirmed receiving. Ready for AP.',
        actor_name: 'Alice Chen'
      });
    }

    const accepted = await resolveInvoiceException(db, acceptInv.invoiceId, {
      disposition: 'accept_variance',
      reason: 'Buyer confirmed remaining units; pay billed.',
      actor_name: 'David Miller'
    });
    assert.equal(accepted.invoice_status, 'matched');

    const payableCents = 2 * 74900;
    const shorted = await resolveInvoiceException(db, shortInv.invoiceId, {
      disposition: 'short_pay',
      reason: 'Pay received qty at PO price after buyer note.',
      actor_name: 'David Miller',
      payable_total_cents: payableCents
    });
    assert.equal(shorted.invoice_status, 'matched');
    assert.equal(shorted.payable_total_cents, payableCents);

    const rejected = await resolveInvoiceException(db, rejectInv.invoiceId, {
      disposition: 'reject_invoice',
      reason: 'Buyer could not confirm; reject.',
      actor_name: 'David Miller'
    });
    assert.equal(rejected.invoice_status, 'rejected');

    const open = await listInvoiceExceptions(db, { queue: 'open' });
    assert.ok(!open.some((row) => [acceptInv.invoiceId, shortInv.invoiceId, rejectInv.invoiceId].includes(row.id)));
  });

  test('requester_id scopes to linked PR requester and/or their department', async () => {
    const db = await createTestDb();
    const aliceInv = await createFlaggedInvoiceForRequester(db, {
      invoiceNumber: 'INV-ALICE',
      requesterId: 2,
      departmentId: 1
    });
    const priyaInv = await createFlaggedInvoiceForRequester(db, {
      invoiceNumber: 'INV-PRIYA',
      requesterId: 3,
      departmentId: 2
    });
    const orphan = await createFlaggedInvoice(db, {
      invoiceNumber: 'INV-ORPH',
      poId: 90,
      itemId: 90,
      poNumber: 'PO-ORPH'
    });

    for (const created of [aliceInv, priyaInv, orphan]) {
      await resolveInvoiceException(db, created.invoiceId, {
        disposition: 'return_to_buyer',
        reason: 'Parked for buyer.',
        actor_name: 'David Miller'
      });
    }

    const unscoped = await listBuyerInbox(db);
    assert.equal(unscoped.length, 3);

    const aliceQueue = await listBuyerInbox(db, { requester_id: 2 });
    const aliceIds = aliceQueue.map((row) => row.id);
    assert.ok(aliceIds.includes(aliceInv.invoiceId));
    assert.ok(!aliceIds.includes(priyaInv.invoiceId));
    assert.ok(!aliceIds.includes(orphan.invoiceId));

    const priyaQueue = await listBuyerInbox(db, { requester_id: 3 });
    const priyaIds = priyaQueue.map((row) => row.id);
    assert.ok(priyaIds.includes(priyaInv.invoiceId));
    assert.ok(!priyaIds.includes(aliceInv.invoiceId));

    const mktDept = await listBuyerInbox(db, { department_id: 1 });
    assert.ok(mktDept.some((row) => row.id === aliceInv.invoiceId));
    assert.ok(!mktDept.some((row) => row.id === priyaInv.invoiceId));

    const unknownUser = await listBuyerInbox(db, { requester_id: 99 });
    assert.deepEqual(unknownUser, []);
  });

  test('matched invoice cannot take a buyer response (fail closed)', async () => {
    const db = await createTestDb();
    await insertPoLine(db, { ordered: 1, received: 1, unitPriceCents: 5000 });
    const perfect = await createVendorInvoice(db, invoicePayload({
      qty: 1, unitPriceCents: 5000, invoiceNumber: 'INV-OK-B'
    }));

    await assert.rejects(
      () => respondBuyerInbox(db, perfect.invoiceId, {
        reason: 'should not work',
        actor_name: 'Alice Chen'
      }),
      (err) => err.statusCode === 400 && /variance-flagged/.test(err.message)
    );
  });
});
