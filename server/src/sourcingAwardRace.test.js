import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeAward } from './sourcingAwardService.js';
import { cancelEvent } from './sourcingService.js';
import { boot, budget, post, seedClosedEvent, withFlag, withServer } from './sourcingAwardKit.js';

const CAROL = { id: 3, name: 'Carol Zhang', role: 'procurement' };

async function evaluatedEvent(db, base) {
  const seeded = await seedClosedEvent(db, { unitPrice: 20000, lineCount: 2 });
  const evaluated = await post(base, `/api/sourcing/events/${seeded.eventId}/evaluate`, 3, { row_version: 0 });
  assert.equal(evaluated.status, 200, JSON.stringify(evaluated.body));
  return { seeded, version: evaluated.body.row_version };
}

describe('B3: cancel versus award', () => {
  test('cancel refuses when an award appears after its first read (the UPDATE checks it itself)', async () => {
    const { db, app } = await boot();
    await budget(db);
    await withFlag(() => withServer(app, async (base) => {
      const { seeded, version } = await evaluatedEvent(db, base);
      // The award lands before cancel's transaction starts.
      const award = await post(base, `/api/sourcing/events/${seeded.eventId}/awards`, 3, {
        award_type: 'full', bid_id: seeded.bids[0].bid_id, row_version: version
      });
      assert.equal(award.status, 201, JSON.stringify(award.body));
      // The award exists, but cancel's first read is stale: the open-award precheck sees nothing.
      const original = db.prepare.bind(db);
      let hidden = 0;
      db.prepare = (sql) => {
        if (/FROM sourcing_awards/.test(sql) && /LIMIT 1/.test(sql) && !/NOT EXISTS/.test(sql) && hidden === 0) {
          hidden += 1;
          return { get: async () => undefined, run: async () => ({ changes: 0 }), all: async () => [] };
        }
        return original(sql);
      };
      await assert.rejects(
        cancelEvent(db, CAROL, seeded.eventId, { reason: 'Toch niet doorgaan' }),
        (e) => e.statusCode === 409 && e.code === 'award_open'
      );
      assert.equal(hidden, 1, 'the stale read was used');
      db.prepare = original;
      const row = await db.prepare(`SELECT status FROM sourcing_events WHERE id = ?`).get(seeded.eventId);
      assert.equal(row.status, 'evaluated');
    }));
  });

  test('propose re-checks the RFQ status in its own transaction: a cancel that lands first wins', async () => {
    const { db, app } = await boot();
    await budget(db);
    await withFlag(() => withServer(app, async (base) => {
      const { seeded, version } = await evaluatedEvent(db, base);
      // Cancel after propose's reads but before its transaction: flip the status when the txn opens.
      const originalTx = db.immediateTransaction.bind(db);
      db.immediateTransaction = (fn) => originalTx(async (...args) => {
        await db.prepare(`UPDATE sourcing_events SET status = 'cancelled', cancel_reason = 'x', cancelled_at = '2026-10-10T00:00:00Z', cancelled_before_deadline = 0 WHERE id = ?`).run(seeded.eventId);
        return fn(...args);
      });
      await assert.rejects(
        proposeAward(db, CAROL, seeded.eventId, { award_type: 'full', bid_id: seeded.bids[0].bid_id, row_version: version }),
        (e) => e.statusCode === 409
      );
      db.immediateTransaction = originalTx;
      const awards = await db.prepare(`SELECT COUNT(*) AS n FROM sourcing_awards`).get();
      assert.equal(Number(awards.n), 0, 'no award on a cancelled RFQ');
      const prs = await db.prepare(`SELECT COUNT(*) AS n FROM purchase_requisitions`).get();
      assert.equal(Number(prs.n), 0, 'no requisition either');
    }));
  });

  test('concurrent cancel and propose: exactly one wins and the RFQ is never both', async () => {
    const { db, app } = await boot();
    await budget(db);
    await withFlag(() => withServer(app, async (base) => {
      const { seeded, version } = await evaluatedEvent(db, base);
      const results = await Promise.allSettled([
        proposeAward(db, CAROL, seeded.eventId, { award_type: 'full', bid_id: seeded.bids[0].bid_id, row_version: version }),
        cancelEvent(db, CAROL, seeded.eventId, { reason: 'Gelijktijdig geannuleerd' })
      ]);
      const wins = results.filter((r) => r.status === 'fulfilled').length;
      assert.equal(wins, 1, JSON.stringify(results.map((r) => r.status)));
      const loser = results.find((r) => r.status === 'rejected');
      assert.equal(loser.reason.statusCode, 409);
      const event = await db.prepare(`SELECT status FROM sourcing_events WHERE id = ?`).get(seeded.eventId);
      const awards = await db.prepare(`SELECT COUNT(*) AS n FROM sourcing_awards`).get();
      assert.ok(
        (event.status === 'cancelled' && Number(awards.n) === 0)
        || (event.status === 'evaluated' && Number(awards.n) === 1),
        `status ${event.status} with ${awards.n} awards`
      );
    }));
  });
});
