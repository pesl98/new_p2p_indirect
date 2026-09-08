import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMemoryDatabase } from './db.js';
import { createApp } from './app.js';
import { loadDbConfig } from './dbConfig.js';

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
    INSERT INTO users (id, name, email, role, department_id, title) VALUES
      (1, 'Alice Chen', 'alice@example.com', 'requester', 1, 'Specialist'),
      (3, 'Carol Zhang', 'carol@example.com', 'procurement', 1, 'Sourcing');
    INSERT INTO suppliers (id, name, code, contact_person, email, phone, address, payment_terms, status)
      VALUES
        (1, 'TechSupply Global', 'SUP-TSG', 'Marcus Vance', 'enterprise@techsupply.com', '+1 555 0100', '100 Silicon Way', 'Net 30', 'active'),
        (2, 'CloudCore Software LLC', 'SUP-CCS', 'Sarah Connor', 'billing@cloudcore.io', '+1 555 0101', '500 Cloud Vista', 'Net 30', 'active');
    INSERT INTO catalog_items (id, sku, name, description, category, unit, unit_price, preferred_supplier_id, lead_time_days, line_type, status)
      VALUES
        (1, 'SKU-HW-001', 'MacBook Pro', 'Laptop', 'IT Hardware', 'each', 349900, 1, 3, 'goods', 'active'),
        (2, 'SKU-OFF-001', 'Aeron Chair', 'Chair', 'Office Supplies', 'each', 129500, 2, 7, 'goods', 'active');
  `);
  return db;
}

async function json(response) {
  return { status: response.status, body: await response.json() };
}

describe('supplier master data', () => {
  test('PATCH updates fields and keeps code immutable', async () => {
    const db = await createTestDb();
    const app = createApp({ db, config: loadDbConfig({}) });

    await withServer(app, async (base) => {
      const { status, body } = await json(await fetch(`${base}/api/suppliers/1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'TechSupply Global Inc',
          contact_person: 'New Contact',
          email: 'new@techsupply.com',
          phone: '+1 555 9999',
          address: '200 New Way',
          payment_terms: 'Net 45',
          code: 'SUP-HACK'
        })
      }));
      assert.equal(status, 400);
      assert.match(body.error, /immutable/i);

      const ok = await json(await fetch(`${base}/api/suppliers/1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'TechSupply Global Inc',
          contact_person: 'New Contact',
          email: 'new@techsupply.com',
          phone: '+1 555 9999',
          address: '200 New Way',
          payment_terms: 'Net 45'
        })
      }));
      assert.equal(ok.status, 200, ok.body.error);
      assert.equal(ok.body.name, 'TechSupply Global Inc');
      assert.equal(ok.body.code, 'SUP-TSG');
      assert.equal(ok.body.contact_person, 'New Contact');
      assert.equal(ok.body.email, 'new@techsupply.com');
      assert.equal(ok.body.payment_terms, 'Net 45');
      assert.equal(ok.body.address, '200 New Way');
    });
  });

  test('PATCH status deactivates without deleting historical rows and warns on preferred catalog', async () => {
    const db = await createTestDb();
    db.exec(`
      INSERT INTO purchase_orders (po_number, supplier_id, created_by, status, total_amount, issue_date)
      VALUES ('PO-2026-900', 1, 3, 'issued', 1000, '2026-09-01');
    `);
    const app = createApp({ db, config: loadDbConfig({}) });

    await withServer(app, async (base) => {
      const { status, body } = await json(await fetch(`${base}/api/suppliers/1/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'inactive' })
      }));
      assert.equal(status, 200, body.error);
      assert.equal(body.status, 'inactive');
      assert.ok(Array.isArray(body.warnings) && body.warnings.length >= 1);
      assert.match(body.warnings[0], /preferred/i);

      const row = db.prepare(`SELECT status FROM suppliers WHERE id = 1`).get();
      assert.equal(row.status, 'inactive');
      const po = db.prepare(`SELECT COUNT(*) AS n FROM purchase_orders WHERE supplier_id = 1`).get();
      assert.equal(po.n, 1);

      const listed = await json(await fetch(`${base}/api/suppliers?status=active`));
      assert.equal(listed.status, 200);
      assert.equal(listed.body.some((s) => s.id === 1), false);
      assert.equal(listed.body.some((s) => s.id === 2), true);

      const all = await json(await fetch(`${base}/api/suppliers`));
      const inactive = all.body.find((s) => s.id === 1);
      assert.ok(inactive);
      assert.equal(inactive.status, 'inactive');
    });
  });

  test('POST unique code conflict is 409 and DELETE is 405', async () => {
    const db = await createTestDb();
    const app = createApp({ db, config: loadDbConfig({}) });

    await withServer(app, async (base) => {
      const conflict = await json(await fetch(`${base}/api/suppliers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Clone', code: 'SUP-TSG' })
      }));
      assert.equal(conflict.status, 409);
      assert.match(conflict.body.error, /code already exists/i);

      const del = await json(await fetch(`${base}/api/suppliers/1`, { method: 'DELETE' }));
      assert.equal(del.status, 405);
      assert.match(del.body.error, /deactivate/i);
      const still = db.prepare(`SELECT id FROM suppliers WHERE id = 1`).get();
      assert.ok(still);
    });
  });

  test('rejects invalid status values', async () => {
    const db = await createTestDb();
    const app = createApp({ db, config: loadDbConfig({}) });

    await withServer(app, async (base) => {
      const { status, body } = await json(await fetch(`${base}/api/suppliers/1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'deleted' })
      }));
      assert.equal(status, 400);
      assert.match(body.error, /invalid supplier status/i);
    });
  });
});

