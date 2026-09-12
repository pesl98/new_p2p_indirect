import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMemoryDatabase } from './db.js';
import { createApp } from './app.js';
import { loadDbConfig } from './dbConfig.js';
import { getDocumentTrail } from './documentTrailService.js';
import {
  AMENDABLE_PO_STATUSES,
  applyPurchaseOrderChangeOrder,
  CHANGE_ORDER_AUDIT_ACTION,
  CHANGE_ORDER_INCREASE_CONFIRM_CENTS,
  ChangeOrderError,
  lineQtyFloor,
  listPurchaseOrderChangeOrders
} from './changeOrdersService.js';

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
    INSERT INTO departments (id, code, name) VALUES (1, 'MKT', 'Marketing'), (3, 'FAC', 'Facilities');
    INSERT INTO users (id, name, email, role, department_id, title)
      VALUES (1, 'Alice Chen', 'alice@example.com', 'requester', 1, 'Specialist'),
             (3, 'Carol Zhang', 'carol@example.com', 'procurement', 3, 'Sourcing'),
             (7, 'James Okonkwo', 'james@example.com', 'approver', 3, 'Facilities');
    INSERT INTO budgets (department_id, fiscal_year, total_budget, committed_amount, actual_spent)
      VALUES (1, 2026, 15000000, 500000, 100000),
             (3, 2026, 9500000, 267000, 0);
    INSERT INTO suppliers (id, name, code, payment_terms, status)
      VALUES (1, 'TechSupply Global', 'SUP-TSG', 'Net 30', 'active'),
             (4, 'FacilityCare & Janitorial Pro', 'SUP-FCJ', 'Net 30', 'active');
  `);
  return db;
}

function insertLinkedPo(db, {
  poId = 10,
  poNumber = 'PO-2026-100',
  prId = 20,
  prNumber = 'PR-2026-100',
  departmentId = 3,
  supplierId = 4,
  status = 'issued',
  quantity = 3,
  unitPrice = 89000,
  received = 0,
  accepted = 0,
  invoiced = 0,
  lineType = 'goods',
  category = 'Facilities & MRO',
  description = 'Blueair Pro XL'
} = {}) {
  const total = quantity * unitPrice;
  db.prepare(`
    INSERT INTO purchase_requisitions (id, pr_number, requester_id, department_id, status, total_amount, justification)
    VALUES (?, ?, 7, ?, 'converted_to_po', ?, 'Test PR')
  `).run(prId, prNumber, departmentId, total);
  db.prepare(`
    INSERT INTO purchase_orders (id, po_number, requisition_id, supplier_id, created_by, status, total_amount, issue_date)
    VALUES (?, ?, ?, ?, 3, ?, ?, '2026-09-03')
  `).run(poId, poNumber, prId, supplierId, status, total);
  const item = db.prepare(`
    INSERT INTO po_items (
      po_id, item_description, category, quantity, unit_price, total_price,
      quantity_received, quantity_accepted, quantity_invoiced, line_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(poId, description, category, quantity, unitPrice, total, received, accepted, invoiced, lineType);
  return { poId, prId, itemId: Number(item.lastInsertRowid), total };
}

