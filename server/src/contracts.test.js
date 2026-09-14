import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from './db.js';
import {
  listContracts,
  getContractDetail,
  createContract,
  createRenewalRequisition,
  computeContractStatus,
  ContractError,
  utcCalendarDaysUntil
} from './contractsService.js';

async function makeTestDb() {
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
    VALUES (1, 'CloudCore Software', 'SUP-CCS', 'Net 30')
  `).run();

  return db;
}

async function seedFigma(db, extras = {}) {
  return createContract(db, {
    supplier_id: 1,
    department_id: 1,
    title: 'Figma Enterprise Organization',
    category: 'Software & Cloud',
    start_date: '2025-10-01',
    end_date: '2026-09-30',
    notice_period_days: 30,
    annual_value_cents: 540000,
    auto_renew: 1,
    actor_name: 'Carol Zhang',
    items: [
      {
        description: 'Figma Annual User Seat',
        quantity: 10,
        unit_price: 54000,
        line_type: 'service'
      }
    ],
    ...extras
  });
}

test('contracts lifecycle and renewal generator', async (t) => {
  const db = await makeTestDb();

  await t.test('computes dynamic status from UTC calendar dates and notice window', () => {
    const today = '2026-09-01';
    assert.equal(computeContractStatus({ end_date: '2026-11-01', notice_period_days: 30 }, today), 'active');
    assert.equal(computeContractStatus({ end_date: '2026-09-20', notice_period_days: 30 }, today), 'expiring_soon');
    assert.equal(computeContractStatus({ end_date: '2026-09-01', notice_period_days: 30 }, today), 'expiring_soon');
    assert.equal(computeContractStatus({ end_date: '2026-08-15', notice_period_days: 30 }, today), 'expired');
    assert.equal(
      computeContractStatus({ end_date: '2026-11-01', notice_period_days: 30, status: 'cancelled' }, today),
      'cancelled'
    );
    assert.equal(utcCalendarDaysUntil('2026-09-30', '2026-09-14'), 16);
  });

  await t.test('creates contract with sequential CNT-YYYY-NNN numbering and integer-cent items', async () => {
    const contract = await seedFigma(db);

    assert.ok(contract.contract_number.startsWith('CNT-'));
    assert.equal(contract.title, 'Figma Enterprise Organization');
    assert.equal(contract.annual_value_cents, 540000);
    assert.equal(contract.items.length, 1);
    assert.equal(contract.items[0].quantity, 10);
    assert.equal(contract.items[0].unit_price, 54000);
    assert.equal(contract.items[0].total_price, 540000);

    const list = await listContracts(db, { today: '2026-09-14' });
    assert.equal(list.length, 1);
    assert.equal(list[0].supplier_name, 'CloudCore Software');
    assert.equal(list[0].status, 'expiring_soon');

    const created = await db.prepare(
      `SELECT action, actor_name, details FROM audit_logs WHERE entity_type = 'contract' AND entity_id = ?`
    ).get(contract.id);
    assert.equal(created.action, 'CREATED');
    assert.equal(created.actor_name, 'Carol Zhang');
    assert.match(created.details, /540000 cents/);
  });

  await t.test('rejects float, negative, and missing money fields', async () => {
    await assert.rejects(
      () => createContract(db, {
        supplier_id: 1,
        department_id: 1,
        title: 'Bad float ACV',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        annual_value_cents: 5400.5,
        actor_name: 'Carol Zhang'
      }),
      (err) => err instanceof ContractError && /integer number of cents/.test(err.message)
    );

    await assert.rejects(
      () => createContract(db, {
        supplier_id: 1,
        department_id: 1,
        title: 'Negative ACV',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        annual_value_cents: -1,
        actor_name: 'Carol Zhang'
      }),
      (err) => err instanceof ContractError && /non-negative/.test(err.message)
    );

    await assert.rejects(
      () => createContract(db, {
        supplier_id: 1,
        department_id: 1,
        title: 'Missing ACV',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        actor_name: 'Carol Zhang'
      }),
      (err) => err instanceof ContractError && /annual_value_cents/.test(err.message)
    );

    await assert.rejects(
      () => createContract(db, {
        supplier_id: 1,
        department_id: 1,
        title: 'Float line price',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        actor_name: 'Carol Zhang',
        items: [{ description: 'Seat', quantity: 1, unit_price: 99.5 }]
      }),
      (err) => err instanceof ContractError && /integer number of cents/.test(err.message)
    );
  });

  await t.test('requires supplier and department', async () => {
    await assert.rejects(
      () => createContract(db, {
        department_id: 1,
        title: 'No supplier',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        annual_value_cents: 100,
        actor_name: 'Carol Zhang'
      }),
      /supplier_id is required/
    );

    await assert.rejects(
      () => createContract(db, {
        supplier_id: 99,
        department_id: 1,
        title: 'Unknown supplier',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        annual_value_cents: 100,
        actor_name: 'Carol Zhang'
      }),
      /does not match a supplier/
    );

    await assert.rejects(
      () => createContract(db, {
        supplier_id: 1,
        title: 'No department',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        annual_value_cents: 100,
        actor_name: 'Carol Zhang'
      }),
      /department_id is required/
    );
  });

  await t.test('createRenewalRequisition generates sequential approval-routed PR with copied line items', async () => {
    const list = await listContracts(db, { today: '2026-09-14' });
    const contract = list[0];

    const result = await createRenewalRequisition(db, contract.id, {
      requester_id: 1,
      notes: 'Standard renewal for design team',
      today: '2026-09-14'
    });

    assert.ok(result.pr_id > 0);
    assert.ok(result.pr_number.startsWith('PR-'));
    assert.equal(result.total_amount_cents, 540000);

    const pr = await db.prepare(`SELECT * FROM purchase_requisitions WHERE id = ?`).get(result.pr_id);
    assert.equal(pr.status, 'pending_approval');
    assert.equal(pr.total_amount, contract.annual_value_cents);
    assert.equal(pr.source_contract_id, contract.id);
    assert.equal(pr.contract_use_status, 'proposed');
    assert.ok(pr.justification.includes('Figma Enterprise Organization'));
    assert.ok(pr.justification.includes(contract.contract_number));

    const prItems = await db.prepare(`SELECT * FROM requisition_items WHERE requisition_id = ?`).all(result.pr_id);
    assert.equal(prItems.length, 1);
    assert.equal(prItems[0].quantity, 10);
    assert.equal(prItems[0].unit_price, 54000);
    assert.equal(prItems[0].total_price, 540000);
    assert.equal(prItems[0].line_type, 'service');
    assert.equal(prItems[0].estimated_supplier_id, 1);

    const approvals = await db.prepare(
      `SELECT * FROM approval_requests WHERE requisition_id = ? ORDER BY step_order`
    ).all(result.pr_id);
    assert.equal(approvals.length, 2);
    assert.equal(approvals[0].status, 'pending');
    assert.equal(approvals[1].status, 'waiting');
    assert.equal(approvals[0].approver_id, 2);
    assert.equal(approvals[1].approver_id, 3);

    const prAudit = await db.prepare(
      `SELECT action, actor_name FROM audit_logs WHERE entity_type = 'requisition' AND entity_id = ? AND action = 'SUBMITTED'`
    ).get(result.pr_id);
    assert.equal(prAudit.action, 'SUBMITTED');
    assert.equal(prAudit.actor_name, 'Alice Chen');

    const proposed = await db.prepare(
      `SELECT action FROM audit_logs WHERE entity_type = 'requisition' AND entity_id = ? AND action = 'CONTRACT_PROPOSED'`
    ).get(result.pr_id);
    assert.ok(proposed);
  });

  await t.test('refuses a second open renewal PR for the same contract', async () => {
    const list = await listContracts(db, { today: '2026-09-14' });
    await assert.rejects(
      () => createRenewalRequisition(db, list[0].id, { requester_id: 1, today: '2026-09-14' }),
      (err) => err instanceof ContractError && /already pending_approval/.test(err.message)
    );
  });

  await t.test('refuses renewal when expired or cancelled', async () => {
    const expired = await createContract(db, {
      supplier_id: 1,
      department_id: 1,
      title: 'Expired GitHub seats',
      category: 'Software & Cloud',
      start_date: '2025-01-01',
      end_date: '2026-01-01',
      annual_value_cents: 25200,
      actor_name: 'Carol Zhang'
    });
    await assert.rejects(
      () => createRenewalRequisition(db, expired.id, { requester_id: 1, today: '2026-09-14' }),
      /cannot be renewed while status is expired/
    );

    await db.prepare(`UPDATE contracts SET status = 'cancelled' WHERE id = ?`).run(expired.id);
    await assert.rejects(
      () => createRenewalRequisition(db, expired.id, { requester_id: 1, today: '2026-09-14' }),
      /cannot be renewed while status is cancelled/
    );
  });

  await t.test('detail fetch 404s for unknown id', async () => {
    await assert.rejects(
      () => getContractDetail(db, 999),
      (err) => err instanceof ContractError && err.statusCode === 404
    );
  });
});
