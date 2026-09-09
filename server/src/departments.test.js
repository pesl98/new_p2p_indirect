import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMemoryDatabase } from './db.js';
import { createApp } from './app.js';
import { loadDbConfig } from './dbConfig.js';
import { APPROVAL_TIER2_CENTS, buildApprovalSteps } from './approvalPolicy.js';
import { ELIGIBLE_APPROVER_ROLES } from './departmentsService.js';

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
    INSERT INTO departments (id, code, name) VALUES
      (1, 'MKT', 'Marketing & Brand'),
      (2, 'ITE', 'IT & Digital Infrastructure'),
      (3, 'FAC', 'Facilities & Operations'),
      (4, 'HRP', 'Human Resources & Talent'),
      (5, 'ADM', 'Finance & Administration');
    INSERT INTO users (id, name, email, role, department_id, title) VALUES
      (1, 'Alice Chen', 'alice@example.com', 'requester', 1, 'Specialist'),
      (2, 'Bob Martinez', 'bob@example.com', 'approver', 1, 'VP of Marketing'),
      (3, 'Carol Zhang', 'carol@example.com', 'procurement', 3, 'Sourcing'),
      (4, 'David Miller', 'david@example.com', 'finance', 5, 'Controller'),
      (5, 'Elena Rostova', 'elena@example.com', 'admin', 5, 'CFO'),
      (6, 'Priya Nair', 'priya@example.com', 'approver', 2, 'VP of IT'),
      (7, 'James Okonkwo', 'james@example.com', 'approver', 3, 'Director of Facilities'),
      (8, 'Sofia Berg', 'sofia@example.com', 'approver', 4, 'VP of People');
    INSERT INTO budgets (department_id, fiscal_year, total_budget, committed_amount, actual_spent)
      VALUES
        (1, 2026, 15000000, 0, 0),
        (2, 2026, 32000000, 0, 0),
        (3, 2026, 9500000, 0, 0),
        (4, 2026, 6000000, 0, 0),
        (5, 2026, 5000000, 0, 0);
    UPDATE departments SET approver_user_id = 2 WHERE id = 1;
    UPDATE departments SET approver_user_id = 6 WHERE id = 2;
    UPDATE departments SET approver_user_id = 7 WHERE id = 3;
    UPDATE departments SET approver_user_id = 8 WHERE id = 4;
    UPDATE departments SET approver_user_id = 5 WHERE id = 5;
  `);
  return db;
}

describe('department approver admin API', () => {
  test('GET /api/departments includes mapped approver name/id for every seeded dept', async () => {
    const db = await createTestDb();
    const app = createApp({ db, config: loadDbConfig({}) });

    await withServer(app, async (base) => {
      const { status, body } = await json(await fetch(`${base}/api/departments`));
      assert.equal(status, 200);
      assert.equal(body.length, 5);
      const byCode = Object.fromEntries(body.map((d) => [d.code, d]));
      assert.equal(byCode.MKT.approver_user_id, 2);
      assert.equal(byCode.MKT.approver_name, 'Bob Martinez');
      assert.equal(byCode.ITE.approver_user_id, 6);
      assert.equal(byCode.ITE.approver_name, 'Priya Nair');
      assert.equal(byCode.FAC.approver_user_id, 7);
      assert.equal(byCode.HRP.approver_user_id, 8);
      assert.equal(byCode.ADM.approver_user_id, 5);
      assert.equal(byCode.ADM.approver_role, 'admin');

      const legacy = await json(await fetch(`${base}/api/users/departments`));
      assert.equal(legacy.status, 200);
      assert.equal(legacy.body.find((d) => d.code === 'MKT').approver_name, 'Bob Martinez');
    });
  });

  test('eligible-approvers lists approval-capable roles and omits requesters', async () => {
    const db = await createTestDb();
    const app = createApp({ db, config: loadDbConfig({}) });

    await withServer(app, async (base) => {
      const { status, body } = await json(await fetch(`${base}/api/departments/eligible-approvers`));
      assert.equal(status, 200);
      assert.equal(body.some((u) => u.role === 'requester'), false);
      assert.ok(body.every((u) => ELIGIBLE_APPROVER_ROLES.includes(u.role)));
      assert.ok(body.some((u) => u.name === 'Bob Martinez'));
      assert.ok(body.some((u) => u.name === 'Elena Rostova'));
      assert.ok(body.some((u) => u.name === 'Carol Zhang'));
    });
  });

  test('PUT sets, clears, and audits approver assignment; missing user is 404', async () => {
    const db = await createTestDb();
    const app = createApp({ db, config: loadDbConfig({}) });

    await withServer(app, async (base) => {
      const assigned = await json(await fetch(`${base}/api/departments/2/approver`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approver_user_id: 3, actor_name: 'Elena Rostova' })
      }));
      assert.equal(assigned.status, 200, assigned.body.error);
      assert.equal(assigned.body.approver_user_id, 3);
      assert.equal(assigned.body.approver_name, 'Carol Zhang');

      const audit = db.prepare(`
        SELECT action, actor_name, details FROM audit_logs
        WHERE entity_type = 'department' AND entity_id = 2
        ORDER BY id DESC LIMIT 1
      `).get();
      assert.equal(audit.action, 'APPROVER_ASSIGNED');
      assert.equal(audit.actor_name, 'Elena Rostova');
      assert.match(audit.details, /Priya Nair/);
      assert.match(audit.details, /Carol Zhang/);

      const cleared = await json(await fetch(`${base}/api/departments/2`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approver_user_id: null, actor_name: 'Elena Rostova' })
      }));
      assert.equal(cleared.status, 200, cleared.body.error);
      assert.equal(cleared.body.approver_user_id, null);
      assert.equal(cleared.body.approver_name, null);

      const clearedAudit = db.prepare(`
        SELECT action FROM audit_logs
        WHERE entity_type = 'department' AND entity_id = 2
        ORDER BY id DESC LIMIT 1
      `).get();
      assert.equal(clearedAudit.action, 'APPROVER_CLEARED');

      const missing = await json(await fetch(`${base}/api/departments/2/approver`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approver_user_id: 99 })
      }));
      assert.equal(missing.status, 404);
      assert.match(missing.body.error, /not found/i);

      const noDept = await json(await fetch(`${base}/api/departments/99/approver`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approver_user_id: 2 })
      }));
      assert.equal(noDept.status, 404);

      const missingField = await json(await fetch(`${base}/api/departments/1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      }));
      assert.equal(missingField.status, 400);
      assert.match(missingField.body.error, /approver_user_id is required/i);
    });
  });

  test('submit works for every seeded department after mapping', async () => {
    const db = await createTestDb();
    const expected = { 1: 2, 2: 6, 3: 7, 4: 8, 5: 5 };
    for (const [deptId, approverId] of Object.entries(expected)) {
      const steps = await buildApprovalSteps({
        totalAmount: APPROVAL_TIER2_CENTS,
        departmentId: Number(deptId),
        db
      });
      assert.equal(steps.length, 1);
      assert.equal(steps[0].approver_id, approverId);
    }
  });

  test('APIs are demo-open (no actor_role gate), consistent with master-data', async () => {
    const db = await createTestDb();
    const app = createApp({ db, config: loadDbConfig({}) });

    await withServer(app, async (base) => {
      const { status, body } = await json(await fetch(`${base}/api/departments/1/approver`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approver_user_id: 8 })
      }));
      assert.equal(status, 200, body.error);
      assert.equal(body.approver_user_id, 8);

      const requester = await json(await fetch(`${base}/api/departments/1/approver`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approver_user_id: 1 })
      }));
      assert.equal(requester.status, 200, requester.body.error);
      assert.equal(requester.body.approver_user_id, 1);
      assert.equal(requester.body.approver_name, 'Alice Chen');
    });
  });
});