function insertStandalonePo(db, overrides = {}) {
  const {
    poId = 11,
    poNumber = 'PO-2026-101',
    status = 'issued',
    quantity = 2,
    unitPrice = 54000,
    received = 0,
    accepted = 0,
    invoiced = 0,
    lineType = 'service',
    category = 'Software & Cloud',
    description = 'Figma License'
  } = overrides;
  const total = quantity * unitPrice;
  db.prepare(`
    INSERT INTO purchase_orders (id, po_number, requisition_id, supplier_id, created_by, status, total_amount, issue_date)
    VALUES (?, ?, NULL, 1, 3, ?, ?, '2026-09-02')
  `).run(poId, poNumber, status, total);
  const item = db.prepare(`
    INSERT INTO po_items (
      po_id, item_description, category, quantity, unit_price, total_price,
      quantity_received, quantity_accepted, quantity_invoiced, line_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(poId, description, category, quantity, unitPrice, total, received, accepted, invoiced, lineType);
  return { poId, itemId: Number(item.lastInsertRowid), total };
}

describe('change order helpers', () => {
  test('lineQtyFloor uses received for goods and accepted for services, vs invoiced', () => {
    assert.equal(lineQtyFloor({ line_type: 'goods', quantity_received: 2, quantity_accepted: 9, quantity_invoiced: 1 }), 2);
    assert.equal(lineQtyFloor({ line_type: 'goods', quantity_received: 2, quantity_invoiced: 4 }), 4);
    assert.equal(lineQtyFloor({ line_type: 'service', quantity_received: 9, quantity_accepted: 1, quantity_invoiced: 0 }), 1);
    assert.equal(lineQtyFloor({ category: 'Software & Cloud', quantity_accepted: 1, quantity_invoiced: 2 }), 2);
  });

  test('amendable statuses cover issued through received', () => {
    assert.deepEqual([...AMENDABLE_PO_STATUSES], [
      'issued',
      'acknowledged',
      'partially_received',
      'received'
    ]);
  });
});

describe('applyPurchaseOrderChangeOrder', () => {
  test('applies qty and unit-price change, recomputes cents totals, writes audit', async () => {
    const db = await createTestDb();
    const { poId, itemId } = insertStandalonePo(db);

    const result = await applyPurchaseOrderChangeOrder(db, poId, {
      reason: 'Add one Figma seat and adjust unit price',
      actor_name: 'Carol Zhang',
      lines: [{ po_item_id: itemId, quantity: 3, unit_price: 50000 }]
    });

    assert.equal(result.change_order.co_number, 'CO-2026-001');
    assert.equal(result.change_order.revision, 1);
    assert.equal(result.change_order.status, 'applied');
    assert.equal(result.change_order.before_total_cents, 108000);
    assert.equal(result.change_order.after_total_cents, 150000);
    assert.equal(result.change_order.delta_cents, 42000);
    assert.equal(result.budget_delta_cents, 0);

    const po = db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(poId);
    assert.equal(po.total_amount, 150000);
    assert.equal(po.revision, 1);
    assert.equal(po.change_order_count, 1);

    const line = db.prepare(`SELECT * FROM po_items WHERE id = ?`).get(itemId);
    assert.equal(line.quantity, 3);
    assert.equal(line.unit_price, 50000);
    assert.equal(line.total_price, 150000);

    const audit = db.prepare(`
      SELECT * FROM audit_logs WHERE entity_type = 'purchase_order' AND entity_id = ? AND action = ?
    `).get(poId, CHANGE_ORDER_AUDIT_ACTION);
    assert.ok(audit);
    assert.equal(audit.actor_name, 'Carol Zhang');
    assert.match(audit.details, /CO-2026-001/);
    assert.match(audit.details, /\$1080\.00 → \$1500\.00/);
  });

  test('rejects reduce below received, accepted, or invoiced qty', async () => {
    const db = await createTestDb();
    const goods = insertStandalonePo(db, {
      poId: 12,
      poNumber: 'PO-2026-102',
      lineType: 'goods',
      category: 'IT Hardware',
      description: 'Monitor',
      quantity: 4,
      unitPrice: 74900,
      received: 2,
      invoiced: 0
    });
    await assert.rejects(
      async () => applyPurchaseOrderChangeOrder(db, goods.poId, {
        reason: 'Cut undelivered',
        actor_name: 'Carol Zhang',
        lines: [{ po_item_id: goods.itemId, quantity: 1 }]
      }),
      (err) => err instanceof ChangeOrderError && err.statusCode === 400 && /received 2/.test(err.message)
    );

    const services = insertStandalonePo(db, {
      poId: 13,
      poNumber: 'PO-2026-103',
      quantity: 2,
      unitPrice: 54000,
      accepted: 1,
      invoiced: 0
    });
    await assert.rejects(
      async () => applyPurchaseOrderChangeOrder(db, services.poId, {
        reason: 'Cut seat',
        actor_name: 'Carol Zhang',
        lines: [{ po_item_id: services.itemId, quantity: 0 }]
      }),
      (err) => err instanceof ChangeOrderError && /accepted 1/.test(err.message)
    );

    const invoiced = insertStandalonePo(db, {
      poId: 14,
      poNumber: 'PO-2026-104',
      lineType: 'goods',
      category: 'IT Hardware',
      description: 'Mouse',
      quantity: 3,
      unitPrice: 9900,
      received: 2,
      invoiced: 3
    });
    await assert.rejects(
      async () => applyPurchaseOrderChangeOrder(db, invoiced.poId, {
        reason: 'Cut billed',
        actor_name: 'Carol Zhang',
        lines: [{ po_item_id: invoiced.itemId, quantity: 2 }]
      }),
      (err) => err instanceof ChangeOrderError && /invoiced 3/.test(err.message)
    );

    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM po_change_orders`).get().n, 0);
    assert.equal(db.prepare(`SELECT quantity FROM po_items WHERE id = ?`).get(goods.itemId).quantity, 4);
  });

  test('adjusts department budget committed by the delta and never touches actual_spent', async () => {
    const db = await createTestDb();
    const { poId, itemId } = insertLinkedPo(db);

    const before = db.prepare(`SELECT committed_amount, actual_spent FROM budgets WHERE department_id = 3`).get();
    assert.equal(before.committed_amount, 267000);
    assert.equal(before.actual_spent, 0);

    const reduced = await applyPurchaseOrderChangeOrder(db, poId, {
      reason: 'Volume discount',
      actor_name: 'Carol Zhang',
      lines: [{ po_item_id: itemId, unit_price: 85000 }]
    });
    assert.equal(reduced.change_order.after_total_cents, 255000);
    assert.equal(reduced.budget_delta_cents, -12000);

    let budget = db.prepare(`SELECT committed_amount, actual_spent FROM budgets WHERE department_id = 3`).get();
    assert.equal(budget.committed_amount, 255000);
    assert.equal(budget.actual_spent, 0);

    await applyPurchaseOrderChangeOrder(db, poId, {
      reason: 'Add a fourth unit',
      actor_name: 'Carol Zhang',
      lines: [{ po_item_id: itemId, quantity: 4 }]
    });
    budget = db.prepare(`SELECT committed_amount, actual_spent FROM budgets WHERE department_id = 3`).get();
    assert.equal(budget.committed_amount, 340000);
    assert.equal(budget.actual_spent, 0);

    db.prepare(`UPDATE budgets SET committed_amount = 5000 WHERE department_id = 3`).run();
    await applyPurchaseOrderChangeOrder(db, poId, {
      reason: 'Cancel remaining open qty',
      actor_name: 'Carol Zhang',
      lines: [{ po_item_id: itemId, quantity: 0, unit_price: 85000 }]
    });
    budget = db.prepare(`SELECT committed_amount, actual_spent FROM budgets WHERE department_id = 3`).get();
    assert.equal(budget.committed_amount, 0);
    assert.equal(budget.actual_spent, 0);
  });

  test('rejects empty or invalid payloads and closed POs', async () => {
    const db = await createTestDb();
    const { poId, itemId } = insertStandalonePo(db);

    await assert.rejects(
      async () => applyPurchaseOrderChangeOrder(db, poId, {
        actor_name: 'Carol Zhang',
        lines: [{ po_item_id: itemId, quantity: 3 }]
      }),
      (err) => err instanceof ChangeOrderError && /reason is required/i.test(err.message)
    );
    await assert.rejects(
      async () => applyPurchaseOrderChangeOrder(db, poId, {
        reason: 'noop',
        actor_name: 'Carol Zhang',
        lines: [{ po_item_id: itemId, quantity: 2, unit_price: 54000 }]
      }),
      (err) => /empty/i.test(err.message)
    );
    await assert.rejects(
      async () => applyPurchaseOrderChangeOrder(db, poId, {
        reason: 'no lines',
        actor_name: 'Carol Zhang',
        lines: []
      }),
      (err) => /empty/i.test(err.message)
    );
    await assert.rejects(
      async () => applyPurchaseOrderChangeOrder(db, poId, {
        reason: 'unknown line',
        actor_name: 'Carol Zhang',
        lines: [{ po_item_id: 9999, quantity: 1 }]
      }),
      (err) => /not a line/i.test(err.message)
    );
    await assert.rejects(
      async () => applyPurchaseOrderChangeOrder(db, poId, {
        reason: 'float price',
        actor_name: 'Carol Zhang',
        lines: [{ po_item_id: itemId, unit_price: 54000.5 }]
      }),
      (err) => /integer number of cents/i.test(err.message)
    );
    await assert.rejects(
      async () => applyPurchaseOrderChangeOrder(db, 404, {
        reason: 'missing',
        actor_name: 'Carol Zhang',
        lines: [{ po_item_id: 1, quantity: 1 }]
      }),
      (err) => err.statusCode === 404
    );

    db.prepare(`UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?`).run(poId);
    await assert.rejects(
      async () => applyPurchaseOrderChangeOrder(db, poId, {
        reason: 'too late',
        actor_name: 'Carol Zhang',
        lines: [{ po_item_id: itemId, quantity: 1 }]
      }),
      (err) => /cancelled/.test(err.message)
    );
  });

  test('large net increase requires confirm_increase', async () => {
    const db = await createTestDb();
    const { poId, itemId } = insertStandalonePo(db, { quantity: 1, unitPrice: 10000 });
    assert.equal(CHANGE_ORDER_INCREASE_CONFIRM_CENTS, 100000);

    await assert.rejects(
      async () => applyPurchaseOrderChangeOrder(db, poId, {
        reason: 'Big increase',
        actor_name: 'Carol Zhang',
        lines: [{ po_item_id: itemId, unit_price: 120000 }]
      }),
      (err) => err instanceof ChangeOrderError && /confirm_increase/i.test(err.message)
    );

    const result = await applyPurchaseOrderChangeOrder(db, poId, {
      reason: 'Big increase confirmed',
      actor_name: 'Carol Zhang',
      lines: [{ po_item_id: itemId, unit_price: 120000 }],
      confirm_increase: true
    });
    assert.equal(result.change_order.after_total_cents, 120000);
  });

  test('document trail surfaces CHANGE_ORDER_APPLIED when present and does not invent it', async () => {
    const db = await createTestDb();
    const { poId, itemId } = insertLinkedPo(db, {
      poId: 30,
      poNumber: 'PO-2026-130',
      prId: 30,
      prNumber: 'PR-2026-130'
    });

    const before = await getDocumentTrail(db, { po_number: 'PO-2026-130' });
    assert.equal(before.timeline.filter((event) => event.kind === 'change_order').length, 0);
    assert.equal(before.purchase_orders[0].change_order_events.length, 0);

    await applyPurchaseOrderChangeOrder(db, poId, {
      reason: 'Volume discount',
      actor_name: 'Carol Zhang',
      lines: [{ po_item_id: itemId, unit_price: 85000 }]
    });

    const after = await getDocumentTrail(db, { po_id: poId });
    const events = after.timeline.filter((event) => event.kind === 'change_order');
    assert.equal(events.length, 1);
    assert.equal(events[0].title, 'Change order applied');
    assert.equal(events[0].number, 'CO-2026-001');
    assert.equal(events[0].source, 'audit');
    assert.equal(events[0].actor_name, 'Carol Zhang');
    assert.equal(after.purchase_orders[0].change_order_events[0].action, CHANGE_ORDER_AUDIT_ACTION);
    assert.equal(after.purchase_orders[0].total_amount, 255000);
  });
});

