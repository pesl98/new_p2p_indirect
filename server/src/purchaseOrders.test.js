import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from './db.js';
import http from 'node:http';
import { createApp } from './app.js';
import { loadDbConfig } from './dbConfig.js';
import {
  convertRequisitionToPurchaseOrders,
  PurchaseOrderError,
  resolveRequisitionItemSupplier,
  groupItemsBySupplier,
  annotateResolvedSupplier,
  listSupplierRemaps
} from './purchaseOrdersService.js';

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
    INSERT INTO departments (id, code, name) VALUES (1, 'MKT', 'Marketing');
    INSERT INTO users (id, name, email, role, department_id, title)
      VALUES (1, 'Alice Chen', 'alice@example.com', 'requester', 1, 'Specialist'),
             (3, 'Carol Zhang', 'carol@example.com', 'procurement', 1, 'Sourcing');
    INSERT INTO suppliers (id, name, code, payment_terms)
      VALUES (1, 'TechSupply Global', 'SUP-TSG', 'Net 30'),
             (2, 'CloudCore Software LLC', 'SUP-CCS', 'Net 30'),
             (3, 'WorkSpace Ergonomics Depot', 'SUP-WED', 'Net 45');
    INSERT INTO catalog_items (id, sku, name, category, unit_price, preferred_supplier_id, line_type)
      VALUES (1, 'SKU-HW-001', 'MacBook Pro', 'IT Hardware', 349900, 1, 'goods'),
             (2, 'SKU-OFF-001', 'Aeron Chair', 'Office Supplies', 129500, 3, 'goods'),
             (3, 'SKU-SW-001', 'Figma License', 'Software & Cloud', 54000, 2, 'service');
  `);
  return db;
}

function insertApprovedPr(db, { items, status = 'approved', prNumber = 'PR-2026-100', total } = {}) {
  const amount = total ?? items.reduce((sum, item) => sum + item.total_price, 0);
  const pr = db.prepare(`
    INSERT INTO purchase_requisitions (pr_number, requester_id, department_id, status, total_amount, justification, needed_by_date)
    VALUES (?, 1, 1, ?, ?, 'Test PR', '2026-10-01')
  `).run(prNumber, status, amount);
  const prId = Number(pr.lastInsertRowid);

  const insertItem = db.prepare(`
    INSERT INTO requisition_items (
      requisition_id, catalog_item_id, item_description, category, quantity,
      unit_price, total_price, estimated_supplier_id, line_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const itemIds = [];
  for (const item of items) {
    const result = insertItem.run(
      prId,
      item.catalog_item_id ?? null,
      item.item_description,
      item.category,
      item.quantity,
      item.unit_price,
      item.total_price,
      item.estimated_supplier_id ?? null,
      item.line_type || 'goods'
    );
    itemIds.push(Number(result.lastInsertRowid));
  }

  return { prId, itemIds };
}

