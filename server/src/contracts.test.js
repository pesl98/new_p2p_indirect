import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from './db.js';
import {
  listContracts,
  getContractDetail,
  createContract,
  createRenewalRequisition,
  computeContractStatus
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

test('contracts lifecycle and renewal generator', async (t) => {
  const db = await makeTestDb();

  await t.test('computes dynamic status correctly based on end_date and notice window', () => {
    const today = '2026-09-01';

    // 60 days in future with 30-day notice -> active
    assert.equal(computeContractStatus({ end_date: '2026-11-01', notice_period_days: 30 }, today), 'active');

    // 20 days in future with 30-day notice -> expiring_soon
    assert.equal(computeContractStatus({ end_date: '2026-09-20', notice_period_days: 30 }, today), 'expiring_soon');

    // Past end date -> expired
    assert.equal(computeContractStatus({ end_date: '2026-08-15', notice_period_days: 30 }, today), 'expired');

    // Cancelled contract stays cancelled
    assert.equal(computeContractStatus({ end_date: '2026-11-01', notice_period_days: 30, status: 'cancelled' }, today), 'cancelled');
  });

  await t.test('creates contract with sequential CNT-YYYY-NNN numbering and items', async () => {
    const contract = await createContract(db, {
      supplier_id: 1,
      department_id: 1,
      title: 'Figma Enterprise Organization',
      category: 'Software & Cloud',
      start_date: '2025-10-01',
      end_date: '2026-09-30',
      notice_period_days: 30,
      annual_value_cents: 540000,
      auto_renew: 1,
      items: [
        {
          description: 'Figma Annual User Seat',
          quantity: 10,
          unit_price: 54000,
          line_type: 'service'
        }
      ]
    });

    assert.ok(contract.contract_number.startsWith('CNT-'));
    assert.equal(contract.title, 'Figma Enterprise Organization');
    assert.equal(contract.annual_value_cents, 540000);
    assert.equal(contract.items.length, 1);
    assert.equal(contract.items[0].quantity, 10);
    assert.equal(contract.items[0].unit_price, 54000);

    const list = await listContracts(db);
    assert.equal(list.length, 1);
    assert.equal(list[0].supplier_name, 'CloudCore Software');
  });

  await t.test('createRenewalRequisition generates approval-routed PR with copied line items', async () => {
    const list = await listContracts(db);
    const contract = list[0];

    const result = await createRenewalRequisition(db, contract.id, {
      requester_id: 1,
      notes: 'Standard renewal for design team'
    });

    assert.ok(result.pr_id > 0);
    assert.ok(result.pr_number.startsWith('PR-'));

    // Verify PR in database
    const pr = await db.prepare(`SELECT * FROM purchase_requisitions WHERE id = ?`).get(result.pr_id);
    assert.equal(pr.status, 'pending_approval');
    assert.equal(pr.total_amount, contract.annual_value_cents);
    assert.ok(pr.justification.includes('Figma Enterprise Organization'));

    // Verify line items copied
    const prItems = await db.prepare(`SELECT * FROM requisition_items WHERE requisition_id = ?`).all(result.pr_id);
    assert.equal(prItems.length, 1);
    assert.equal(prItems[0].quantity, 10);
    assert.equal(prItems[0].unit_price, 54000);
    assert.equal(prItems[0].line_type, 'service');

    // Verify approval requests were created
    const approvals = await db.prepare(`SELECT * FROM approval_requests WHERE requisition_id = ?`).all(result.pr_id);
    assert.ok(approvals.length > 0);
    assert.equal(approvals[0].status, 'pending');
  });
});

