import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMemoryDatabase } from './db.js';
import { createApp } from './app.js';
import { loadDbConfig } from './dbConfig.js';
import { APPROVAL_TIER2_CENTS, insertApprovalChain } from './approvalPolicy.js';
import { decideApprovalStep, listApprovalInbox } from './approvalsService.js';
import {
  DelegationError,
  createDelegation,
  findActiveDelegation,
  listDelegations,
  normalizeOptionalTimestamp,
  revokeDelegation
} from './delegationsService.js';

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
    INSERT INTO users (id, name, email, role, department_id, title) VALUES
      (1, 'Alice Chen', 'alice@example.com', 'requester', 1, 'Specialist'),
      (2, 'Bob Martinez', 'bob@example.com', 'approver', 1, 'VP of Marketing'),
      (3, 'Carol Zhang', 'carol@example.com', 'procurement', 1, 'Head of Strategic Sourcing'),
      (4, 'David Miller', 'david@example.com', 'finance', 1, 'Controller'),
      (6, 'Priya Nair', 'priya@example.com', 'approver', 2, 'VP of IT');
    INSERT INTO budgets (department_id, fiscal_year, total_budget, committed_amount, actual_spent)
    VALUES (1, 2026, 15000000, 1000, 0);
    UPDATE departments SET approver_user_id = 2 WHERE id = 1;
    UPDATE departments SET approver_user_id = 6 WHERE id = 2;
  `);
  return db;
}

async function insertPr(db, amount) {
  const result = await db.prepare(`
    INSERT INTO purchase_requisitions (pr_number, requester_id, department_id, status, total_amount)
    VALUES (?, 1, 1, 'pending_approval', ?)
  `).run(`PR-TEST-${Math.random().toString(16).slice(2)}`, amount);
  return Number(result.lastInsertRowid);
}

async function chainRows(db, prId) {
  return db.prepare(
    `SELECT id, step_order, approver_id, status FROM approval_requests WHERE requisition_id = ? ORDER BY step_order`
  ).all(prId);
}

describe('approval delegation timestamps', () => {
  test('date-only strings become ISO start/end of UTC day', () => {
    assert.equal(normalizeOptionalTimestamp('2026-09-10'), '2026-09-10T00:00:00.000Z');
    assert.equal(normalizeOptionalTimestamp('2026-09-10', { endOfDay: true }), '2026-09-10T23:59:59.999Z');
    assert.equal(normalizeOptionalTimestamp(''), null);
    assert.equal(normalizeOptionalTimestamp(null), null);
  });
});

describe('approval delegation create/revoke', () => {
  test('create then revoke writes audit rows and keeps history', async () => {
    const db = await createTestDb();
    const created = await createDelegation(db, {
      delegator_user_id: 2,
      delegate_user_id: 6,
      starts_at: '2026-09-01',
      ends_at: '2026-12-31',
      reason: 'Q3 offsite',
      actor_name: 'Bob Martinez',
      created_by_user_id: 2
    });

    assert.equal(created.delegator_user_id, 2);
    assert.equal(created.delegate_user_id, 6);
    assert.equal(created.delegator_name, 'Bob Martinez');
    assert.equal(created.delegate_name, 'Priya Nair');
    assert.equal(created.active, 1);
    assert.equal(created.starts_at, '2026-09-01T00:00:00.000Z');
    assert.equal(created.ends_at, '2026-12-31T23:59:59.999Z');
    assert.equal(created.reason, 'Q3 offsite');

    const createdAudit = await db.prepare(`
      SELECT action, actor_name, details FROM audit_logs
      WHERE entity_type = 'approval_delegation' AND entity_id = ? AND action = 'DELEGATION_CREATED'
    `).get(created.id);
    assert.ok(createdAudit);
    assert.equal(createdAudit.actor_name, 'Bob Martinez');
    assert.match(createdAudit.details, /Priya Nair/);

    const revoked = await revokeDelegation(db, created.id, {
      actor_name: 'Bob Martinez',
      actor_user_id: 2
    });
    assert.equal(revoked.active, 0);
    assert.ok(revoked.revoked_at);
    assert.equal(revoked.revoked_by_name, 'Bob Martinez');

    const revokedAudit = await db.prepare(`
      SELECT action FROM audit_logs
      WHERE entity_type = 'approval_delegation' AND entity_id = ? AND action = 'DELEGATION_REVOKED'
    `).get(created.id);
    assert.ok(revokedAudit);

    const listed = await listDelegations(db, { delegator_user_id: 2 });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].active, 0);
  });

  test('self-delegate is rejected', async () => {
    const db = await createTestDb();
    await assert.rejects(
      () => createDelegation(db, { delegator_user_id: 2, delegate_user_id: 2, actor_name: 'Bob' }),
      (err) => err instanceof DelegationError && err.statusCode === 400 && /yourself/i.test(err.message)
    );
  });

  test('missing user is rejected', async () => {
    const db = await createTestDb();
    await assert.rejects(
      () => createDelegation(db, { delegator_user_id: 2, delegate_user_id: 99, actor_name: 'Bob' }),
      (err) => err instanceof DelegationError && err.statusCode === 404
    );
    await assert.rejects(
      () => createDelegation(db, { delegator_user_id: 99, delegate_user_id: 6, actor_name: 'Bob' }),
      (err) => err instanceof DelegationError && err.statusCode === 404
    );
  });

  test('revoke only when active', async () => {
    const db = await createTestDb();
    const created = await createDelegation(db, {
      delegator_user_id: 2,
      delegate_user_id: 6,
      actor_name: 'Bob Martinez'
    });
    await revokeDelegation(db, created.id, { actor_name: 'Bob Martinez' });
    await assert.rejects(
      () => revokeDelegation(db, created.id, { actor_name: 'Bob Martinez' }),
      (err) => err instanceof DelegationError && err.statusCode === 400 && /not active/i.test(err.message)
    );
  });

  test('HTTP create/list/revoke and DELETE 405', async () => {
    const db = await createTestDb();
    const app = createApp({ db, config: loadDbConfig({}) });

    await withServer(app, async (base) => {
      const created = await json(await fetch(`${base}/api/approval-delegations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          delegator_user_id: 2,
          delegate_user_id: 6,
          reason: 'Covering',
          actor_name: 'Elena Rostova'
        })
      }));
      assert.equal(created.status, 201);
      assert.equal(created.body.delegate_name, 'Priya Nair');

      const listed = await json(await fetch(`${base}/api/approval-delegations?user_id=2&active=1`));
      assert.equal(listed.status, 200);
      assert.equal(listed.body.length, 1);

      const self = await json(await fetch(`${base}/api/approval-delegations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delegator_user_id: 2, delegate_user_id: 2 })
      }));
      assert.equal(self.status, 400);

      const del = await json(await fetch(`${base}/api/approval-delegations/${created.body.id}`, {
        method: 'DELETE'
      }));
      assert.equal(del.status, 405);

      const revoked = await json(await fetch(`${base}/api/approval-delegations/${created.body.id}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor_name: 'Elena Rostova' })
      }));
      assert.equal(revoked.status, 200);
      assert.equal(revoked.body.active, 0);
    });
  });
});

