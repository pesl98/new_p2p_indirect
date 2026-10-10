import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { authHeaders, boot, budget, json, post, seedClosedEvent, withFlag, withServer } from './sourcingAwardKit.js';

async function get(base, path, userId) {
  return json(await fetch(`${base}${path}`, { headers: authHeaders(userId) }));
}

async function proposed(base, db, seeded) {
  const evaluated = await post(base, `/api/sourcing/events/${seeded.eventId}/evaluate`, 3, { row_version: 0 });
  const award = await post(base, `/api/sourcing/events/${seeded.eventId}/awards`, 3, {
    award_type: 'full', bid_id: seeded.bids[0].bid_id, row_version: evaluated.body.row_version
  });
  assert.equal(award.status, 201, JSON.stringify(award.body));
  return award;
}

describe('award snapshot redaction in the event view', () => {
  test('owner, admin, finance and clean evaluators see prices; other buyers and conflicted evaluators do not', async () => {
    const { db, app } = await boot();
    await budget(db);
    const seeded = await seedClosedEvent(db, { unitPrice: 80000, lineCount: 2 });
    await withFlag(() => withServer(app, async (base) => {
      const award = await proposed(base, db, seeded);
      // The proposer (owner) gets the full snapshot in the response itself.
      assert.ok(award.body.event.award.comparison_snapshot.matrix, 'owner response keeps the matrix');
      const view = async (userId) => (await get(base, `/api/sourcing/events/${seeded.eventId}`, userId)).body;

      for (const userId of [3, 4, 5]) {
        const body = await view(userId);
        assert.ok(body.award.comparison_snapshot.matrix, `user ${userId} sees prices`);
        assert.equal(body.award.snapshot_redacted, undefined);
      }
      // Frank is a buyer, not the owner and not an evaluator.
      let body = await view(6);
      assert.equal(body.award.snapshot_redacted, true);
      let text = JSON.stringify(body.award.comparison_snapshot);
      assert.doesNotMatch(text, /unit_price_cents|total_score|matrix|supplier_name/);

      // Frank, named evaluator with a clean declaration, may see them.
      await db.prepare(`
        INSERT INTO sourcing_evaluators (event_id, user_id, coi_status, coi_declared_at, added_by_user_id, created_at)
        VALUES (?, 6, 'none_declared', '2026-10-09T09:00:00.000Z', 3, '2026-10-01T00:00:00.000Z')
      `).run(seeded.eventId);
      body = await view(6);
      assert.ok(body.award.comparison_snapshot.matrix);

      // A declared conflict takes them away again.
      await db.prepare(`UPDATE sourcing_evaluators SET coi_status = 'conflict_declared', coi_note = 'Neef' WHERE event_id = ? AND user_id = 6`).run(seeded.eventId);
      body = await view(6);
      assert.equal(body.award.snapshot_redacted, true);
      text = JSON.stringify(body);
      assert.doesNotMatch(text, /"unit_price_cents"/);
    }));
  });

  test('a mutating call made without an actor never returns prices (fail closed)', async () => {
    const { db, app } = await boot();
    await budget(db);
    const seeded = await seedClosedEvent(db, { unitPrice: 80000, lineCount: 2 });
    await withFlag(() => withServer(app, async (base) => {
      await proposed(base, db, seeded);
      const { getEvent } = await import('./sourcingService.js');
      const anonymous = await getEvent(db, seeded.eventId);
      assert.equal(anonymous.award.snapshot_redacted, true);
      assert.equal(anonymous.award.comparison_snapshot.matrix, undefined);
    }));
  });
});

