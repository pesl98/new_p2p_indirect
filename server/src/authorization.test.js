import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMemoryDatabase } from './db.js';
import { createApp } from './app.js';
import { loadDbConfig } from './dbConfig.js';
import { APPROVAL_TIER2_CENTS, insertApprovalChain } from './approvalPolicy.js';
import { withCookie } from './testSession.js';

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
  db.exec(`
    INSERT INTO departments (id, code, name, approver_user_id) VALUES
      (1, 'MKT', 'Marketing', 2),
      (5, 'ADM', 'Finance', 5);
    INSERT INTO users (id, name, email, role, department_id, title, status) VALUES
      (1, 'Alice Chen', 'alice@example.com', 'requester', 1, 'Specialist', 'active'),
      (2, 'Bob Martinez', 'bob@example.com', 'approver', 1, 'VP of Marketing', 'active'),
      (3, 'Carol Zhang', 'carol@example.com', 'procurement', 1, 'Sourcing', 'active'),
      (4, 'David Miller', 'david@example.com', 'finance', 5, 'Controller', 'active'),
      (5, 'Elena Rostova', 'elena@example.com', 'admin', 5, 'CFO', 'active');
    INSERT INTO suppliers (id, name, code, status) VALUES (1, 'TechSupply Global', 'SUP-TSG', 'active');
    INSERT INTO catalog_items (id, sku, name, category, unit_price, preferred_supplier_id, line_type, status)
      VALUES (1, 'SKU-HW-001', 'MacBook Pro', 'IT Hardware', 349900, 1, 'goods', 'active');
    INSERT INTO budgets (department_id, fiscal_year, total_budget, committed_amount, actual_spent)
      VALUES (1, 2026, 15000000, 0, 0), (5, 2026, 5000000, 0, 0);
  `);
  return db;
}

function prBody(overrides = {}) {
  return {
    requester_id: 1,
    department_id: 1,
    justification: 'Workstation',
    needed_by_date: '2026-09-20',
    priority: 'Medium',
    items: [{
      catalog_item_id: 1,
      item_description: 'MacBook Pro',
      category: 'IT Hardware',
      quantity: 1,
      unit_price: 10000,
      estimated_supplier_id: 1,
      line_type: 'goods'
    }],
    ...overrides
  };
}

