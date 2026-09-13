import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMemoryDatabase } from './db.js';
import { createApp } from './app.js';
import { loadDbConfig } from './dbConfig.js';
import { createVendorInvoice, approveInvoicePayment, markInvoicePaid } from './invoicesService.js';
import { resolveInvoiceException } from './invoiceExceptionsService.js';
import { getDocumentTrail } from './documentTrailService.js';
import {
  DUPLICATE_AUDIT,
  DUPLICATE_DATE_WINDOW_DAYS,
  MATCH_RULES,
  addUtcCalendarDays,
  classifyDuplicateMatch,
  findDuplicateSuspects,
  getInvoiceDuplicateDetail,
  isWithinUtcDateWindow,
  listInvoiceDuplicates,
  resolveInvoiceDuplicate,
  utcCalendarDaysBetween
} from './invoiceDuplicatesService.js';

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
    INSERT INTO departments (id, code, name) VALUES (1, 'MKT', 'Marketing'), (2, 'ITE', 'IT');
    INSERT INTO users (id, name, email, role, department_id, approval_limit) VALUES
      (1, 'David Miller', 'david@example.com', 'finance', 1, 15000000),
      (2, 'Alice Chen', 'alice@example.com', 'requester', 1, 0);
    INSERT INTO suppliers (id, name, code) VALUES
      (1, 'TechSupply Global', 'SUP-TSG'),
      (2, 'WorkSpace Ergonomics Depot', 'SUP-WED');
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
  description = 'Test Mouse',
  poId = 1,
  itemId = 1,
  poNumber = 'PO-TEST-001',
  supplierId = 1
}) {
  const existingPo = await db.prepare(`SELECT id FROM purchase_orders WHERE id = ?`).get(poId);
  if (!existingPo) {
    await db.prepare(`
      INSERT INTO purchase_orders (id, po_number, supplier_id, created_by, status, total_amount, issue_date)
      VALUES (?, ?, ?, 1, 'partially_received', ?, '2026-09-01')
    `).run(poId, poNumber, supplierId, ordered * unitPriceCents);
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
  supplierId = 1,
  invoiceDate = '2026-09-10',
  description = 'Test Mouse'
}) {
  return {
    invoice_number: invoiceNumber,
    po_id: poId,
    supplier_id: supplierId,
    invoice_date: invoiceDate,
    due_date: '2026-10-10',
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

async function seedMatchingPairPos(db) {
  await insertPoLine(db, {
    ordered: 1, received: 1, unitPriceCents: 9900, poId: 1, itemId: 1, poNumber: 'PO-A', supplierId: 1
  });
  await insertPoLine(db, {
    ordered: 1, received: 1, unitPriceCents: 9900, poId: 2, itemId: 2, poNumber: 'PO-B', supplierId: 1
  });
}

describe('duplicate date window (UTC calendar days)', () => {
  test('inclusive ±7 window; 8th day misses; integer day math', () => {
    assert.equal(DUPLICATE_DATE_WINDOW_DAYS, 7);
    assert.equal(utcCalendarDaysBetween('2026-09-10', '2026-09-17'), 7);
    assert.equal(utcCalendarDaysBetween('2026-09-10', '2026-09-03'), -7);
    assert.equal(utcCalendarDaysBetween('2026-09-10', '2026-09-18'), 8);
    assert.equal(isWithinUtcDateWindow('2026-09-10', '2026-09-10'), true);
    assert.equal(isWithinUtcDateWindow('2026-09-10', '2026-09-17'), true);
    assert.equal(isWithinUtcDateWindow('2026-09-10', '2026-09-03'), true);
    assert.equal(isWithinUtcDateWindow('2026-09-10', '2026-09-18'), false);
    assert.equal(isWithinUtcDateWindow('2026-09-10', '2026-09-02'), false);
    assert.equal(addUtcCalendarDays('2026-09-10', 7), '2026-09-17');
    assert.equal(addUtcCalendarDays('2026-09-10', -7), '2026-09-03');
  });
});

describe('classifyDuplicateMatch', () => {
  const incoming = {
    id: 2,
    supplier_id: 1,
    po_id: 2,
    total_amount: 9900,
    invoice_date: '2026-09-10'
  };

  test('same amount + near date hits; 1¢ miss; other supplier miss; self excluded', () => {
    assert.equal(
      classifyDuplicateMatch(incoming, {
        id: 1, supplier_id: 1, po_id: 1, total_amount: 9900, invoice_date: '2026-09-08', status: 'paid'
      }),
      MATCH_RULES.SAME_AMOUNT_NEAR_DATE
    );
    assert.equal(
      classifyDuplicateMatch(incoming, {
        id: 1, supplier_id: 1, po_id: 1, total_amount: 9901, invoice_date: '2026-09-08', status: 'paid'
      }),
      null
    );
    assert.equal(
      classifyDuplicateMatch(incoming, {
        id: 1, supplier_id: 2, po_id: 1, total_amount: 9900, invoice_date: '2026-09-08', status: 'paid'
      }),
      null
    );
    assert.equal(
      classifyDuplicateMatch(incoming, {
        id: 2, supplier_id: 1, po_id: 2, total_amount: 9900, invoice_date: '2026-09-10', status: 'matched'
      }),
      null
    );
  });

  test('same PO + same amount hits even outside the date window; both when overlapping', () => {
    assert.equal(
      classifyDuplicateMatch(incoming, {
        id: 1, supplier_id: 1, po_id: 2, total_amount: 9900, invoice_date: '2026-08-01', status: 'matched'
      }),
      MATCH_RULES.SAME_PO_SAME_AMOUNT
    );
    assert.equal(
      classifyDuplicateMatch(incoming, {
        id: 1, supplier_id: 1, po_id: 2, total_amount: 9900, invoice_date: '2026-09-12', status: 'matched'
      }),
      MATCH_RULES.BOTH
    );
  });

  test('rejected candidates are ignored', () => {
    assert.equal(
      classifyDuplicateMatch(incoming, {
        id: 1, supplier_id: 1, po_id: 1, total_amount: 9900, invoice_date: '2026-09-10', status: 'rejected'
      }),
      null
    );
  });
});

describe('duplicate detection on invoice create', () => {
  test('hit: same supplier + billed cents + date within window; create still succeeds', async () => {
    const db = await createTestDb();
    await seedMatchingPairPos(db);

    const first = await createVendorInvoice(db, invoicePayload({
      qty: 1, unitPriceCents: 9900, invoiceNumber: 'INV-TSG-6610', poId: 1, itemId: 1, invoiceDate: '2026-09-10'
    }));
    assert.equal(first.duplicate_status, 'clear');
    assert.equal(first.duplicate_suspects.length, 0);

    const second = await createVendorInvoice(db, invoicePayload({
      qty: 1, unitPriceCents: 9900, invoiceNumber: 'INV-TSG-6611', poId: 2, itemId: 2, invoiceDate: '2026-09-13'
    }));
    assert.equal(second.duplicate_status, 'suspect');
    assert.equal(second.duplicate_suspects.length, 1);
    assert.equal(second.duplicate_suspects[0].invoice_number, 'INV-TSG-6610');
    assert.equal(second.duplicate_suspects[0].match_rule, MATCH_RULES.SAME_AMOUNT_NEAR_DATE);
    assert.equal(second.duplicate_suspects[0].billed_total_cents, 9900);

    const row = await db.prepare(`SELECT duplicate_status, total_amount, status FROM invoices WHERE id = ?`).get(second.invoiceId);
    assert.equal(row.duplicate_status, 'suspect');
    assert.equal(row.total_amount, 9900);
    assert.equal(row.status, 'matched');

    const flags = await db.prepare(`SELECT * FROM invoice_duplicate_flags WHERE invoice_id = ?`).all(second.invoiceId);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].candidate_invoice_id, first.invoiceId);
    assert.equal(flags[0].billed_total_cents, 9900);
    assert.equal(flags[0].status, 'open');

    const audit = await db.prepare(`
      SELECT action, actor_name, details FROM audit_logs
      WHERE entity_type = 'invoice' AND entity_id = ? AND action = ?
    `).get(second.invoiceId, DUPLICATE_AUDIT.suspected);
    assert.ok(audit);
    assert.match(audit.details, /9900¢/);
    assert.match(audit.details, /INV-TSG-6610/);
  });

  test('miss: amount 1¢ off, date on the 8th day, or different supplier', async () => {
    const db = await createTestDb();
    await seedMatchingPairPos(db);
    await insertPoLine(db, {
      ordered: 1, received: 1, unitPriceCents: 9900, poId: 3, itemId: 3, poNumber: 'PO-C', supplierId: 2
    });
    await insertPoLine(db, {
      ordered: 1, received: 1, unitPriceCents: 9901, poId: 4, itemId: 4, poNumber: 'PO-D', supplierId: 1
    });

    await createVendorInvoice(db, invoicePayload({
      qty: 1, unitPriceCents: 9900, invoiceNumber: 'INV-ORIG', poId: 1, itemId: 1, invoiceDate: '2026-09-10'
    }));

    const dayEight = await createVendorInvoice(db, invoicePayload({
      qty: 1, unitPriceCents: 9900, invoiceNumber: 'INV-DAY8', poId: 2, itemId: 2, invoiceDate: '2026-09-18'
    }));
    assert.equal(dayEight.duplicate_status, 'clear');

    const otherVendor = await createVendorInvoice(db, invoicePayload({
      qty: 1, unitPriceCents: 9900, invoiceNumber: 'INV-WED-1', poId: 3, itemId: 3, supplierId: 2, invoiceDate: '2026-09-10'
    }));
    assert.equal(otherVendor.duplicate_status, 'clear');

    const pennyOff = await createVendorInvoice(db, invoicePayload({
      qty: 1, unitPriceCents: 9901, invoiceNumber: 'INV-PENNY', poId: 4, itemId: 4, invoiceDate: '2026-09-10'
    }));
    assert.equal(pennyOff.duplicate_status, 'clear');
  });

  test('date window edges: exactly ±7 hits', async () => {
    const db = await createTestDb();
    await seedMatchingPairPos(db);
    await insertPoLine(db, {
      ordered: 1, received: 1, unitPriceCents: 9900, poId: 3, itemId: 3, poNumber: 'PO-C', supplierId: 1
    });

    await createVendorInvoice(db, invoicePayload({
      qty: 1, unitPriceCents: 9900, invoiceNumber: 'INV-MID', poId: 1, itemId: 1, invoiceDate: '2026-09-10'
    }));

    const plusSeven = await createVendorInvoice(db, invoicePayload({
      qty: 1, unitPriceCents: 9900, invoiceNumber: 'INV-P7', poId: 2, itemId: 2, invoiceDate: '2026-09-17'
    }));
    assert.equal(plusSeven.duplicate_status, 'suspect');

    const minusSeven = await createVendorInvoice(db, invoicePayload({
      qty: 1, unitPriceCents: 9900, invoiceNumber: 'INV-M7', poId: 3, itemId: 3, invoiceDate: '2026-09-03'
    }));
    assert.equal(minusSeven.duplicate_status, 'suspect');
  });

  test('same PO + same billed cents hits with a different invoice number even far apart', async () => {
    const db = await createTestDb();
    await insertPoLine(db, {
      ordered: 2, received: 2, unitPriceCents: 9900, poId: 1, itemId: 1, poNumber: 'PO-SAME'
    });

    const first = await createVendorInvoice(db, invoicePayload({
      qty: 1, unitPriceCents: 9900, invoiceNumber: 'INV-PO-A', poId: 1, itemId: 1, invoiceDate: '2026-01-01'
    }));
    assert.equal(first.duplicate_status, 'clear');

    const second = await createVendorInvoice(db, invoicePayload({
      qty: 1, unitPriceCents: 9900, invoiceNumber: 'INV-PO-B', poId: 1, itemId: 1, invoiceDate: '2026-06-01'
    }));
    assert.equal(second.duplicate_status, 'suspect');
    assert.equal(second.duplicate_suspects[0].match_rule, MATCH_RULES.SAME_PO_SAME_AMOUNT);
    assert.equal(second.duplicate_suspects[0].id, first.invoiceId);
  });

  test('rejected invoices are not candidates; exact invoice-number reuse still hard-fails', async () => {
    const db = await createTestDb();
    await seedMatchingPairPos(db);

    await insertPoLine(db, {
      ordered: 4, received: 2, unitPriceCents: 74900, poId: 5, itemId: 5, poNumber: 'PO-EX'
    });
    const flagged = await createVendorInvoice(db, invoicePayload({
      qty: 4, unitPriceCents: 79900, invoiceNumber: 'INV-HARD', poId: 5, itemId: 5, invoiceDate: '2026-09-10'
    }));
    await resolveInvoiceException(db, flagged.invoiceId, {
      disposition: 'reject_invoice',
      reason: 'Wrong shipment',
      actor_name: 'David Miller'
    });

    await insertPoLine(db, {
      ordered: 4, received: 4, unitPriceCents: 79900, poId: 6, itemId: 6, poNumber: 'PO-OK'
    });
    const afterReject = await createVendorInvoice(db, invoicePayload({
      qty: 4, unitPriceCents: 79900, invoiceNumber: 'INV-AFTER', poId: 6, itemId: 6, invoiceDate: '2026-09-10'
    }));
    assert.equal(afterReject.duplicate_status, 'clear');

    await createVendorInvoice(db, invoicePayload({
      qty: 1, unitPriceCents: 9900, invoiceNumber: 'INV-TSG-DUP', poId: 1, itemId: 1, invoiceDate: '2026-09-10'
    }));
    await assert.rejects(
      () => createVendorInvoice(db, invoicePayload({
        qty: 1, unitPriceCents: 9900, invoiceNumber: 'INV-TSG-DUP', poId: 2, itemId: 2, invoiceDate: '2026-09-11'
      })),
      (err) => err.statusCode === 400 && /already exists for this supplier/.test(err.message)
    );
  });
});

