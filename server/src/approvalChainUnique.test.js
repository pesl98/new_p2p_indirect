import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApprovalSteps } from './approvalPolicy.js';
import { seedWorld } from './sourcingAwardFixtures.js';

const ids = (steps) => steps.map((step) => step.approver_id);

describe('fallback routing does not put one user on two steps', () => {
  test('award chain: a fallback user is not picked again by a later step', async () => {
    const db = await seedWorld();
    // Bob (department head) and Carol (procurement) are excluded: the old result was [6, 6, 4].
    const steps = await buildApprovalSteps({ totalAmount: 2_000_000, departmentId: 1, db, excludeUserIds: [2, 3] });
    assert.deepEqual(ids(steps), [6, 4, 5]);
    assert.equal(new Set(ids(steps)).size, 3);
  });

  test('requisition chain: the requester is routed around and the fallback is not repeated', async () => {
    const db = await seedWorld();
    // Bob raised it. Step 1 falls back to Carol (3); the procurement step must not be Carol again.
    const steps = await buildApprovalSteps({ totalAmount: 2_000_000, departmentId: 1, db, excludeUserIds: [2] });
    assert.deepEqual(ids(steps), [3, 6, 4]);
  });

  test('with no other procurement user the step escalates, and with nobody at all the old repeat stays', async () => {
    const db = await seedWorld();
    await db.prepare(`UPDATE users SET status = 'inactive' WHERE id = 6`).run();
    // Bob raised it. Carol takes step 1 as the fallback; step 2 escalates to finance instead of repeating Carol.
    let steps = await buildApprovalSteps({ totalAmount: 150_000, departmentId: 1, db, excludeUserIds: [2] });
    assert.deepEqual(ids(steps), [3, 4]);
    // Nobody else is active: the repeat is kept (as before) rather than failing a chain that could be built.
    await db.prepare(`UPDATE users SET status = 'inactive' WHERE id IN (4, 5)`).run();
    steps = await buildApprovalSteps({ totalAmount: 150_000, departmentId: 1, db, excludeUserIds: [2] });
    assert.deepEqual(ids(steps), [3, 3]);
    // An excluded user is still always replaced, and with nobody left it fails closed.
    await assert.rejects(
      buildApprovalSteps({ totalAmount: 2_000_000, departmentId: 1, db, excludeUserIds: [2, 3, 6, 4, 5] }),
      (e) => e.statusCode === 422 && e.code === 'sod_no_alternate_approver'
    );
  });

  test('no exclusions: the chain is exactly what it was (a user may hold two steps by role)', async () => {
    const db = await seedWorld();
    await db.prepare(`UPDATE departments SET approver_user_id = 3 WHERE id = 1`).run();
    const steps = await buildApprovalSteps({ totalAmount: 2_000_000, departmentId: 1, db });
    assert.deepEqual(ids(steps), [3, 3, 4]);
  });
});