describe('supplier resolution', () => {
  test('prefers convert-time mapping, then estimated, then catalog preferred', async () => {
    assert.equal(
      resolveRequisitionItemSupplier(
        { id: 1, estimated_supplier_id: 2, catalog_preferred_supplier_id: 3 },
        { mappingSupplierId: 1 }
      ),
      1
    );
    assert.equal(
      resolveRequisitionItemSupplier({ id: 1, estimated_supplier_id: 2, catalog_preferred_supplier_id: 3 }),
      2
    );
    assert.equal(
      resolveRequisitionItemSupplier({ id: 1, estimated_supplier_id: null, catalog_preferred_supplier_id: 3 }),
      3
    );
    assert.equal(
      resolveRequisitionItemSupplier({ id: 1, estimated_supplier_id: null }),
      null
    );
  });

  test('does not invent a vendor when grouping unresolved lines', async () => {
    const { groups, unresolved } = groupItemsBySupplier([
      { id: 1, item_description: 'Mystery', estimated_supplier_id: null }
    ]);
    assert.equal(groups.size, 0);
    assert.equal(unresolved.length, 1);
  });

  test('annotateResolvedSupplier uses estimated then catalog preferred', async () => {
    const fromEstimated = annotateResolvedSupplier({
      id: 1,
      estimated_supplier_id: 2,
      estimated_supplier_name: 'CloudCore Software LLC',
      catalog_preferred_supplier_id: 3,
      catalog_preferred_supplier_name: 'WorkSpace Ergonomics Depot'
    });
    assert.equal(fromEstimated.resolved_supplier_id, 2);
    assert.equal(fromEstimated.resolved_supplier_name, 'CloudCore Software LLC');

    const fromCatalog = annotateResolvedSupplier({
      id: 2,
      estimated_supplier_id: null,
      catalog_preferred_supplier_id: 3,
      catalog_preferred_supplier_name: 'WorkSpace Ergonomics Depot'
    });
    assert.equal(fromCatalog.resolved_supplier_id, 3);
    assert.equal(fromCatalog.resolved_supplier_name, 'WorkSpace Ergonomics Depot');

    const missing = annotateResolvedSupplier({ id: 3, estimated_supplier_id: null });
    assert.equal(missing.resolved_supplier_id, null);
    assert.equal(missing.resolved_supplier_name, null);
  });

  test('listSupplierRemaps ignores mappings that match the default vendor', async () => {
    const remaps = listSupplierRemaps(
      [
        { id: 10, item_description: 'Monitor', estimated_supplier_id: 1 },
        { id: 11, item_description: 'Chair', estimated_supplier_id: 3 }
      ],
      [
        { requisition_item_id: 10, supplier_id: 1 },
        { requisition_item_id: 11, supplier_id: 2 }
      ]
    );
    assert.equal(remaps.length, 1);
    assert.equal(remaps[0].requisition_item_id, 11);
    assert.equal(remaps[0].from_supplier_id, 3);
    assert.equal(remaps[0].to_supplier_id, 2);
  });
});