describe('RFQ file membership', () => {
  test('a user named on another RFQ cannot download this RFQ\'s attachments', async () => {
    const { db, app } = await boot();
    const a = await seedClosedEvent(db, { number: 'RFQ-2026-100' });
    const b = await seedClosedEvent(db, { number: 'RFQ-2026-101' });
    const file = await db.prepare(`
      INSERT INTO sourcing_files (event_id, owner_kind, filename, content_type, size_bytes, sha256, uploaded_by_user_id, created_at)
      VALUES (?, 'event', 'spec.pdf', 'application/pdf', 20, 'abc', 3, '2026-10-01T00:00:00.000Z')
    `).run(a.eventId);
    const fileId = Number(file.lastInsertRowid);
    await db.prepare(`INSERT INTO sourcing_file_blobs (file_id, bytes) VALUES (?, ?)`)
      .run(fileId, Buffer.from('%PDF-1.4\n%%EOF\n'));
    await db.prepare(`
      INSERT INTO sourcing_evaluators (event_id, user_id, added_by_user_id, created_at)
      VALUES (?, 1, 3, '2026-10-01T00:00:00.000Z')
    `).run(b.eventId);
    await withFlag(() => withServer(app, async (base) => {
      const path = `/api/sourcing/events/${a.eventId}/files/${fileId}`;
      const outsider = await fetch(`${base}${path}`, { headers: authHeaders(1) });
      assert.equal(outsider.status, 403);
      const owner = await fetch(`${base}${path}`, { headers: authHeaders(3) });
      assert.equal(owner.status, 200);
      await db.prepare(`
        INSERT INTO sourcing_evaluators (event_id, user_id, added_by_user_id, created_at)
        VALUES (?, 1, 3, '2026-10-01T00:00:00.000Z')
      `).run(a.eventId);
      const named = await fetch(`${base}${path}`, { headers: authHeaders(1) });
      assert.equal(named.status, 200);
      // Asking for A's file through B's id does not work either.
      const crossed = await fetch(`${base}/api/sourcing/events/${b.eventId}/files/${fileId}`, { headers: authHeaders(3) });
      assert.equal(crossed.status, 404);
    }));
  });
});

describe('conflict declarations are one-way', () => {
  test('the declarer cannot withdraw a conflict; only an admin clears it, with a reason, audited', async () => {
    const { db, app } = await boot();
    await budget(db);
    const seeded = await seedClosedEvent(db, { unitPrice: 80000, lineCount: 2 });
    await db.prepare(`
      INSERT INTO sourcing_evaluators (event_id, user_id, added_by_user_id, created_at)
      VALUES (?, 6, 3, '2026-10-01T00:00:00.000Z')
    `).run(seeded.eventId);
    await withFlag(() => withServer(app, async (base) => {
      const path = `/api/sourcing/events/${seeded.eventId}/coi`;
      assert.equal((await post(base, path, 6, { status: 'none_declared' })).status, 200);
      const conflict = await post(base, path, 6, { status: 'conflict_declared', note: 'Neef bij de leverancier' });
      assert.equal(conflict.status, 200);
      const withdraw = await post(base, path, 6, { status: 'none_declared' });
      assert.equal(withdraw.status, 409);
      assert.equal(withdraw.body.code, 'coi_locked');
      const row = await db.prepare(`SELECT coi_status FROM sourcing_evaluators WHERE event_id = ? AND user_id = 6`).get(seeded.eventId);
      assert.equal(row.coi_status, 'conflict_declared');

      const clear = `${path}/clear`;
      assert.equal((await post(base, clear, 3, { user_id: 6, reason: 'Eigenaar mag dit niet' })).status, 403, 'owner is not admin');
      assert.equal((await post(base, clear, 5, { user_id: 6, reason: 'kort' })).status, 400);
      const cleared = await post(base, clear, 5, { user_id: 6, reason: 'Verklaring was een vergissing' });
      assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
      assert.equal(cleared.body.coi_status, 'pending');
      const audit = await db.prepare(`SELECT details FROM audit_logs WHERE action = 'COI_CLEARED'`).get();
      assert.match(audit.details, /vergissing/);
      const compliance = await db.prepare(`SELECT actor_name, details FROM compliance_audit_events WHERE action = 'SOURCING_COI_CLEARED'`).get();
      assert.equal(compliance.actor_name, 'Elena Rostova');
      assert.match(compliance.details, /Neef bij de leverancier/);
      assert.equal((await post(base, path, 6, { status: 'none_declared' })).status, 200, 'can declare again');
    }));
  });

  test('a conflict cannot be cleared while an award is open', async () => {
    const { db, app } = await boot();
    await budget(db);
    const seeded = await seedClosedEvent(db, { unitPrice: 80000, lineCount: 2 });
    await db.prepare(`
      INSERT INTO sourcing_evaluators (event_id, user_id, coi_status, coi_note, added_by_user_id, created_at)
      VALUES (?, 6, 'conflict_declared', 'Neef', 3, '2026-10-01T00:00:00.000Z')
    `).run(seeded.eventId);
    await withFlag(() => withServer(app, async (base) => {
      await proposed(base, db, seeded);
      const res = await post(base, `/api/sourcing/events/${seeded.eventId}/coi/clear`, 5, { user_id: 6, reason: 'Toch geen conflict' });
      assert.equal(res.status, 409);
      assert.equal(res.body.code, 'award_open');
    }));
  });
});
