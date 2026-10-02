import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMemoryDatabase } from './db.js';
import { createApp } from './app.js';
import { loadDbConfig } from './dbConfig.js';
import { decideApprovalStep } from './approvalsService.js';
import { convertRequisitionToPurchaseOrders } from './purchaseOrdersService.js';
import { createGoodsReceipt, GoodsReceiptError } from './goodsReceiptsService.js';
import { acceptServiceEntrySheet, createServiceEntrySheet } from './serviceEntrySheetsService.js';
import { createVendorInvoice } from './invoicesService.js';
import { withCookie } from './testSession.js';

function authed(url, options) {
  return fetch(url, withCookie(1, options));
}

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

async function createTestDb() {
  const db = await createMemoryDatabase();
  db.exec(`
    INSERT INTO departments (id, code, name, approver_user_id) VALUES (1, 'MKT', 'Marketing', 2);
    INSERT INTO users (id, name, email, role, department_id) VALUES
      (1, 'Alice Chen', 'alice@example.com', 'requester', 1),
      (2, 'Bob Martinez', 'bob@example.com', 'approver', 1),
      (3, 'Carol Zhang', 'carol@example.com', 'procurement', 1),
      (4, 'David Miller', 'david@example.com', 'finance', 1);
    INSERT INTO suppliers (id, name, code) VALUES (1, 'Apex Advisory', 'SUP-AAD');
    INSERT INTO budgets (department_id, fiscal_year, total_budget, committed_amount, actual_spent)
      VALUES (1, 2026, 15000000, 0, 0);
  `);
  return db;
}

