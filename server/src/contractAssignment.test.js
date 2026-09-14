import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMemoryDatabase } from './db.js';
import { createApp } from './app.js';
import { loadDbConfig } from './dbConfig.js';
import { insertApprovalChain } from './approvalPolicy.js';
import { decideApprovalStep, ApprovalDecisionError } from './approvalsService.js';
import { createContract, createRenewalRequisition } from './contractsService.js';
import {
  pickBestContract,
  scoreContractCandidate,
  majoritySupplierId,
  assignContractToRequisition,
  parseAllowContractUse
} from './contractAssignment.js';

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

async function makeDb() {
  const db = await createMemoryDatabase();
  await db.prepare(`INSERT INTO departments (id, code, name, approver_user_id) VALUES (1, 'MKT', 'Marketing', 2)`).run();
  await db.prepare(`
    INSERT INTO users (id, name, email, role, department_id, approval_limit)
    VALUES (1, 'Alice Chen', 'alice@company.com', 'requester', 1, 0),
           (2, 'Bob Martinez', 'bob@company.com', 'approver', 1, 1000000),
           (3, 'Carol Zhang', 'carol@company.com', 'procurement', 1, 5000000)
  `).run();
  await db.prepare(`
    INSERT INTO budgets (department_id, fiscal_year, total_budget, committed_amount, actual_spent)
    VALUES (1, 2026, 15000000, 0, 0)
  `).run();
  await db.prepare(`
    INSERT INTO suppliers (id, name, code, payment_terms)
    VALUES (1, 'TechSupply Global', 'SUP-TSG', 'Net 30'),
           (2, 'CloudCore Software', 'SUP-CCS', 'Net 30')
  `).run();
  await db.prepare(`
    INSERT INTO catalog_items (id, sku, name, category, unit_price, preferred_supplier_id, line_type)
    VALUES (1, 'SKU-HW-001', 'MacBook Pro', 'IT Hardware', 349900, 1, 'goods'),
           (5, 'SKU-SW-001', 'Figma Organization Annual User License', 'Software & Cloud', 54000, 2, 'service'),
           (6, 'SKU-SW-002', 'Slack Enterprise Grid', 'Software & Cloud', 18000, 2, 'service')
  `).run();
  return db;
}

async function seedFigmaAndSlack(db) {
  const figma = await createContract(db, {
    supplier_id: 2,
    department_id: 1,
    title: 'Figma Enterprise Organization',
    category: 'Software & Cloud',
    start_date: '2025-10-01',
    end_date: '2026-09-30',
    notice_period_days: 30,
    annual_value_cents: 540000,
    auto_renew: 1,
    actor_name: 'Carol Zhang',
    items: [{ description: 'Figma Annual User Seat', catalog_item_id: 5, quantity: 10, unit_price: 54000, line_type: 'service' }]
  });
  const slack = await createContract(db, {
    supplier_id: 2,
    department_id: 1,
    title: 'Slack Enterprise Grid',
    category: 'Software & Cloud',
    start_date: '2025-12-01',
    end_date: '2026-12-31',
    notice_period_days: 60,
    annual_value_cents: 900000,
    auto_renew: 1,
    actor_name: 'Carol Zhang',
    items: [{ description: 'Slack seat', catalog_item_id: 6, quantity: 50, unit_price: 18000, line_type: 'service' }]
  });
  return { figma, slack };
}

