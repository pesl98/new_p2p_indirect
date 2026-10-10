import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { decideApprovalStep, listApprovalInbox } from './approvalsService.js';
import { insertApprovalChain } from './approvalPolicy.js';
import { currentFiscalYear } from './fiscalYear.js';
import { seedWorld } from './sourcingAwardFixtures.js';

describe('the fiscal year is read live', () => {
  test('changing FISCAL_YEAR after start-up moves approvals and the inbox to the new year', async () => {
    const previous = process.env.FISCAL_YEAR;
    const db = await seedWorld();
    const first = currentFiscalYear();
    try {
      process.env.FISCAL_YEAR = '2031';
      assert.equal(currentFiscalYear(), 2031);
      await db.prepare(`
        INSERT INTO budgets (department_id, fiscal_year, total_budget, committed_amount, actual_spent)
        VALUES (1, 2031, 5000000, 100000, 0)
      `).run();
      const pr = await db.prepare(`
        INSERT INTO purchase_requisitions (pr_number, requester_id, department_id, status, total_amount, justification, needed_by_date)
        VALUES ('PR-LIVE-1', 1, 1, 'pending_approval', 50000, 'x', '2031-02-01')
      `).run();
      const prId = Number(pr.lastInsertRowid);
      await insertApprovalChain(db, prId, 50000, 1);
      const inbox = await listApprovalInbox(db, { approver_id: 2 });
      assert.equal(Number(inbox[0].total_budget), 5000000, 'the inbox shows the 2031 budget');
      const step = await db.prepare(`SELECT id, approver_id FROM approval_requests WHERE requisition_id = ?`).get(prId);
      await decideApprovalStep(db, { approvalId: step.id, decision: 'approved', approver_id: step.approver_id, approver_name: 'Bob' });
      const budget2031 = await db.prepare(`SELECT committed_amount FROM budgets WHERE fiscal_year = 2031`).get();
      const budgetFirst = await db.prepare(`SELECT committed_amount FROM budgets WHERE fiscal_year = ?`).get(first);
      assert.equal(Number(budget2031.committed_amount), 150000);
      assert.equal(Number(budgetFirst.committed_amount), 200000, 'the start-up year was not touched');

      // And back again without restarting anything.
      process.env.FISCAL_YEAR = String(first);
      const inboxAgain = await listApprovalInbox(db, { approver_id: 2, status: 'approved' });
      assert.ok(Array.isArray(inboxAgain));
    } finally {
      if (previous == null) delete process.env.FISCAL_YEAR; else process.env.FISCAL_YEAR = previous;
    }
  });

  test('no module freezes the year at import time', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname));
    const offenders = [];
    for (const name of fs.readdirSync(root)) {
      if (!name.endsWith('.js') || name.endsWith('.test.js')) continue;
      const source = fs.readFileSync(path.join(root, name), 'utf8');
      if (/^(export )?const \w*FISCAL_YEAR\w* = (currentFiscalYear\(\)|\d{4})/m.test(source)) offenders.push(name);
    }
    assert.deepEqual(offenders, []);
  });
});