describe('approval inbox and decide with delegation', () => {
  test('delegate sees pending step and mapped approver still sees it', async () => {
    const db = await createTestDb();
    const amount = APPROVAL_TIER2_CENTS + 500;
    const prId = await insertPr(db, amount);
    await insertApprovalChain(db, prId, amount, 1);
    await createDelegation(db, {
      delegator_user_id: 2,
      delegate_user_id: 6,
      actor_name: 'Bob Martinez'
    });

    const bobInbox = await listApprovalInbox(db, { approver_id: 2 });
    const priyaInbox = await listApprovalInbox(db, { approver_id: 6 });
    const carolInbox = await listApprovalInbox(db, { approver_id: 3 });

    assert.equal(bobInbox.length, 1);
    assert.equal(bobInbox[0].via_delegation, 0);
    assert.equal(bobInbox[0].approver_id, 2);
    assert.equal(priyaInbox.length, 1);
    assert.equal(priyaInbox[0].via_delegation, 1);
    assert.equal(priyaInbox[0].delegated_from_name, 'Bob Martinez');
    assert.equal(priyaInbox[0].approver_id, 2);
    assert.equal(carolInbox.length, 0);

    const waiting = (await chainRows(db, prId))[1];
    assert.equal(waiting.status, 'waiting');
  });

  test('decide by delegate succeeds and does not rewrite stored approver_id', async () => {
    const db = await createTestDb();
    const amount = APPROVAL_TIER2_CENTS + 500;
    const prId = await insertPr(db, amount);
    await insertApprovalChain(db, prId, amount, 1);
    const [step1, step2] = await chainRows(db, prId);
    const delegation = await createDelegation(db, {
      delegator_user_id: 2,
      delegate_user_id: 6,
      actor_name: 'Bob Martinez'
    });

    const result = await decideApprovalStep(db, {
      approvalId: step1.id,
      decision: 'approved',
      comments: 'Covering for Bob',
      approver_id: 6,
      approver_name: 'Priya Nair'
    });

    assert.equal(result.outcome, 'step_approved');
    assert.equal(result.decidedAsDelegate, true);
    assert.equal(result.delegated_from_name, 'Bob Martinez');
    assert.equal(result.delegation_id, delegation.id);

    const rows = await chainRows(db, prId);
    assert.equal(rows[0].status, 'approved');
    assert.equal(rows[0].approver_id, 2);
    assert.equal(rows[1].status, 'pending');
    assert.equal(rows[1].approver_id, step2.approver_id);
    assert.equal(rows[1].approver_id, 3);

    const pr = await db.prepare(`SELECT status FROM purchase_requisitions WHERE id = ?`).get(prId);
    assert.equal(pr.status, 'pending_approval');

    const audit = await db.prepare(`
      SELECT action, actor_name, details FROM audit_logs
      WHERE entity_type = 'requisition' AND entity_id = ? AND action = 'STEP_APPROVED'
    `).get(prId);
    assert.equal(audit.actor_name, 'Priya Nair');
    assert.match(audit.details, /Delegated from Bob Martinez/);
    assert.match(audit.details, new RegExp(`delegation_id=${delegation.id}`));
  });

  test('decide by non-delegate / non-owner fails', async () => {
    const db = await createTestDb();
    const amount = APPROVAL_TIER2_CENTS + 500;
    const prId = await insertPr(db, amount);
    await insertApprovalChain(db, prId, amount, 1);
    const [step1] = await chainRows(db, prId);
    await createDelegation(db, {
      delegator_user_id: 2,
      delegate_user_id: 6,
      actor_name: 'Bob Martinez'
    });

    await assert.rejects(
      () => decideApprovalStep(db, {
        approvalId: step1.id,
        decision: 'approved',
        approver_id: 3,
        approver_name: 'Carol Zhang'
      }),
      (err) => err.statusCode === 403
    );
    assert.equal((await chainRows(db, prId))[0].status, 'pending');
  });

  test('expired and inactive delegations are ignored', async () => {
    const db = await createTestDb();
    const amount = 50_000;
    const prId = await insertPr(db, amount);
    await insertApprovalChain(db, prId, amount, 1);
    const [step1] = await chainRows(db, prId);

    const expired = await createDelegation(db, {
      delegator_user_id: 2,
      delegate_user_id: 6,
      starts_at: '2020-01-01T00:00:00.000Z',
      ends_at: '2020-01-31T23:59:59.999Z',
      actor_name: 'Bob Martinez'
    });
    assert.equal(expired.covering_now, 0);
    assert.equal(await findActiveDelegation(db, 2, 6), null);
    assert.equal((await listApprovalInbox(db, { approver_id: 6 })).length, 0);

    await assert.rejects(
      () => decideApprovalStep(db, {
        approvalId: step1.id,
        decision: 'approved',
        approver_id: 6,
        approver_name: 'Priya Nair'
      }),
      (err) => err.statusCode === 403
    );

    const inactive = await createDelegation(db, {
      delegator_user_id: 2,
      delegate_user_id: 6,
      actor_name: 'Bob Martinez'
    });
    await revokeDelegation(db, inactive.id, { actor_name: 'Bob Martinez' });
    assert.equal((await listApprovalInbox(db, { approver_id: 6 })).length, 0);
    await assert.rejects(
      () => decideApprovalStep(db, {
        approvalId: step1.id,
        decision: 'approved',
        approver_id: 6,
        approver_name: 'Priya Nair'
      }),
      (err) => err.statusCode === 403
    );

    const future = await createDelegation(db, {
      delegator_user_id: 2,
      delegate_user_id: 6,
      starts_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      actor_name: 'Bob Martinez'
    });
    assert.equal(future.covering_now, 0);
    assert.equal((await listApprovalInbox(db, { approver_id: 6 })).length, 0);
  });

  test('sequential waiting steps stay waiting until the pending step is decided', async () => {
    const db = await createTestDb();
    const amount = APPROVAL_TIER2_CENTS + 500;
    const prId = await insertPr(db, amount);
    await insertApprovalChain(db, prId, amount, 1);
    await createDelegation(db, {
      delegator_user_id: 2,
      delegate_user_id: 6,
      actor_name: 'Bob Martinez'
    });

    const before = await chainRows(db, prId);
    assert.equal(before[0].status, 'pending');
    assert.equal(before[1].status, 'waiting');

    const priyaInbox = await listApprovalInbox(db, { approver_id: 6 });
    assert.equal(priyaInbox.length, 1);
    assert.equal(priyaInbox[0].step_order, 1);

    await decideApprovalStep(db, {
      approvalId: before[0].id,
      decision: 'approved',
      approver_id: 6,
      approver_name: 'Priya Nair'
    });

    const after = await chainRows(db, prId);
    assert.equal(after[1].status, 'pending');
    assert.equal(after[1].approver_id, 3);

    const priyaAfter = await listApprovalInbox(db, { approver_id: 6 });
    assert.equal(priyaAfter.length, 0);
    const carolAfter = await listApprovalInbox(db, { approver_id: 3 });
    assert.equal(carolAfter.length, 1);
    assert.equal(carolAfter[0].via_delegation, 0);
  });
});
