import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from './db.js';
import { insertDemoData } from './seed.js';
import { demoPortalSecret, seedSourcingDemo } from './sourcingDemoSeed.js';
import { loadPortalView } from './sourcingPortalService.js';

describe('sourcing demo seed', () => {
  test('creates the three RFQs, stores only token hashes, and prints working links', async () => {
    const db = await createMemoryDatabase();
    await insertDemoData(db);
    const now = new Date('2026-10-20T12:00:00Z');
    const links = await seedSourcingDemo(db, { now, env: { NODE_ENV: 'test' } });

    const events = await db.prepare(`SELECT event_number, status FROM sourcing_events ORDER BY id`).all();
    assert.deepEqual(events.map((e) => [e.event_number, e.status]), [
      ['RFQ-2026-001', 'published'], ['RFQ-2026-002', 'closed'], ['RFQ-2026-003', 'awarded']
    ]);
    const bids = await db.prepare(`SELECT event_id, COUNT(*) AS n FROM sourcing_bids GROUP BY event_id ORDER BY event_id`).all();
    assert.deepEqual(bids.map((b) => Number(b.n)), [2, 3, 3]);
    const coi = await db.prepare(`SELECT coi_status FROM sourcing_evaluators WHERE user_id = 4`).get();
    assert.equal(coi.coi_status, 'conflict_declared');
    const pos = await db.prepare(`SELECT COUNT(*) AS n FROM purchase_orders WHERE award_id IS NOT NULL`).get();
    assert.equal(Number(pos.n), 2, 'split award converted to one PO per supplier');

    assert.equal(links.length, 3);
    const stored = JSON.stringify(await db.prepare(`SELECT * FROM sourcing_invitations`).all());
    for (const link of links) {
      const token = decodeURIComponent(link.url.split('#t=')[1]);
      assert.ok(!stored.includes(token), 'plaintext token is never stored');
    }
  });

  test('production never gets the fixed demo secret', () => {
    assert.equal(demoPortalSecret({ NODE_ENV: 'production' }), null);
    assert.equal(demoPortalSecret({ VERCEL: '1' }), null);
    assert.ok(demoPortalSecret({ NODE_ENV: 'development' }).length >= 32);
    assert.equal(demoPortalSecret({ PORTAL_TOKEN_SECRET: 'x'.repeat(40) }), 'x'.repeat(40));
  });
});