async function postRequisition(base, items, extra = {}) {
  const response = await authed(`${base}/api/requisitions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requester_id: 1,
      department_id: 1,
      justification: extra.justification || 'Service procurement',
      needed_by_date: '2026-10-15',
      priority: 'Medium',
      skip_contract_match: true,
      submitImmediately: true,
      items,
      ...extra
    })
  });
  const body = await response.json();
  assert.equal(response.status, 201, body.error || 'expected 201');
  return body;
}

async function approveAll(db, prId) {
  for (let guard = 0; guard < 5; guard += 1) {
    const pending = await db.prepare(`
      SELECT * FROM approval_requests
      WHERE requisition_id = ? AND status = 'pending'
      ORDER BY step_order
    `).get(prId);
    if (!pending) break;
    const approver = await db.prepare(`SELECT name FROM users WHERE id = ?`).get(pending.approver_id);
    await decideApprovalStep(db, {
      approvalId: pending.id,
      decision: 'approved',
      comments: 'Approved',
      approver_id: pending.approver_id,
      approver_name: approver.name
    });
  }
  const pr = await db.prepare(`SELECT status FROM purchase_requisitions WHERE id = ?`).get(prId);
  assert.equal(pr.status, 'approved');
}

const serviceLines = [
  {
    item_description: 'Senior Consultant — Hourly Advisory',
    category: 'Consulting & Professional Services',
    quantity: 8,
    unit_price: 15000,
    estimated_supplier_id: 1,
    line_type: 'service',
    service_basis: 'hours'
  },
  {
    item_description: 'On-site Implementation Day',
    category: 'Consulting & Professional Services',
    quantity: 2,
    unit_price: 80000,
    estimated_supplier_id: 1,
    line_type: 'service',
    service_basis: 'days'
  },
  {
    item_description: 'SOC 2 readiness workshop',
    category: 'Consulting & Professional Services',
    quantity: 1,
    unit_price: 250000,
    estimated_supplier_id: 1,
    line_type: 'service',
    service_basis: 'lump_sum'
  }
];

describe('service procurement', () => {
  test('creates a service line as lump sum, hours, or days in whole cents', async () => {
    const db = await createTestDb();
    const app = createApp({ db, config: loadDbConfig({}) });

    await withServer(app, async (base) => {
      const created = await postRequisition(base, serviceLines);
      const detail = await authed(`${base}/api/requisitions/${created.id}`);
      const pr = await detail.json();

      assert.equal(pr.total_amount, 530000);
      const byBasis = Object.fromEntries(pr.items.map((item) => [item.service_basis, item]));
      assert.equal(byBasis.hours.line_type, 'service');
      assert.equal(byBasis.hours.quantity, 8);
      assert.equal(byBasis.hours.unit_price, 15000);
      assert.equal(byBasis.hours.total_price, 120000);
      assert.equal(byBasis.days.quantity, 2);
      assert.equal(byBasis.days.total_price, 160000);
      assert.equal(byBasis.lump_sum.quantity, 1);
      assert.equal(byBasis.lump_sum.total_price, 250000);

      const goods = await postRequisition(base, [{
        item_description: 'Copy paper',
        category: 'Office Supplies',
        quantity: 2,
        unit_price: 1000,
        estimated_supplier_id: 1,
        line_type: 'goods',
        service_basis: 'hours'
      }]);
      const goodsDetail = await (await authed(`${base}/api/requisitions/${goods.id}`)).json();
      assert.equal(goodsDetail.items[0].line_type, 'goods');
      assert.equal(goodsDetail.items[0].service_basis, null);

      const bad = await authed(`${base}/api/requisitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requester_id: 1,
          department_id: 1,
          skip_contract_match: true,
          items: [{
            item_description: 'Bad basis',
            category: 'Consulting & Professional Services',
            quantity: 1,
            unit_price: 100,
            estimated_supplier_id: 1,
            line_type: 'service',
            service_basis: 'metered'
          }]
        })
      });
      const badBody = await bad.json();
      assert.equal(bad.status, 400);
      assert.match(badBody.error, /service_basis/i);
    });
  });

  test('approves a service requisition, accepts it without a GRN, and matches the invoice', async () => {
    const db = await createTestDb();
    const app = createApp({ db, config: loadDbConfig({}) });

    await withServer(app, async (base) => {
      const created = await postRequisition(base, serviceLines, {
        justification: 'Hourly, daily, and lump-sum consulting'
      });
      await approveAll(db, created.id);

      const converted = await convertRequisitionToPurchaseOrders(db, {
        requisition_id: created.id,
        created_by: 3
      });
      assert.equal(converted.length, 1);
      const poId = converted[0].poId;
      const poItems = await db.prepare(`
        SELECT * FROM po_items WHERE po_id = ? ORDER BY id
      `).all(poId);
      assert.deepEqual(
        poItems.map((item) => item.service_basis),
        ['hours', 'days', 'lump_sum']
      );

      await assert.rejects(
        () => createGoodsReceipt(db, {
          po_id: poId,
          received_by: 3,
          receipt_date: '2026-10-01',
          items: [{ po_item_id: poItems[0].id, quantity_received: 8, condition: 'good' }]
        }),
        (err) => err instanceof GoodsReceiptError && /Service Entry Sheet/i.test(err.message)
      );
      const receipts = await db.prepare(`SELECT COUNT(*) AS cnt FROM goods_receipts WHERE po_id = ?`).get(poId);
      assert.equal(receipts.cnt, 0);

      const ses = await createServiceEntrySheet(db, {
        po_id: poId,
        created_by: 1,
        service_period_start: '2026-10-01',
        service_period_end: '2026-10-03',
        submitImmediately: true,
        actor_name: 'Alice Chen',
        items: poItems.map((item) => ({
          po_item_id: item.id,
          quantity_accepted: item.quantity,
          comments: 'Service delivered'
        }))
      });
      const accepted = await acceptServiceEntrySheet(db, ses.sesId, {
        decided_by: 3,
        actor_name: 'Carol Zhang',
        decision_comments: 'Work delivered in full'
      });
      assert.equal(accepted.status, 'accepted');
      assert.equal(accepted.delivered, true);

      const sheet = await db.prepare(`SELECT status, decided_by, decided_at FROM service_entry_sheets WHERE id = ?`).get(ses.sesId);
      assert.equal(sheet.status, 'accepted');
      assert.equal(sheet.decided_by, 3);
      assert.ok(sheet.decided_at);

      const acceptedLines = await db.prepare(`
        SELECT service_basis, quantity, quantity_accepted, quantity_received, total_price
        FROM po_items WHERE po_id = ? ORDER BY id
      `).all(poId);
      assert.deepEqual(acceptedLines.map((item) => item.quantity_received), [0, 0, 0]);
      assert.deepEqual(acceptedLines.map((item) => item.quantity_accepted), [8, 2, 1]);
      assert.deepEqual(acceptedLines.map((item) => item.total_price), [120000, 160000, 250000]);

      const audit = await db.prepare(`
        SELECT details FROM audit_logs
        WHERE entity_type = 'service_entry_sheet' AND entity_id = ? AND action = 'ACCEPTED'
      `).get(ses.sesId);
      assert.match(audit.details, /service delivered/i);
      assert.match(audit.details, /8 hours/);
      assert.match(audit.details, /2 days/);
      assert.match(audit.details, /1 lump sum/);

      const invoice = await createVendorInvoice(db, {
        invoice_number: 'INV-AAD-SVC-1',
        po_id: poId,
        supplier_id: 1,
        invoice_date: '2026-10-04',
        due_date: '2026-11-03',
        tax_amount: 0,
        items: poItems.map((item) => ({
          po_item_id: item.id,
          description: item.item_description,
          quantity_invoiced: item.quantity,
          unit_price: item.unit_price
        }))
      });
      assert.equal(invoice.matchOutcome.overallMatchStatus, 'perfect_match');
      assert.equal(invoice.matchOutcome.invoiceStatus, 'matched');
      const stillNoGrn = await db.prepare(`SELECT COUNT(*) AS cnt FROM goods_receipts WHERE po_id = ?`).get(poId);
      assert.equal(stillNoGrn.cnt, 0);
    });
  });

  test('a service invoice does not demand a GRN before acceptance', async () => {
    const db = await createTestDb();
    const app = createApp({ db, config: loadDbConfig({}) });

    await withServer(app, async (base) => {
      const created = await postRequisition(base, [serviceLines[0]]);
      await approveAll(db, created.id);
      const converted = await convertRequisitionToPurchaseOrders(db, {
        requisition_id: created.id,
        created_by: 3
      });
      const poId = converted[0].poId;
      const poItem = await db.prepare(`SELECT * FROM po_items WHERE po_id = ?`).get(poId);

      const invoice = await createVendorInvoice(db, {
        invoice_number: 'INV-AAD-EARLY',
        po_id: poId,
        supplier_id: 1,
        invoice_date: '2026-10-02',
        due_date: '2026-11-01',
        items: [{
          po_item_id: poItem.id,
          description: poItem.item_description,
          quantity_invoiced: 8,
          unit_price: 15000
        }]
      });
      assert.equal(invoice.matchOutcome.overallMatchStatus, 'quantity_variance');
      const line = invoice.matchOutcome.matchEntries[0];
      assert.equal(line.received_qty, 0);
      assert.match(line.message, /accepted on SES/i);
      assert.doesNotMatch(line.message, /GRN/);
      const poAfter = await db.prepare(`SELECT quantity_received, quantity_accepted FROM po_items WHERE id = ?`).get(poItem.id);
      assert.equal(poAfter.quantity_received, 0);
      assert.equal(poAfter.quantity_accepted, 0);
      const receipts = await db.prepare(`SELECT COUNT(*) AS cnt FROM goods_receipts`).get();
      assert.equal(receipts.cnt, 0);
    });
  });

  test('a goods line still requires a receipt before invoice match', async () => {
    const db = await createTestDb();
    const app = createApp({ db, config: loadDbConfig({}) });
    const goodsItem = {
      item_description: 'Copy paper',
      category: 'Office Supplies',
      quantity: 2,
      unit_price: 1000,
      estimated_supplier_id: 1,
      line_type: 'goods'
    };

    await withServer(app, async (base) => {
      const early = await postRequisition(base, [goodsItem], { justification: 'Paper before receipt' });
      await approveAll(db, early.id);
      const earlyPo = await convertRequisitionToPurchaseOrders(db, {
        requisition_id: early.id,
        created_by: 3
      });
      const earlyPoId = earlyPo[0].poId;
      const earlyLine = await db.prepare(`SELECT * FROM po_items WHERE po_id = ?`).get(earlyPoId);
      const blocked = await createVendorInvoice(db, {
        invoice_number: 'INV-WED-EARLY',
        po_id: earlyPoId,
        supplier_id: 1,
        invoice_date: '2026-10-02',
        due_date: '2026-11-01',
        items: [{
          po_item_id: earlyLine.id,
          description: earlyLine.item_description,
          quantity_invoiced: 2,
          unit_price: 1000
        }]
      });
      assert.equal(blocked.matchOutcome.overallMatchStatus, 'quantity_variance');
      assert.match(blocked.matchOutcome.matchEntries[0].message, /physically received on GRN/i);

      const later = await postRequisition(base, [goodsItem], { justification: 'Paper after receipt' });
      await approveAll(db, later.id);
      const laterPo = await convertRequisitionToPurchaseOrders(db, {
        requisition_id: later.id,
        created_by: 3
      });
      const laterPoId = laterPo[0].poId;
      const laterLine = await db.prepare(`SELECT * FROM po_items WHERE po_id = ?`).get(laterPoId);
      const grn = await createGoodsReceipt(db, {
        po_id: laterPoId,
        received_by: 3,
        receipt_date: '2026-10-03',
        items: [{ po_item_id: laterLine.id, quantity_received: 2, condition: 'good' }]
      });
      assert.match(grn.grnNumber, /^GRN-/);
      const matched = await createVendorInvoice(db, {
        invoice_number: 'INV-WED-OK',
        po_id: laterPoId,
        supplier_id: 1,
        invoice_date: '2026-10-04',
        due_date: '2026-11-03',
        items: [{
          po_item_id: laterLine.id,
          description: laterLine.item_description,
          quantity_invoiced: 2,
          unit_price: 1000
        }]
      });
      assert.equal(matched.matchOutcome.overallMatchStatus, 'perfect_match');
      const received = await db.prepare(`SELECT quantity_received FROM po_items WHERE id = ?`).get(laterLine.id);
      assert.equal(received.quantity_received, 2);
    });
  });
});
