import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMemoryDatabase } from './db.js';
import { createApp } from './app.js';
import { loadDbConfig } from './dbConfig.js';
import { TursoHttpClient } from './tursoHttp.js';

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
      (2, 'Bob Martinez', 'bob@example.com', 'approver', 1, 'VP of Marketing'),
      (3, 'Carol Zhang', 'carol@example.com', 'procurement', 1, 'Sourcing'),
      (4, 'David Miller', 'david@example.com', 'finance', 1, 'Controller');
    INSERT INTO suppliers (id, name, code) VALUES (1, 'TechSupply Global', 'SUP-TSG');
    INSERT INTO catalog_items (id, sku, name, category, unit_price, preferred_supplier_id, line_type)
      VALUES (1, 'SKU-HW-001', 'MacBook Pro', 'IT Hardware', 349900, 1, 'goods');
    INSERT INTO budgets (department_id, fiscal_year, total_budget, committed_amount, actual_spent)
      VALUES (1, 2026, 15000000, 0, 0);
  `);
  return db;
}

function createPayload(overrides = {}) {
  return {
    requester_id: 1,
    department_id: 1,
    justification: 'New hire workstation and Q4 security audit',
    needed_by_date: '2026-09-20',
    priority: 'High',
    items: [
      {
        catalog_item_id: 1,
        item_description: 'MacBook Pro',
        category: 'IT Hardware',
        quantity: 1,
        unit_price: 349900,
        estimated_supplier_id: 1,
        line_type: 'goods'
      },
      {
        catalog_item_id: null,
        item_description: 'Q4 Security Audit',
        category: 'Consulting & Professional Services',
        quantity: 1,
        unit_price: 50000,
        estimated_supplier_id: 1,
        line_type: 'service'
      }
    ],
    ...overrides
  };
}

describe('POST /api/requisitions', () => {
  test('sqlite create persists a real PR id and catalog + ad-hoc line items', async () => {
    const db = await createTestDb();
    const app = createApp({ db, config: loadDbConfig({}) });

    await withServer(app, async (base) => {
      const response = await fetch(`${base}/api/requisitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createPayload())
      });
      const body = await response.json();
      assert.equal(response.status, 201, body.error || 'expected 201');
      assert.ok(Number(body.id) > 0, 'create must return a real new PR id');

      const detail = await fetch(`${base}/api/requisitions/${body.id}`);
      const pr = await detail.json();
      assert.equal(detail.status, 200);
      assert.equal(pr.status, 'draft');
      assert.equal(pr.total_amount, 399900);
      assert.equal(pr.items.length, 2);
      assert.equal(pr.items[0].catalog_item_id, 1);
      assert.equal(pr.items[0].unit_price, 349900);
      assert.equal(pr.items[0].resolved_supplier_id, 1);
      assert.equal(pr.items[0].resolved_supplier_name, 'TechSupply Global');
      assert.equal(pr.items[1].item_description, 'Q4 Security Audit');
      assert.equal(pr.items[1].line_type, 'service');
      assert.equal(pr.approvals.length, 0);
      assert.match(pr.pr_number, /^PR-\d{4}-\d{3}$/);
    });
  });

  test('submitImmediately builds the sequential approval chain', async () => {
    const db = await createTestDb();
    const app = createApp({ db, config: loadDbConfig({}) });

    await withServer(app, async (base) => {
      const response = await fetch(`${base}/api/requisitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createPayload({ submitImmediately: true }))
      });
      const body = await response.json();
      assert.equal(response.status, 201, body.error || 'expected 201');
      assert.ok(Number(body.id) > 0);

      const detail = await fetch(`${base}/api/requisitions/${body.id}`);
      const pr = await detail.json();
      assert.equal(pr.status, 'pending_approval');
      assert.ok(pr.approvals.length >= 2, 'amount > $1,000 adds procurement');
      assert.equal(pr.approvals[0].status, 'pending');
      assert.equal(pr.approvals[0].approver_id, 2);
      assert.equal(pr.approvals[1].status, 'waiting');
      assert.equal(pr.approvals[1].approver_id, 3);
    });
  });

  test('rejects an empty item list with 400', async () => {
    const db = await createTestDb();
    const app = createApp({ db, config: loadDbConfig({}) });

    await withServer(app, async (base) => {
      const response = await fetch(`${base}/api/requisitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createPayload({ items: [] }))
      });
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.match(body.error, /at least one line item/i);
    });
  });

  test('Turso lastInsertRowid 0 still persists lines via pr_number lookup', async () => {
    const memory = await createTestDb();
    const fetchImpl = async (_url, options) => {
      const body = JSON.parse(options.body);
      const results = [];
      for (const request of body.requests || []) {
        if (request.type === 'close') {
          results.push({ type: 'ok', response: { type: 'close' } });
          continue;
        }
        if (request.type !== 'execute') continue;
        const sql = request.stmt.sql;
        const args = (request.stmt.args || []).map((arg) => {
          if (!arg || arg.type === 'null') return null;
          if (arg.type === 'integer') return Number(arg.value);
          if (arg.type === 'float') return Number(arg.value);
          return arg.value;
        });

        if (/^begin\b|^commit\b|^rollback\b|^pragma\b|^savepoint\b|^release\b/i.test(sql)) {
          results.push({
            type: 'ok',
            response: { type: 'execute', result: { cols: [], rows: [], affected_row_count: 0 } }
          });
          continue;
        }

        if (/^insert\b/i.test(sql)) {
          memory.prepare(sql).run(...args);
          results.push({
            type: 'ok',
            response: {
              type: 'execute',
              result: { cols: [], rows: [], affected_row_count: 1, last_insert_rowid: '0' }
            }
          });
          continue;
        }

        if (/last_insert_rowid/i.test(sql)) {
          // Reproduce the real pipeline bug: SELECT also reports 0 / empty.
          results.push({
            type: 'ok',
            response: {
              type: 'execute',
              result: {
                cols: [{ name: 'id' }],
                rows: [[{ type: 'integer', value: '0' }]],
                affected_row_count: 0
              }
            }
          });
          continue;
        }

        const isGet = /^\s*select\b/i.test(sql) && !/\bfrom\s+\(/i.test(sql);
        if (isGet) {
          const rows = memory.prepare(sql).all(...args);
          const cols = rows[0]
            ? Object.keys(rows[0]).map((name) => ({ name }))
            : [{ name: 'id' }];
          results.push({
            type: 'ok',
            response: {
              type: 'execute',
              result: {
                cols,
                rows: rows.map((row) =>
                  cols.map((col) => {
                    const value = row[col.name];
                    if (value == null) return { type: 'null' };
                    if (typeof value === 'number' && Number.isInteger(value)) {
                      return { type: 'integer', value: String(value) };
                    }
                    return { type: 'text', value: String(value) };
                  })
                ),
                affected_row_count: 0
              }
            }
          });
          continue;
        }

        memory.prepare(sql).run(...args);
        results.push({
          type: 'ok',
          response: { type: 'execute', result: { cols: [], rows: [], affected_row_count: 1 } }
        });
      }

      const last = (body.requests || [])[(body.requests || []).length - 1];
      return {
        status: 200,
        ok: true,
        async text() {
          return JSON.stringify({
            baton: last?.type !== 'close' ? 'baton-1' : null,
            results
          });
        }
      };
    };

    const turso = new TursoHttpClient('libsql://ex.turso.io', 'tok', { fetchImpl });
    const app = createApp({ db: turso, config: loadDbConfig({}) });

    await withServer(app, async (base) => {
      const response = await fetch(`${base}/api/requisitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createPayload({ submitImmediately: true }))
      });
      const body = await response.json();
      assert.equal(response.status, 201, body.error || 'expected 201');
      assert.ok(Number(body.id) > 0, 'route must recover id when Turso last_insert_rowid is 0');

      const stored = memory.prepare(`SELECT * FROM purchase_requisitions WHERE id = ?`).get(body.id);
      assert.ok(stored);
      assert.equal(stored.status, 'pending_approval');
      const items = memory.prepare(`SELECT * FROM requisition_items WHERE requisition_id = ?`).all(body.id);
      assert.equal(items.length, 2);
      const approvals = memory.prepare(
        `SELECT status FROM approval_requests WHERE requisition_id = ? ORDER BY step_order`
      ).all(body.id);
      assert.ok(approvals.length >= 2);
      assert.equal(approvals[0].status, 'pending');
    });
  });
});