describe('session authorization on P2P routes', () => {
  test('unauthenticated persona-id calls are rejected', async () => {
    const db = await createTestDb();
    const app = createApp({ db, config: loadDbConfig({}) });
    await withServer(app, async (base) => {
      const pr = await json(await fetch(`${base}/api/requisitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prBody())
      }));
      assert.equal(pr.status, 401);

      const decide = await json(await fetch(`${base}/api/approvals/1/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approved', approver_id: 2, approver_name: 'Bob Martinez' })
      }));
      assert.equal(decide.status, 401);

      const inbox = await json(await fetch(`${base}/api/approvals?approver_id=2`));
      assert.equal(inbox.status, 401);

      const users = await json(await fetch(`${base}/api/users`));
      assert.equal(users.status, 401);

      const pay = await json(await fetch(`${base}/api/invoices/1/approve-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approver_name: 'David Miller' })
      }));
      assert.equal(pay.status, 401);
    });
  });

  test('requisition requester is the session user; a body persona id cannot spoof', async () => {
    const db = await createTestDb();
    const app = createApp({ db, config: loadDbConfig({}) });
    await withServer(app, async (base) => {
      const spoof = await json(await fetch(`${base}/api/requisitions`, withCookie(1, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prBody({ requester_id: 2, actor_name: 'Bob Martinez' }))
      })));
      assert.equal(spoof.status, 403);
      assert.match(spoof.body.error, /requester_id/);

      const otherDept = await json(await fetch(`${base}/api/requisitions`, withCookie(1, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prBody({ department_id: 5 }))
      })));
      assert.equal(otherDept.status, 403);

      const created = await json(await fetch(`${base}/api/requisitions`, withCookie(1, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prBody({ actor_name: 'Mallory' }))
      })));
      assert.equal(created.status, 201, created.body.error);
      const row = db.prepare(`SELECT requester_id FROM purchase_requisitions WHERE id = ?`).get(created.body.id);
      assert.equal(row.requester_id, 1);
      const audit = db.prepare(`
        SELECT actor_name FROM audit_logs
        WHERE entity_type = 'requisition' AND entity_id = ? AND action = 'CREATED'
      `).get(created.body.id);
      assert.equal(audit.actor_name, 'Alice Chen');
    });
  });

  test('approval inbox and decide use the signed-in user', async () => {
    const db = await createTestDb();
    const pr = db.prepare(`
      INSERT INTO purchase_requisitions (pr_number, requester_id, department_id, status, total_amount)
      VALUES ('PR-AUTH-1', 1, 1, 'pending_approval', ?)
    `).run(APPROVAL_TIER2_CENTS + 500);
    const prId = Number(pr.lastInsertRowid);
    await insertApprovalChain(db, prId, APPROVAL_TIER2_CENTS + 500, 1);
    const pending = db.prepare(`
      SELECT id, approver_id FROM approval_requests WHERE requisition_id = ? AND status = 'pending'
    `).get(prId);

    const app = createApp({ db, config: loadDbConfig({}) });
    await withServer(app, async (base) => {
      const wrongQuery = await json(await fetch(
        `${base}/api/approvals?approver_id=1`,
        withCookie(2)
      ));
      assert.equal(wrongQuery.status, 403);

      const inbox = await json(await fetch(`${base}/api/approvals`, withCookie(2)));
      assert.equal(inbox.status, 200);
      assert.equal(inbox.body.length, 1);
      assert.equal(inbox.body[0].pr_number, 'PR-AUTH-1');

      const aliceInbox = await json(await fetch(`${base}/api/approvals`, withCookie(1)));
      assert.equal(aliceInbox.status, 200);
      assert.equal(aliceInbox.body.length, 0);

      const spoofDecide = await json(await fetch(`${base}/api/approvals/${pending.id}/decide`, withCookie(3, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision: 'approved',
          approver_id: pending.approver_id,
          approver_name: 'Bob Martinez'
        })
      })));
      assert.equal(spoofDecide.status, 403);

      const decided = await json(await fetch(`${base}/api/approvals/${pending.id}/decide`, withCookie(2, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approved', approver_name: 'Someone Else' })
      })));
      assert.equal(decided.status, 200, decided.body.error);
      const audit = db.prepare(`
        SELECT actor_name FROM audit_logs
        WHERE entity_type = 'requisition' AND entity_id = ? AND action = 'STEP_APPROVED'
      `).get(prId);
      assert.equal(audit.actor_name, 'Bob Martinez');
    });
  });

  test('AP approve requires a finance or admin session', async () => {
    const db = await createTestDb();
    const app = createApp({ db, config: loadDbConfig({}) });
    await withServer(app, async (base) => {
      const requester = await json(await fetch(`${base}/api/invoices/1/approve-payment`, withCookie(1, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approver_name: 'David Miller' })
      })));
      assert.equal(requester.status, 403);

      const aging = await json(await fetch(`${base}/api/ap-aging`, withCookie(1)));
      assert.equal(aging.status, 403);

      const financeAging = await json(await fetch(`${base}/api/ap-aging`, withCookie(4)));
      assert.equal(financeAging.status, 200);
    });
  });

  test('buyer inbox cannot be listed as another requester', async () => {
    const db = await createTestDb();
    const app = createApp({ db, config: loadDbConfig({}) });
    await withServer(app, async (base) => {
      const spoof = await json(await fetch(
        `${base}/api/invoice-exceptions/buyer-inbox?requester_id=2`,
        withCookie(1)
      ));
      assert.equal(spoof.status, 403);

      const own = await json(await fetch(
        `${base}/api/invoice-exceptions/buyer-inbox`,
        withCookie(1)
      ));
      assert.equal(own.status, 200);
      assert.ok(Array.isArray(own.body));
    });
  });
});