describe('catalog master data', () => {
  test('PATCH updates fields including unique sku and integer cents', async () => {
    const db = await createTestDb();
    const app = createApp({ db, config: loadDbConfig({}) });

    await withServer(app, async (base) => {
      const { status, body } = await json(await fetch(`${base}/api/catalog/1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: 'SKU-HW-001B',
          name: 'MacBook Pro 16',
          description: 'Updated',
          category: 'IT Hardware',
          unit: 'each',
          unit_price: 359900,
          preferred_supplier_id: 2,
          lead_time_days: 5,
          image_url: '💻',
          line_type: 'goods'
        })
      }));
      assert.equal(status, 200, body.error);
      assert.equal(body.sku, 'SKU-HW-001B');
      assert.equal(body.name, 'MacBook Pro 16');
      assert.equal(body.unit_price, 359900);
      assert.equal(body.preferred_supplier_id, 2);
      assert.equal(body.lead_time_days, 5);
      assert.equal(body.status, 'active');
    });
  });

  test('unique sku conflict is 409; default list hides inactive; admin status=all shows them', async () => {
    const db = await createTestDb();
    const app = createApp({ db, config: loadDbConfig({}) });

    await withServer(app, async (base) => {
      const conflict = await json(await fetch(`${base}/api/catalog/2`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku: 'SKU-HW-001' })
      }));
      assert.equal(conflict.status, 409);
      assert.match(conflict.body.error, /sku already exists/i);

      const createConflict = await json(await fetch(`${base}/api/catalog`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: 'SKU-HW-001',
          name: 'Duplicate',
          category: 'IT Hardware',
          unit_price: 100
        })
      }));
      assert.equal(createConflict.status, 409);
      assert.match(createConflict.body.error, /sku already exists/i);

      const deactivated = await json(await fetch(`${base}/api/catalog/1/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'inactive' })
      }));
      assert.equal(deactivated.status, 200, deactivated.body.error);
      assert.equal(deactivated.body.status, 'inactive');

      const browse = await json(await fetch(`${base}/api/catalog`));
      assert.equal(browse.body.some((item) => item.id === 1), false);
      assert.equal(browse.body.some((item) => item.id === 2), true);

      const admin = await json(await fetch(`${base}/api/catalog?status=all`));
      const inactive = admin.body.find((item) => item.id === 1);
      assert.ok(inactive);
      assert.equal(inactive.status, 'inactive');

      const del = await json(await fetch(`${base}/api/catalog/1`, { method: 'DELETE' }));
      assert.equal(del.status, 405);
      const still = db.prepare(`SELECT id, status FROM catalog_items WHERE id = 1`).get();
      assert.equal(still.status, 'inactive');
    });
  });

  test('blocks assigning an inactive supplier as preferred on create/edit; allows keep-existing', async () => {
    const db = await createTestDb();
    db.exec(`UPDATE suppliers SET status = 'inactive' WHERE id = 1`);
    const app = createApp({ db, config: loadDbConfig({}) });

    await withServer(app, async (base) => {
      const createBlocked = await json(await fetch(`${base}/api/catalog`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: 'SKU-HW-099',
          name: 'Dock',
          category: 'IT Hardware',
          unit_price: 19900,
          preferred_supplier_id: 1
        })
      }));
      assert.equal(createBlocked.status, 400);
      assert.match(createBlocked.body.error, /cannot be newly assigned/i);

      const changeBlocked = await json(await fetch(`${base}/api/catalog/2`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferred_supplier_id: 1 })
      }));
      assert.equal(changeBlocked.status, 400);
      assert.match(changeBlocked.body.error, /cannot be newly assigned/i);

      const keepExisting = await json(await fetch(`${base}/api/catalog/1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'MacBook Pro refreshed', preferred_supplier_id: 1 })
      }));
      assert.equal(keepExisting.status, 200, keepExisting.body.error);
      assert.equal(keepExisting.body.name, 'MacBook Pro refreshed');
      assert.equal(keepExisting.body.preferred_supplier_id, 1);
    });
  });

  test('applySchema exposes catalog_items.status for new databases', async () => {
    const db = await createTestDb();
    const cols = db.prepare(`PRAGMA table_info(catalog_items)`).all();
    assert.ok(cols.some((col) => col.name === 'status'));
  });
});