describe('change order HTTP API', () => {
  test('GET history and POST apply', async () => {
    const db = await createTestDb();
    const { poId, itemId } = insertStandalonePo(db);
    const app = createApp({ db, config: loadDbConfig({}) });

    await withServer(app, async (base) => {
      const empty = await fetch(`${base}/api/purchase-orders/${poId}/change-orders`);
      assert.equal(empty.status, 200);
      const emptyBody = await empty.json();
      assert.equal(emptyBody.change_orders.length, 0);

      const created = await fetch(`${base}/api/purchase-orders/${poId}/change-orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: 'Add a seat',
          actor_name: 'Carol Zhang',
          lines: [{ po_item_id: itemId, quantity: 3 }]
        })
      });
      assert.equal(created.status, 201);
      const createdBody = await created.json();
      assert.equal(createdBody.change_order.co_number, 'CO-2026-001');
      assert.equal(createdBody.change_order.after_total_cents, 162000);

      const listed = await fetch(`${base}/api/purchase-orders/${poId}/change-orders`);
      const listedBody = await listed.json();
      assert.equal(listedBody.change_orders.length, 1);
      assert.equal(listedBody.change_orders[0].items[0].new_quantity, 3);

      const detail = await fetch(`${base}/api/purchase-orders/${poId}`);
      const detailBody = await detail.json();
      assert.equal(detailBody.change_orders.length, 1);
      assert.equal(detailBody.total_amount, 162000);
      assert.equal(detailBody.revision, 1);

      const bad = await fetch(`${base}/api/purchase-orders/${poId}/change-orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor_name: 'Carol Zhang', lines: [] })
      });
      assert.equal(bad.status, 400);
    });
  });

  test('list history helper returns 404 for unknown PO', async () => {
    const db = await createTestDb();
    await assert.rejects(
      async () => listPurchaseOrderChangeOrders(db, 999),
      (err) => err instanceof ChangeOrderError && err.statusCode === 404
    );
  });
});