describe('convert approved PR to purchase orders', () => {
  test('single-supplier PR creates exactly one PO with the PR total', async () => {
    const db = await createTestDb();
    const { prId, itemIds } = await insertApprovedPr(db, {
      items: [
        {
          catalog_item_id: 1,
          item_description: 'MacBook Pro',
          category: 'IT Hardware',
          quantity: 1,
          unit_price: 349900,
          total_price: 349900,
          estimated_supplier_id: 1
        },
        {
          catalog_item_id: 1,
          item_description: 'MacBook Pro stand',
          category: 'IT Hardware',
          quantity: 1,
          unit_price: 74900,
          total_price: 74900,
          estimated_supplier_id: 1
        }
      ]
    });

    const created = await convertRequisitionToPurchaseOrders(db, { requisition_id: prId, created_by: 3 });
    assert.equal(created.length, 1);
    assert.equal(created[0].poNumber, 'PO-2026-001');
    assert.equal(created[0].supplier_id, 1);
    assert.equal(created[0].total_amount, 424800);
    assert.equal(created[0].item_count, 2);

    const pos = db.prepare(`SELECT * FROM purchase_orders WHERE requisition_id = ?`).all(prId);
    assert.equal(pos.length, 1);
    assert.equal(pos[0].total_amount, 424800);
    assert.equal(pos[0].status, 'issued');

    const poItems = db.prepare(`SELECT * FROM po_items WHERE po_id = ? ORDER BY id`).all(pos[0].id);
    assert.equal(poItems.length, 2);
    assert.deepEqual(poItems.map((row) => row.requisition_item_id), itemIds);

    const pr = db.prepare(`SELECT status FROM purchase_requisitions WHERE id = ?`).get(prId);
    assert.equal(pr.status, 'converted_to_po');
  });

  test('multi-supplier PR creates one issued PO per supplier with correct lines and totals', async () => {
    const db = await createTestDb();
    const { prId, itemIds } = await insertApprovedPr(db, {
      prNumber: 'PR-2026-200',
      items: [
        {
          catalog_item_id: 1,
          item_description: 'MacBook Pro',
          category: 'IT Hardware',
          quantity: 1,
          unit_price: 349900,
          total_price: 349900,
          estimated_supplier_id: 1
        },
        {
          catalog_item_id: 2,
          item_description: 'Aeron Chair',
          category: 'Office Supplies',
          quantity: 2,
          unit_price: 129500,
          total_price: 259000,
          estimated_supplier_id: 3
        },
        {
          catalog_item_id: 3,
          item_description: 'Figma License',
          category: 'Software & Cloud',
          quantity: 1,
          unit_price: 54000,
          total_price: 54000,
          estimated_supplier_id: 2,
          line_type: 'service'
        }
      ]
    });

    const created = await convertRequisitionToPurchaseOrders(db, { requisition_id: prId, created_by: 3 });
    assert.equal(created.length, 3);
    assert.deepEqual(created.map((po) => po.poNumber), ['PO-2026-001', 'PO-2026-002', 'PO-2026-003']);
    assert.deepEqual(created.map((po) => po.supplier_id), [1, 3, 2]);
    assert.deepEqual(created.map((po) => po.total_amount), [349900, 259000, 54000]);

    const pos = db.prepare(`
      SELECT po.*, s.name as supplier_name
      FROM purchase_orders po
      JOIN suppliers s ON po.supplier_id = s.id
      WHERE po.requisition_id = ?
      ORDER BY po.id
    `).all(prId);
    assert.equal(pos.length, 3);
    assert.ok(pos.every((po) => po.status === 'issued'));
    assert.ok(pos.every((po) => po.requisition_id === prId));

    const techItems = db.prepare(`SELECT * FROM po_items WHERE po_id = ?`).all(pos[0].id);
    assert.equal(techItems.length, 1);
    assert.equal(techItems[0].requisition_item_id, itemIds[0]);
    assert.equal(techItems[0].total_price, 349900);

    const chairItems = db.prepare(`SELECT * FROM po_items WHERE po_id = ?`).all(pos[1].id);
    assert.equal(chairItems.length, 1);
    assert.equal(chairItems[0].requisition_item_id, itemIds[1]);
    assert.equal(chairItems[0].quantity, 2);
    assert.equal(chairItems[0].total_price, 259000);

    const figmaItems = db.prepare(`SELECT * FROM po_items WHERE po_id = ?`).all(pos[2].id);
    assert.equal(figmaItems.length, 1);
    assert.equal(figmaItems[0].line_type, 'service');
    assert.equal(figmaItems[0].requisition_item_id, itemIds[2]);

    const pr = db.prepare(`SELECT status FROM purchase_requisitions WHERE id = ?`).get(prId);
    assert.equal(pr.status, 'converted_to_po');

    const splitAudit = db.prepare(`
      SELECT * FROM audit_logs
      WHERE entity_type = 'requisition' AND entity_id = ? AND action = 'SPLIT_CONVERTED_TO_PO'
    `).get(prId);
    assert.ok(splitAudit);
    assert.match(splitAudit.details, /PO-2026-001/);
    assert.match(splitAudit.details, /PO-2026-002/);
    assert.match(splitAudit.details, /PO-2026-003/);
    assert.match(splitAudit.details, /TechSupply Global/);
    assert.match(splitAudit.details, /WorkSpace Ergonomics Depot/);
    assert.match(splitAudit.details, /CloudCore Software LLC/);
  });

  test('uses catalog preferred_supplier_id when estimated_supplier_id is null', async () => {
    const db = await createTestDb();
    const { prId } = await insertApprovedPr(db, {
      items: [
        {
          catalog_item_id: 2,
          item_description: 'Aeron Chair',
          category: 'Office Supplies',
          quantity: 1,
          unit_price: 129500,
          total_price: 129500,
          estimated_supplier_id: null
        }
      ]
    });

    const created = await convertRequisitionToPurchaseOrders(db, { requisition_id: prId, created_by: 3 });
    assert.equal(created.length, 1);
    assert.equal(created[0].supplier_id, 3);
  });

  test('convert-time mapping remaps a line onto another vendor and collapses the split', async () => {
    const db = await createTestDb();
    const { prId, itemIds } = await insertApprovedPr(db, {
      items: [
        {
          catalog_item_id: 1,
          item_description: 'MacBook Pro',
          category: 'IT Hardware',
          quantity: 1,
          unit_price: 349900,
          total_price: 349900,
          estimated_supplier_id: 1
        },
        {
          catalog_item_id: 2,
          item_description: 'Aeron Chair',
          category: 'Office Supplies',
          quantity: 1,
          unit_price: 129500,
          total_price: 129500,
          estimated_supplier_id: 3
        }
      ]
    });

    const created = await convertRequisitionToPurchaseOrders(db, {
      requisition_id: prId,
      created_by: 3,
      supplier_mappings: [{ requisition_item_id: itemIds[1], supplier_id: 1 }]
    });
    assert.equal(created.length, 1);
    assert.equal(created[0].supplier_id, 1);
    assert.equal(created[0].total_amount, 479400);
    assert.equal(created[0].item_count, 2);

    const poItems = db.prepare(`SELECT requisition_item_id FROM po_items WHERE po_id = ? ORDER BY id`).all(created[0].poId);
    assert.deepEqual(poItems.map((row) => row.requisition_item_id), itemIds);

    const audit = db.prepare(`
      SELECT * FROM audit_logs
      WHERE entity_type = 'requisition' AND entity_id = ? AND action = 'CONVERTED_TO_PO'
    `).get(prId);
    assert.ok(audit);
    assert.match(audit.details, /Convert remaps/);
    assert.match(audit.details, /Aeron Chair/);
    assert.match(audit.details, /WorkSpace Ergonomics Depot/);
    assert.match(audit.details, /TechSupply Global/);
  });

  test('explicit convert-time mapping can supply a missing vendor', async () => {
    const db = await createTestDb();
    const { prId, itemIds } = await insertApprovedPr(db, {
      items: [
        {
          catalog_item_id: null,
          item_description: 'Ad-hoc whiteboard',
          category: 'Office Supplies',
          quantity: 1,
          unit_price: 34900,
          total_price: 34900,
          estimated_supplier_id: null
        }
      ]
    });

    const created = await convertRequisitionToPurchaseOrders(db, {
      requisition_id: prId,
      created_by: 3,
      supplier_mappings: [{ requisition_item_id: itemIds[0], supplier_id: 3 }]
    });
    assert.equal(created[0].supplier_id, 3);
  });

  test('fails closed with 400 when any line has no resolvable supplier', async () => {
    const db = await createTestDb();
    const { prId } = await insertApprovedPr(db, {
      items: [
        {
          catalog_item_id: 1,
          item_description: 'MacBook Pro',
          category: 'IT Hardware',
          quantity: 1,
          unit_price: 349900,
          total_price: 349900,
          estimated_supplier_id: 1
        },
        {
          catalog_item_id: null,
          item_description: 'Mystery service',
          category: 'Consulting & Professional Services',
          quantity: 1,
          unit_price: 10000,
          total_price: 10000,
          estimated_supplier_id: null,
          line_type: 'service'
        }
      ]
    });

    assert.rejects(
      async () => convertRequisitionToPurchaseOrders(db, { requisition_id: prId, created_by: 3 }),
      (err) => err instanceof PurchaseOrderError && err.statusCode === 400 && /no resolvable supplier/i.test(err.message)
    );

    const pr = db.prepare(`SELECT status FROM purchase_requisitions WHERE id = ?`).get(prId);
    assert.equal(pr.status, 'approved');
    const poCount = db.prepare(`SELECT COUNT(*) AS cnt FROM purchase_orders WHERE requisition_id = ?`).get(prId);
    assert.equal(poCount.cnt, 0);
  });

  test('fails closed when the resolved supplier is inactive', async () => {
    const db = await createTestDb();
    db.exec(`UPDATE suppliers SET status = 'inactive' WHERE id = 1`);
    const { prId } = await insertApprovedPr(db, {
      items: [
        {
          catalog_item_id: 1,
          item_description: 'MacBook Pro',
          category: 'IT Hardware',
          quantity: 1,
          unit_price: 349900,
          total_price: 349900,
          estimated_supplier_id: 1
        }
      ]
    });

    await assert.rejects(
      async () => convertRequisitionToPurchaseOrders(db, { requisition_id: prId, created_by: 3 }),
      (err) => err instanceof PurchaseOrderError && err.statusCode === 400 && /inactive/i.test(err.message)
    );

    const pr = db.prepare(`SELECT status FROM purchase_requisitions WHERE id = ?`).get(prId);
    assert.equal(pr.status, 'approved');
    const poCount = db.prepare(`SELECT COUNT(*) AS cnt FROM purchase_orders WHERE requisition_id = ?`).get(prId);
    assert.equal(poCount.cnt, 0);
  });

  test('does not invent a vendor from a leftover header-level supplier_id', async () => {
    const db = await createTestDb();
    const { prId } = await insertApprovedPr(db, {
      items: [
        {
          catalog_item_id: null,
          item_description: 'Unassigned item',
          category: 'Office Supplies',
          quantity: 1,
          unit_price: 1000,
          total_price: 1000,
          estimated_supplier_id: null
        }
      ]
    });

    assert.rejects(
      async () => convertRequisitionToPurchaseOrders(db, {
        requisition_id: prId,
        created_by: 3,
        supplier_id: 1
      }),
      (err) => err instanceof PurchaseOrderError && err.statusCode === 400
    );
    const poCount = db.prepare(`SELECT COUNT(*) AS cnt FROM purchase_orders`).get();
    assert.equal(poCount.cnt, 0);
  });

  test('PR status stays approved until the convert transaction succeeds', async () => {
    const db = await createTestDb();
    const { prId } = await insertApprovedPr(db, {
      status: 'pending_approval',
      items: [
        {
          catalog_item_id: 1,
          item_description: 'MacBook Pro',
          category: 'IT Hardware',
          quantity: 1,
          unit_price: 349900,
          total_price: 349900,
          estimated_supplier_id: 1
        }
      ]
    });

    assert.rejects(
      async () => convertRequisitionToPurchaseOrders(db, { requisition_id: prId, created_by: 3 }),
      (err) => err instanceof PurchaseOrderError && err.statusCode === 400 && /approved/i.test(err.message)
    );

    const pr = db.prepare(`SELECT status FROM purchase_requisitions WHERE id = ?`).get(prId);
    assert.equal(pr.status, 'pending_approval');
    assert.equal(db.prepare(`SELECT COUNT(*) AS cnt FROM purchase_orders`).get().cnt, 0);
  });

  test('already-converted PR cannot be converted again', async () => {
    const db = await createTestDb();
    const { prId } = await insertApprovedPr(db, {
      items: [
        {
          catalog_item_id: 1,
          item_description: 'MacBook Pro',
          category: 'IT Hardware',
          quantity: 1,
          unit_price: 349900,
          total_price: 349900,
          estimated_supplier_id: 1
        }
      ]
    });

    await convertRequisitionToPurchaseOrders(db, { requisition_id: prId, created_by: 3 });
    assert.rejects(
      async () => convertRequisitionToPurchaseOrders(db, { requisition_id: prId, created_by: 3 }),
      (err) => err instanceof PurchaseOrderError && err.statusCode === 400
    );
    assert.equal(db.prepare(`SELECT COUNT(*) AS cnt FROM purchase_orders WHERE requisition_id = ?`).get(prId).cnt, 1);
  });

  test('allocates PO numbers via MAX suffix across the split', async () => {
    const db = await createTestDb();
    db.prepare(`
      INSERT INTO purchase_orders (po_number, supplier_id, created_by, status, total_amount, issue_date)
      VALUES ('PO-2026-004', 1, 3, 'issued', 100, '2026-09-01')
    `).run();

    const { prId } = await insertApprovedPr(db, {
      items: [
        {
          catalog_item_id: 1,
          item_description: 'MacBook Pro',
          category: 'IT Hardware',
          quantity: 1,
          unit_price: 349900,
          total_price: 349900,
          estimated_supplier_id: 1
        },
        {
          catalog_item_id: 2,
          item_description: 'Aeron Chair',
          category: 'Office Supplies',
          quantity: 1,
          unit_price: 129500,
          total_price: 129500,
          estimated_supplier_id: 3
        }
      ]
    });

    const created = await convertRequisitionToPurchaseOrders(db, { requisition_id: prId, created_by: 3 });
    assert.deepEqual(created.map((po) => po.poNumber), ['PO-2026-005', 'PO-2026-006']);
  });
});