describe('approve / mark-paid fail closed while suspect', () => {
  test('approve blocked while suspect; confirm_unique unlocks approve; confirm_duplicate rejects', async () => {
    const db = await createTestDb();
    await seedMatchingPairPos(db);
    await insertPoLine(db, {
      ordered: 1, received: 1, unitPriceCents: 9900, poId: 3, itemId: 3, poNumber: 'PO-C', supplierId: 1
    });
    await insertPoLine(db, {
      ordered: 1, received: 1, unitPriceCents: 9900, poId: 4, itemId: 4, poNumber: 'PO-D', supplierId: 1
    });

    await createVendorInvoice(db, invoicePayload({
      qty: 1, unitPriceCents: 9900, invoiceNumber: 'INV-ORIG', poId: 1, itemId: 1, invoiceDate: '2026-09-10'
    }));

    const suspect = await createVendorInvoice(db, invoicePayload({
      qty: 1, unitPriceCents: 9900, invoiceNumber: 'INV-SUS', poId: 2, itemId: 2, invoiceDate: '2026-09-11'
    }));
    assert.equal(suspect.matchOutcome.invoiceStatus, 'matched');

    await assert.rejects(
      () => approveInvoicePayment(db, suspect.invoiceId, { approver_name: 'David Miller' }),
      (err) => err.statusCode === 400 && /Likely duplicate/.test(err.message)
    );

    const open = await listInvoiceDuplicates(db, { queue: 'open' });
    assert.equal(open.length, 1);
    assert.equal(open[0].invoice_number, 'INV-SUS');
    assert.equal(open[0].needs_duplicate_review, true);

    const cleared = await resolveInvoiceDuplicate(db, suspect.invoiceId, {
      disposition: 'confirm_unique',
      reason: 'Second mouse is a real second order on PO-B.',
      actor_name: 'David Miller'
    });
    assert.equal(cleared.duplicate_status, 'confirmed_unique');
    assert.equal(cleared.invoice_status, 'matched');
    assert.equal(cleared.billed_total_cents, 9900);

    const clearedAudit = await db.prepare(`
      SELECT action, details FROM audit_logs
      WHERE entity_type = 'invoice' AND entity_id = ? AND action = ?
    `).get(suspect.invoiceId, DUPLICATE_AUDIT.cleared);
    assert.ok(clearedAudit);
    assert.match(clearedAudit.details, /9900¢/);

    const approved = await approveInvoicePayment(db, suspect.invoiceId, { approver_name: 'David Miller' });
    assert.equal(approved.payable_total_cents, 9900);

    const other = await createVendorInvoice(db, invoicePayload({
      qty: 1, unitPriceCents: 9900, invoiceNumber: 'INV-DUP2', poId: 3, itemId: 3, invoiceDate: '2026-09-12'
    }));
    assert.equal(other.duplicate_status, 'suspect');

    const confirmed = await resolveInvoiceDuplicate(db, other.invoiceId, {
      disposition: 'confirm_duplicate',
      reason: 'Vendor resent the same $99.00 charge under a new number.',
      actor_name: 'David Miller'
    });
    assert.equal(confirmed.duplicate_status, 'confirmed_duplicate');
    assert.equal(confirmed.invoice_status, 'rejected');

    const confirmedAudit = await db.prepare(`
      SELECT action FROM audit_logs
      WHERE entity_type = 'invoice' AND entity_id = ? AND action = ?
    `).get(other.invoiceId, DUPLICATE_AUDIT.confirmed);
    assert.ok(confirmedAudit);

    await assert.rejects(
      () => approveInvoicePayment(db, other.invoiceId, { approver_name: 'David Miller' }),
      (err) => err.statusCode === 400 && /rejected|duplicate/i.test(err.message)
    );
    await assert.rejects(
      () => markInvoicePaid(db, other.invoiceId, { actor_name: 'David Miller' }),
      (err) => err.statusCode === 400
    );

    const resolved = await listInvoiceDuplicates(db, { queue: 'resolved' });
    assert.equal(resolved.length, 2);

    const trail = await getDocumentTrail(db, { q: 'INV-DUP2' });
    const dupEvents = trail.timeline.filter((event) => event.kind === 'duplicate');
    assert.ok(dupEvents.some((event) => event.title === 'Duplicate suspected'));
    assert.ok(dupEvents.some((event) => event.title === 'Duplicate confirmed'));
  });

  test('non-suspect invoices cannot be resolved; missing reason / actor_name / disposition fail closed', async () => {
    const db = await createTestDb();
    await seedMatchingPairPos(db);
    const first = await createVendorInvoice(db, invoicePayload({
      qty: 1, unitPriceCents: 9900, invoiceNumber: 'INV-A', poId: 1, itemId: 1, invoiceDate: '2026-09-10'
    }));
    await assert.rejects(
      () => resolveInvoiceDuplicate(db, first.invoiceId, {
        disposition: 'confirm_unique',
        reason: 'n/a',
        actor_name: 'David Miller'
      }),
      (err) => err.statusCode === 400 && /Only suspect/.test(err.message)
    );

    const suspect = await createVendorInvoice(db, invoicePayload({
      qty: 1, unitPriceCents: 9900, invoiceNumber: 'INV-B', poId: 2, itemId: 2, invoiceDate: '2026-09-11'
    }));

    await assert.rejects(
      () => resolveInvoiceDuplicate(db, suspect.invoiceId, {
        disposition: 'confirm_unique',
        actor_name: 'David Miller'
      }),
      (err) => err.statusCode === 400 && /reason is required/.test(err.message)
    );
    await assert.rejects(
      () => resolveInvoiceDuplicate(db, suspect.invoiceId, {
        disposition: 'confirm_unique',
        reason: 'Looks unique'
      }),
      (err) => err.statusCode === 400 && /actor_name is required/.test(err.message)
    );
    await assert.rejects(
      () => resolveInvoiceDuplicate(db, suspect.invoiceId, {
        disposition: 'accept_variance',
        reason: 'wrong queue',
        actor_name: 'David Miller'
      }),
      (err) => err.statusCode === 400 && /disposition must be/.test(err.message)
    );
  });

  test('findDuplicateSuspects excludes self and uses integer cents', async () => {
    const db = await createTestDb();
    await seedMatchingPairPos(db);
    const first = await createVendorInvoice(db, invoicePayload({
      qty: 1, unitPriceCents: 9900, invoiceNumber: 'INV-A', poId: 1, itemId: 1, invoiceDate: '2026-09-10'
    }));
    const hits = await findDuplicateSuspects(db, {
      invoiceId: first.invoiceId,
      supplierId: 1,
      poId: 1,
      totalAmountCents: 9900,
      invoiceDate: '2026-09-10'
    });
    assert.equal(hits.length, 0);

    const againstNew = await findDuplicateSuspects(db, {
      invoiceId: 99,
      supplierId: 1,
      poId: 2,
      totalAmountCents: 9900,
      invoiceDate: '2026-09-12'
    });
    assert.equal(againstNew.length, 1);
    assert.equal(againstNew[0].id, first.invoiceId);
  });
});

