import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, budget, post, seedClosedEvent, withFlag, withServer } from './sourcingAwardKit.js';

/**
 * Counts what a Turso interactive transaction costs on the wire: every
 * prepared statement, one extra SELECT last_insert_rowid() per INSERT, and the
 * BEGIN and COMMIT. The limit per transaction is 25 (plan §6.1).
 */
function watchPipeline(db) {
  const results = [];
  let current = null;
  const originalPrepare = db.prepare.bind(db);
  const originals = {
    transaction: db.transaction.bind(db),
    immediateTransaction: db.immediateTransaction.bind(db)
  };
  db.prepare = (sql) => {
    const stmt = originalPrepare(sql);
    const isInsert = /^\s*INSERT/i.test(sql);
    const wrap = (method) => (...args) => {
      if (current) {
        current.prepared += 1;
        if (isInsert && method === 'run') current.inserts += 1;
      }
      return stmt[method](...args);
    };
    return { run: wrap('run'), get: wrap('get'), all: wrap('all') };
  };
  for (const name of Object.keys(originals)) {
    db[name] = (fn) => originals[name](async (...args) => {
      const outer = current;
      if (!outer) current = { prepared: 0, inserts: 0 };
      const mine = current;
      try {
        return await fn(...args);
      } finally {
        if (!outer) {
          results.push({ prepared: mine.prepared, pipeline: mine.prepared + mine.inserts + 2 });
          current = null;
        }
      }
    });
  }
  return {
    results,
    restore() {
      db.prepare = originalPrepare;
      db.transaction = originals.transaction;
      db.immediateTransaction = originals.immediateTransaction;
    }
  };
}

describe('statement budget with BEGIN, COMMIT and last_insert_rowid counted', () => {
  test('at 50 lines and 20 suppliers every transaction stays within 25, and the award within 23', async () => {
    const { db, app } = await boot();
    for (let id = 4; id <= 23; id += 1) {
      await db.prepare(`INSERT INTO suppliers (id, name, code, email, status) VALUES (?, ?, ?, ?, 'active')`)
        .run(id, `Cap ${id}`, `CAP${id}`, `cap${id}@supply.test`);
    }
    await budget(db);
    const supplierIds = [2, ...Array.from({ length: 19 }, (_, index) => index + 4)];
    const seeded = await seedClosedEvent(db, { number: 'RFQ-2026-180', lineCount: 50, supplierIds, unitPrice: 30000 });
    const watch = watchPipeline(db);
    const measured = {};
    try {
      await withFlag(() => withServer(app, async (base) => {
        let mark = watch.results.length;
        const evaluated = await post(base, `/api/sourcing/events/${seeded.eventId}/evaluate`, 3, { row_version: 0 });
        assert.equal(evaluated.status, 200, JSON.stringify(evaluated.body));
        measured.evaluate = watch.results.slice(mark);

        mark = watch.results.length;
        const award = await post(base, `/api/sourcing/events/${seeded.eventId}/awards`, 3, {
          award_type: 'split',
          row_version: evaluated.body.row_version,
          lines: seeded.lines.map((line, index) => ({
            event_line_id: line.id,
            bid_id: seeded.bids[index % seeded.bids.length].bid_id
          }))
        });
        assert.equal(award.status, 201, JSON.stringify(award.body));
        measured.award = watch.results.slice(mark);

        mark = watch.results.length;
        for (;;) {
          const pending = await db.prepare(`
            SELECT id, approver_id FROM approval_requests WHERE requisition_id = ? AND status = 'pending'
          `).get(award.body.award.award_requisition_id);
          if (!pending) break;
          const decided = await post(base, `/api/approvals/${pending.id}/decide`, pending.approver_id, { decision: 'approved', comments: 'ok' });
          assert.equal(decided.status, 200, JSON.stringify(decided.body));
        }
        measured.approval = watch.results.slice(mark);

        mark = watch.results.length;
        const pos = await post(base, `/api/sourcing/events/${seeded.eventId}/purchase-orders`, 3, {});
        assert.equal(pos.status, 201, JSON.stringify(pos.body));
        assert.equal(pos.body.done, true);
        assert.equal(pos.body.purchase_orders.length, 20);
        measured.purchase_orders = watch.results.slice(mark);
      }));
    } finally {
      watch.restore();
    }
    console.log(`# STATEMENTS (prepared/pipeline incl BEGIN+COMMIT): ${JSON.stringify(measured)}`);
    for (const [name, rows] of Object.entries(measured)) {
      assert.ok(rows.length > 0, name);
      for (const row of rows) assert.ok(row.pipeline <= 25, `${name} used ${row.pipeline} pipeline statements`);
    }
    for (const row of measured.award) assert.ok(row.pipeline <= 23, `award used ${row.pipeline}`);
  });
});