describe('POST /api/purchase-orders/from-requisition', () => {
  test('accepts supplier_mappings and returns the issued PO list', async () => {
    const db = await createTestDb();
    const { prId, itemIds } = await insertApprovedPr(db, {
      items: [
        {
          catalog_item_id: 1,
          item_description: 'MacBook Pro',
          category: 'IT Hardware',
          quantity: 1,
          unit_price: 349900,
          total_price: 349900,
          estimated_supplier_id: 1
        },
        {
          catalog_item_id: 2,
          item_description: 'Aeron Chair',
          category: 'Office Supplies',
          quantity: 1,
          unit_price: 129500,
          total_price: 129500,
          estimated_supplier_id: 3
        }
      ]
    });
    const app = createApp({ db, config: loadDbConfig({}) });

    await withServer(app, async (base) => {
      const response = await fetch(`${base}/api/purchase-orders/from-requisition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requisition_id: prId,
          created_by: 3,
          supplier_mappings: [
            { requisition_item_id: itemIds[0], supplier_id: 1 },
            { requisition_item_id: itemIds[1], supplier_id: 2 }
          ]
        })
      });
      const body = await response.json();
      assert.equal(response.status, 201, body.error || 'expected 201');
      assert.equal(body.split, true);
      assert.equal(body.purchase_orders.length, 2);
      assert.deepEqual(body.purchase_orders.map((po) => po.supplier_id), [1, 2]);
      assert.equal(body.purchase_orders[1].supplier_name, 'CloudCore Software LLC');
      assert.match(body.message, /2 purchase orders/i);

      const detail = await fetch(`${base}/api/requisitions/${prId}`);
      const pr = await detail.json();
      assert.equal(pr.status, 'converted_to_po');
      assert.equal(pr.items[0].resolved_supplier_id, 1);
      assert.equal(pr.purchase_orders.length, 2);
    });
  });

  test('fails closed with HTTP 400 when a line has no resolvable supplier', async () => {
    const db = await createTestDb();
    const { prId } = await insertApprovedPr(db, {
      items: [
        {
          catalog_item_id: null,
          item_description: 'Mystery service',
          category: 'Consulting & Professional Services',
          quantity: 1,
          unit_price: 10000,
          total_price: 10000,
          estimated_supplier_id: null,
          line_type: 'service'
        }
      ]
    });
    const app = createApp({ db, config: loadDbConfig({}) });

    await withServer(app, async (base) => {
      const response = await fetch(`${base}/api/purchase-orders/from-requisition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requisition_id: prId, created_by: 3 })
      });
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.match(body.error, /no resolvable supplier/i);
      assert.match(body.error, /Mystery service/);

      const pr = db.prepare(`SELECT status FROM purchase_requisitions WHERE id = ?`).get(prId);
      assert.equal(pr.status, 'approved');
    });
  });
});