describe('GET /api/invoice-duplicates', () => {
  test('open queue, detail, resolve, and create response include suspects', async () => {
    const db = await createTestDb();
    await seedMatchingPairPos(db);
    await createVendorInvoice(db, invoicePayload({
      qty: 1, unitPriceCents: 9900, invoiceNumber: 'INV-A', poId: 1, itemId: 1, invoiceDate: '2026-09-10'
    }));
    const suspect = await createVendorInvoice(db, invoicePayload({
      qty: 1, unitPriceCents: 9900, invoiceNumber: 'INV-B', poId: 2, itemId: 2, invoiceDate: '2026-09-11'
    }));

    const app = createApp({ db, config: loadDbConfig({}) });
    await withServer(app, async (base) => {
      const listed = await json(await fetch(`${base}/api/invoice-duplicates`));
      assert.equal(listed.status, 200);
      assert.equal(listed.body.length, 1);
      assert.equal(listed.body[0].invoice_number, 'INV-B');
      assert.equal(listed.body[0].duplicate_status, 'suspect');
      assert.equal(listed.body[0].duplicate_suspects[0].invoice_number, 'INV-A');

      const detail = await json(await fetch(`${base}/api/invoice-duplicates/${suspect.invoiceId}`));
      assert.equal(detail.status, 200);
      assert.equal(detail.body.candidates[0].invoice_number, 'INV-A');
      assert.equal(detail.body.billed_total_cents, 9900);

      const created = await json(await fetch(`${base}/api/invoices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invoicePayload({
          qty: 1, unitPriceCents: 5000, invoiceNumber: 'INV-NEW', poId: 1, itemId: 1, invoiceDate: '2026-09-10'
        }))
      }));
      // 5000¢ on PO-A (already invoiced 9900 of 9900) will quantity-variance, but
      // should not be a duplicate of the $99 pair.
      assert.equal(created.status, 201);
      assert.equal(created.body.duplicate_status, 'clear');

      const resolved = await json(await fetch(`${base}/api/invoice-duplicates/${suspect.invoiceId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          disposition: 'confirm_unique',
          reason: 'Two separate POs for spare mice.',
          actor_name: 'David Miller'
        })
      }));
      assert.equal(resolved.status, 200);
      assert.equal(resolved.body.duplicate_status, 'confirmed_unique');

      const approve = await json(await fetch(`${base}/api/invoices/${suspect.invoiceId}/approve-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approver_name: 'David Miller' })
      }));
      assert.equal(approve.status, 200);

      const badQueue = await json(await fetch(`${base}/api/invoice-duplicates?queue=yesterday`));
      assert.equal(badQueue.status, 400);
    });

    const after = await getInvoiceDuplicateDetail(db, suspect.invoiceId);
    assert.equal(after.duplicate_status, 'confirmed_unique');
  });
});