describe('PR → contract auto-assignment', () => {
  test('majority supplier prefers the more common vendor; ties break to lower id', () => {
    assert.equal(majoritySupplierId([2, 2, 1]), 2);
    assert.equal(majoritySupplierId([1, 2]), 1);
    assert.equal(majoritySupplierId([]), null);
  });

  test('parseAllowContractUse accepts boolean, 0/1, and strings', () => {
    assert.equal(parseAllowContractUse(true), true);
    assert.equal(parseAllowContractUse('false'), false);
    assert.equal(parseAllowContractUse(0), false);
    assert.equal(parseAllowContractUse(undefined), undefined);
  });

  test('scores supplier + category + catalog overlap; Figma beats Slack for Figma seats', () => {
    const figma = {
      id: 1,
      supplier_id: 2,
      category: 'Software & Cloud',
      annual_value_cents: 540000,
      end_date: '2026-09-30',
      item_catalog_ids: [5]
    };
    const slack = {
      id: 2,
      supplier_id: 2,
      category: 'Software & Cloud',
      annual_value_cents: 900000,
      end_date: '2026-12-31',
      item_catalog_ids: [6]
    };
    const lines = [{
      estimated_supplier_id: 2,
      category: 'Software & Cloud',
      catalog_item_id: 5
    }];
    const today = '2026-09-14';
    const winner = pickBestContract(
      [
        { ...figma, status: 'active' },
        { ...slack, status: 'active' }
      ],
      lines,
      { today }
    );
    assert.equal(winner.id, 1);
    assert.ok(winner.score > 150);
    assert.ok(winner.reasons.includes('catalog_item'));
    assert.ok(winner.reasons.includes('supplier'));
  });

  test('no-match leaves assignment null (IT Hardware vs Software contracts)', () => {
    const figma = {
      id: 1,
      supplier_id: 2,
      category: 'Software & Cloud',
      annual_value_cents: 540000,
      end_date: '2026-09-30',
      item_catalog_ids: [5],
      status: 'active'
    };
    const winner = pickBestContract([figma], [{
      estimated_supplier_id: 1,
      category: 'IT Hardware',
      catalog_item_id: 1
    }], { today: '2026-09-14' });
    assert.equal(winner, null);
  });

  test('expired contracts are never assigned even with supplier+category match', () => {
    const expired = {
      id: 9,
      supplier_id: 2,
      category: 'Software & Cloud',
      end_date: '2026-01-01',
      notice_period_days: 30,
      annual_value_cents: 100,
      item_catalog_ids: [5],
      status: 'active'
    };
    const winner = pickBestContract([expired], [{
      estimated_supplier_id: 2,
      category: 'Software & Cloud',
      catalog_item_id: 5
    }], { today: '2026-09-14' });
    assert.equal(winner, null);
  });

  test('ambiguous category-only (no supplier, multiple contracts) stays unassigned', () => {
    const a = {
      id: 1,
      supplier_id: 2,
      category: 'Software & Cloud',
      end_date: '2026-09-30',
      notice_period_days: 30,
      annual_value_cents: 100,
      item_catalog_ids: [],
      status: 'active'
    };
    const b = {
      id: 2,
      supplier_id: 2,
      category: 'Software & Cloud',
      end_date: '2026-10-30',
      notice_period_days: 30,
      annual_value_cents: 200,
      item_catalog_ids: [],
      status: 'active'
    };
    const winner = pickBestContract([a, b], [{
      estimated_supplier_id: 1,
      category: 'Software & Cloud',
      catalog_item_id: null
    }], { today: '2026-09-14' });
    assert.equal(winner, null);
  });

  test('scoreContractCandidate is integer-cent ACV-agnostic (score does not use money floats)', () => {
    const scored = scoreContractCandidate({
      supplier_id: 2,
      category: 'Software & Cloud',
      item_catalog_ids: [5],
      annual_value_cents: 540000
    }, {
      supplierIds: [2],
      majoritySupplierId: 2,
      categories: new Set(['Software & Cloud']),
      catalogItemIds: new Set([5])
    });
    assert.equal(scored.score, 210);
  });

  test('creating a Figma-seat PR auto-sets source_contract_id as proposed', async () => {
    const db = await makeDb();
    const { figma } = await seedFigmaAndSlack(db);
    const app = createApp({ db, config: loadDbConfig({}) });

    await withServer(app, async (base) => {
      const response = await fetch(`${base}/api/requisitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requester_id: 1,
          department_id: 1,
          justification: 'Extra Figma seat for campaign designer',
          submitImmediately: true,
          today: '2026-09-14',
          items: [{
            catalog_item_id: 5,
            item_description: 'Figma Organization Annual User License',
            category: 'Software & Cloud',
            quantity: 1,
            unit_price: 54000,
            estimated_supplier_id: 2,
            line_type: 'service'
          }]
        })
      });
      const body = await response.json();
      assert.equal(response.status, 201, body.error || 'expected 201');
      assert.equal(body.source_contract_id, figma.id);
      assert.equal(body.contract_use_status, 'proposed');
      assert.ok(Number.isInteger(body.source_contract_id));

      const detail = await fetch(`${base}/api/requisitions/${body.id}`);
      const pr = await detail.json();
      assert.equal(pr.source_contract_id, figma.id);
      assert.equal(pr.contract_use_status, 'proposed');
      assert.equal(pr.source_contract.contract_number, figma.contract_number);
      assert.equal(pr.source_contract.annual_value_cents, 540000);
      assert.equal(pr.total_amount, 54000);
      assert.equal(pr.approvals[0].status, 'pending');
      assert.equal(pr.approvals[0].approver_id, 2);

      const proposed = pr.logs.find((row) => row.action === 'CONTRACT_PROPOSED');
      assert.ok(proposed);
      assert.match(proposed.details, /CNT-/);
    });
  });

  test('no matching contract leaves source_contract_id null and does not block create', async () => {
    const db = await makeDb();
    await seedFigmaAndSlack(db);
    const app = createApp({ db, config: loadDbConfig({}) });

    await withServer(app, async (base) => {
      const response = await fetch(`${base}/api/requisitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requester_id: 1,
          department_id: 1,
          justification: 'Laptop for intern',
          items: [{
            catalog_item_id: 1,
            item_description: 'MacBook Pro',
            category: 'IT Hardware',
            quantity: 1,
            unit_price: 349900,
            estimated_supplier_id: 1,
            line_type: 'goods'
          }]
        })
      });
      const body = await response.json();
      assert.equal(response.status, 201, body.error || 'expected 201');
      assert.equal(body.source_contract_id, null);
      assert.equal(body.contract_use_status, 'none');
    });
  });

  test('skip_contract_match leaves null even when a contract would match', async () => {
    const db = await makeDb();
    await seedFigmaAndSlack(db);
    const result = await db.transaction(async () => {
      const prNumber = 'PR-TEST-SKIP';
      await db.prepare(`
        INSERT INTO purchase_requisitions (pr_number, requester_id, department_id, status, total_amount, justification)
        VALUES (?, 1, 1, 'draft', 54000, 'adhoc')
      `).run(prNumber);
      const pr = await db.prepare(`SELECT id FROM purchase_requisitions WHERE pr_number = ?`).get(prNumber);
      await db.prepare(`
        INSERT INTO requisition_items (requisition_id, catalog_item_id, item_description, category, quantity, unit_price, total_price, estimated_supplier_id, line_type)
        VALUES (?, 5, 'Figma seat', 'Software & Cloud', 1, 54000, 54000, 2, 'service')
      `).run(pr.id);
      return assignContractToRequisition(db, pr.id, { skip_contract_match: true, today: '2026-09-14' });
    });
    assert.equal(result.source_contract_id, null);
    assert.equal(result.contract_use_status, 'none');
  });

  test('renewal PR sets source_contract_id FK (not just CNT- in justification)', async () => {
    const db = await makeDb();
    const { figma } = await seedFigmaAndSlack(db);
    const result = await createRenewalRequisition(db, figma.id, {
      requester_id: 1,
      today: '2026-09-14'
    });
    assert.equal(result.source_contract_id, figma.id);
    assert.equal(result.contract_use_status, 'proposed');

    const pr = await db.prepare(`SELECT * FROM purchase_requisitions WHERE id = ?`).get(result.pr_id);
    assert.equal(pr.source_contract_id, figma.id);
    assert.equal(pr.contract_use_status, 'proposed');
    assert.ok(pr.justification.includes(figma.contract_number));
    assert.equal(pr.total_amount, 540000);

    const proposed = await db.prepare(
      `SELECT action FROM audit_logs WHERE entity_type = 'requisition' AND entity_id = ? AND action = 'CONTRACT_PROPOSED'`
    ).get(result.pr_id);
    assert.ok(proposed);

    await assert.rejects(
      () => createRenewalRequisition(db, figma.id, { requester_id: 1, today: '2026-09-14' }),
      /already pending_approval/
    );
  });

  test('approving a proposed contract PR without allow_contract_use is 400; allow/refuse do not force PR reject', async () => {
    const db = await makeDb();
    const { figma } = await seedFigmaAndSlack(db);

    const insert = await db.prepare(`
      INSERT INTO purchase_requisitions (pr_number, requester_id, department_id, status, total_amount, source_contract_id, contract_use_status)
      VALUES ('PR-TEST-ALLOW', 1, 1, 'pending_approval', 54000, ?, 'proposed')
    `).run(figma.id);
    const prId = Number(insert.lastInsertRowid);
    await insertApprovalChain(db, prId, 54000, 1);
    const pending = await db.prepare(
      `SELECT id, approver_id FROM approval_requests WHERE requisition_id = ? AND status = 'pending'`
    ).get(prId);

    await assert.rejects(
      () => decideApprovalStep(db, {
        approvalId: pending.id,
        decision: 'approved',
        approver_id: pending.approver_id,
        approver_name: 'Bob Martinez'
      }),
      (err) => err instanceof ApprovalDecisionError && /allow_contract_use is required/.test(err.message)
    );

    const stillPending = await db.prepare(`SELECT status, contract_use_status FROM purchase_requisitions WHERE id = ?`).get(prId);
    assert.equal(stillPending.status, 'pending_approval');
    assert.equal(stillPending.contract_use_status, 'proposed');

    const allowed = await decideApprovalStep(db, {
      approvalId: pending.id,
      decision: 'approved',
      approver_id: pending.approver_id,
      approver_name: 'Bob Martinez',
      allow_contract_use: true
    });
    assert.equal(allowed.outcome, 'approved');
    assert.equal(allowed.contract_use_status, 'allowed');
    const afterAllow = await db.prepare(`SELECT status, source_contract_id, contract_use_status, total_amount FROM purchase_requisitions WHERE id = ?`).get(prId);
    assert.equal(afterAllow.status, 'approved');
    assert.equal(afterAllow.source_contract_id, figma.id);
    assert.equal(afterAllow.contract_use_status, 'allowed');
    assert.equal(afterAllow.total_amount, 54000);

    const allowAudit = await db.prepare(
      `SELECT actor_name FROM audit_logs WHERE entity_type = 'requisition' AND entity_id = ? AND action = 'CONTRACT_USE_ALLOWED'`
    ).get(prId);
    assert.equal(allowAudit.actor_name, 'Bob Martinez');
  });

  test('refuse contract use keeps the FK, marks refused, and still approves the PR as ad-hoc', async () => {
    const db = await makeDb();
    const { figma } = await seedFigmaAndSlack(db);
    const insert = await db.prepare(`
      INSERT INTO purchase_requisitions (pr_number, requester_id, department_id, status, total_amount, source_contract_id, contract_use_status)
      VALUES ('PR-TEST-REFUSE', 1, 1, 'pending_approval', 54000, ?, 'proposed')
    `).run(figma.id);
    const prId = Number(insert.lastInsertRowid);
    await insertApprovalChain(db, prId, 54000, 1);
    const pending = await db.prepare(
      `SELECT id, approver_id FROM approval_requests WHERE requisition_id = ? AND status = 'pending'`
    ).get(prId);

    const result = await decideApprovalStep(db, {
      approvalId: pending.id,
      decision: 'approved',
      approver_id: pending.approver_id,
      approver_name: 'Bob Martinez',
      allow_contract_use: false
    });
    assert.equal(result.outcome, 'approved');
    assert.equal(result.contract_use_status, 'refused');
    assert.equal(result.budgetCommitted, true);

    const pr = await db.prepare(`SELECT status, source_contract_id, contract_use_status FROM purchase_requisitions WHERE id = ?`).get(prId);
    assert.equal(pr.status, 'approved');
    assert.equal(pr.source_contract_id, figma.id);
    assert.equal(pr.contract_use_status, 'refused');

    const refuseAudit = await db.prepare(
      `SELECT details FROM audit_logs WHERE entity_type = 'requisition' AND entity_id = ? AND action = 'CONTRACT_USE_REFUSED'`
    ).get(prId);
    assert.match(refuseAudit.details, /ad-hoc/);
  });

  test('rejecting the PR does not require allow_contract_use', async () => {
    const db = await makeDb();
    const { figma } = await seedFigmaAndSlack(db);
    const insert = await db.prepare(`
      INSERT INTO purchase_requisitions (pr_number, requester_id, department_id, status, total_amount, source_contract_id, contract_use_status)
      VALUES ('PR-TEST-REJ', 1, 1, 'pending_approval', 54000, ?, 'proposed')
    `).run(figma.id);
    const prId = Number(insert.lastInsertRowid);
    await insertApprovalChain(db, prId, 54000, 1);
    const pending = await db.prepare(
      `SELECT id, approver_id FROM approval_requests WHERE requisition_id = ? AND status = 'pending'`
    ).get(prId);

    const result = await decideApprovalStep(db, {
      approvalId: pending.id,
      decision: 'rejected',
      comments: 'Not this quarter',
      approver_id: pending.approver_id,
      approver_name: 'Bob Martinez'
    });
    assert.equal(result.outcome, 'rejected');
    const pr = await db.prepare(`SELECT status, contract_use_status FROM purchase_requisitions WHERE id = ?`).get(prId);
    assert.equal(pr.status, 'rejected');
    assert.equal(pr.contract_use_status, 'proposed');
  });

  test('GET approvals inbox includes the linked contract snapshot', async () => {
    const db = await makeDb();
    const { figma } = await seedFigmaAndSlack(db);
    const insert = await db.prepare(`
      INSERT INTO purchase_requisitions (pr_number, requester_id, department_id, status, total_amount, justification, source_contract_id, contract_use_status)
      VALUES ('PR-TEST-INBOX', 1, 1, 'pending_approval', 54000, 'Figma seat', ?, 'proposed')
    `).run(figma.id);
    const prId = Number(insert.lastInsertRowid);
    await insertApprovalChain(db, prId, 54000, 1);
    const app = createApp({ db, config: loadDbConfig({}) });

    await withServer(app, async (base) => {
      const response = await fetch(`${base}/api/approvals?approver_id=2`);
      const list = await response.json();
      assert.equal(response.status, 200);
      const row = list.find((item) => item.pr_number === 'PR-TEST-INBOX');
      assert.ok(row);
      assert.equal(row.source_contract_id, figma.id);
      assert.equal(row.contract_use_status, 'proposed');
      assert.equal(row.source_contract.annual_value_cents, 540000);
      assert.equal(row.source_contract.supplier_name, 'CloudCore Software');
    });
  });
});
