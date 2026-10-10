import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { call, seedWorld, withApp } from './sourcingAwardFixtures.js';

describe('contract writes and renewals are limited to procurement and admin', () => {
  test('requester, approver and finance get 403 on renew and register; the screen hides the same buttons', async () => {
    const db = await seedWorld();
    await withApp(db, async (base) => {
      for (const userId of [1, 2, 4]) {
        const renew = await call(base, userId, 'POST', '/api/contracts/1/renew-pr', { requester_id: userId });
        assert.equal(renew.status, 403, `user ${userId}`);
        const register = await call(base, userId, 'POST', '/api/contracts', { title: 'x' });
        assert.equal(register.status, 403, `user ${userId}`);
      }
      // Procurement passes the gate (the contract does not exist, so it is a 404 or 400, not a 403).
      const allowed = await call(base, 3, 'POST', '/api/contracts/999/renew-pr', { requester_id: 3 });
      assert.notEqual(allowed.status, 403);
    });
    const { readFileSync } = await import('node:fs');
    const view = readFileSync(new URL('../../client/src/views/ContractsView.jsx', import.meta.url), 'utf8');
    assert.match(view, /CONTRACT_MANAGER_ROLES = \['procurement', 'admin'\]/);
    assert.match(view, /!canManage \? null/);
  });
});
