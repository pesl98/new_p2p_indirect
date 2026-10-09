import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from './app.js';
import { createMemoryDatabase } from './db.js';
import { loadDbConfig } from './dbConfig.js';
import { queryApprovalCompliance } from './complianceReports.js';
import { scoreComparison } from './sourcingScore.js';
import { withCookie } from './testSession.js';

function authHeaders(userId, extra = {}) {
  return withCookie(userId, { headers: extra }).headers;
}

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

async function json(response) {
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { status: response.status, body, headers: response.headers };
}

async function withFlag(fn) {
  const prev = process.env.SOURCING_ENABLED;
  process.env.SOURCING_ENABLED = '1';
  try {
    return await fn();
  } finally {
    if (prev == null) delete process.env.SOURCING_ENABLED;
    else process.env.SOURCING_ENABLED = prev;
  }
}

async function seedWorld(db) {
  await db.prepare(`
    INSERT INTO departments (id, code, name) VALUES
      (1, 'MKT', 'Marketing'),
      (2, 'FIN', 'Finance')
  `).run();
  await db.prepare(`
    INSERT INTO users (id, name, email, role, department_id, title, status) VALUES
      (1, 'Alice Chen', 'alice@example.com', 'requester', 1, 'Specialist', 'active'),
      (2, 'Bob Approver', 'bob@example.com', 'approver', 1, 'Head', 'active'),
      (3, 'Carol Zhang', 'carol@example.com', 'procurement', 1, 'Buyer', 'active'),
      (4, 'David Miller', 'david@example.com', 'finance', 2, 'Controller', 'active'),
      (5, 'Elena Rostova', 'elena@example.com', 'admin', 2, 'CFO', 'active'),
      (6, 'Frank Buyer', 'frank@example.com', 'procurement', 1, 'Buyer', 'active')
  `).run();
  await db.prepare(`
    INSERT INTO suppliers (id, name, code, contact_person, email, status) VALUES
      (1, 'Default Vendor', 'DEF', 'Pat', 'pat@default.test', 'active'),
      (2, 'Active Supply', 'ACT', 'Ann', 'ann@active.test', 'active'),
      (3, 'Paused Supply', 'PAU', 'Paul', 'paul@paused.test', 'inactive')
  `).run();
}

async function boot() {
  const db = await createMemoryDatabase();
  await seedWorld(db);
  return { db, app: createApp({ db, config: loadDbConfig({}) }) };
}

function watchTransactions(db) {
  const counts = [];
  let inTx = false;
  let current = 0;
  const origPrepare = db.prepare.bind(db);
  const origTransaction = db.transaction.bind(db);
  const origImmediate = db.immediateTransaction.bind(db);
  db.prepare = (sql) => {
    const stmt = origPrepare(sql);
    const count = (method) => (...args) => {
      if (inTx) current += 1;
      return stmt[method](...args);
    };
    return { run: count('run'), get: count('get'), all: count('all') };
  };
  const wrap = (factory) => (fn) => factory(async (...args) => {
    const outer = inTx;
    if (!outer) current = 0;
    inTx = true;
    try {
      return await fn(...args);
    } finally {
      inTx = outer;
      if (!outer) counts.push(current);
    }
  });
  db.transaction = wrap(origTransaction);
  db.immediateTransaction = wrap(origImmediate);
  return {
    counts,
    restore() {
      db.prepare = origPrepare;
      db.transaction = origTransaction;
      db.immediateTransaction = origImmediate;
    }
  };
}

/**
 * Insert a closed RFQ with complete quotes. Bids are written while the event
 * is still published, then the deadline is moved into the past.
 */
async function seedClosedEvent(db, {
  number = 'RFQ-2026-100',
  lineCount = 2,
  supplierIds = [2],
  unitPrice = 1000,
  ownerId = 3,
  sourceRequisitionId = null,
  weightPrice = 100,
  weightLead = 0,
  weightQuality = 0,
  validity = null
} = {}) {
  const now = '2026-10-01T10:00:00.000Z';
  const deadline = '2026-10-08T12:00:00.000Z';
  await db.prepare(`
    INSERT INTO sourcing_events (
      event_number, title, category, department_id, owner_user_id, source_requisition_id,
      status, currency, deadline_at, weight_price, weight_lead_time, weight_quality,
      created_at, updated_at
    ) VALUES (?, 'Vergelijking', 'Office Supplies', 1, ?, ?, 'published', 'EUR', ?, ?, ?, ?, ?, ?)
  `).run(number, ownerId, sourceRequisitionId, deadline, weightPrice, weightLead, weightQuality, now, now);
  const event = await db.prepare(`SELECT * FROM sourcing_events WHERE event_number = ?`).get(number);
  for (let index = 0; index < lineCount; index += 1) {
    await db.prepare(`
      INSERT INTO sourcing_event_lines (event_id, line_no, description, category, quantity, line_type)
      VALUES (?, ?, ?, 'Office Supplies', 1, 'goods')
    `).run(event.id, index + 1, `Regel ${index + 1}`);
  }
  const lines = await db.prepare(`SELECT id, line_no FROM sourcing_event_lines WHERE event_id = ? ORDER BY line_no`).all(event.id);
  const bids = [];
  for (let index = 0; index < supplierIds.length; index += 1) {
    const supplierId = supplierIds[index];
    const price = Array.isArray(unitPrice) ? unitPrice[index] : unitPrice;
    const invite = await db.prepare(`
      INSERT INTO sourcing_invitations (event_id, supplier_id, contact_email, invited_by_user_id, created_at)
      VALUES (?, ?, ?, 3, ?)
    `).run(event.id, supplierId, `s${supplierId}@bid.test`, now);
    const invitationId = Number(invite.lastInsertRowid);
    const submitted = `2026-10-0${1 + (index % 7)}T09:00:00.000Z`;
    const bidInsert = await db.prepare(`
      INSERT INTO sourcing_bids (event_id, invitation_id, supplier_id, first_submitted_at, last_submitted_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(event.id, invitationId, supplierId, submitted, submitted);
    const bidId = Number(bidInsert.lastInsertRowid);
    const total = price * lineCount;
    await db.prepare(`
      INSERT INTO sourcing_bid_revisions (
        bid_id, revision, submission_id, total_cents, quoted_line_count, validity_until, content_sha256, submitted_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?)
    `).run(bidId, `sub-${bidId}`, total, lineCount, validity, `hash-${bidId}`, submitted);
    for (const line of lines) {
      await db.prepare(`
        INSERT INTO sourcing_bid_lines (
          bid_id, revision, event_line_id, quoted, unit_price_cents, line_total_cents, lead_time_days
        ) VALUES (?, 1, ?, 1, ?, ?, ?)
      `).run(bidId, line.id, price, price, index + 1);
    }
    bids.push({ bid_id: bidId, supplier_id: supplierId, total_cents: total });
  }
  await db.prepare(`
    UPDATE sourcing_events
    SET status = 'closed', closed_at = ?, deadline_at = ?
    WHERE id = ?
  `).run('2026-10-08T12:00:00.000Z', '2026-10-08T12:00:00.000Z', event.id);
  return { eventId: event.id, lines, bids };
}

async function budget(db, committed = 0) {
  await db.prepare(`
    INSERT INTO budgets (department_id, fiscal_year, total_budget, committed_amount, actual_spent)
    VALUES (1, 2026, 100000000, ?, 0)
  `).run(committed);
}

async function post(base, path, userId, body, extraHeaders = {}) {
  return json(await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { ...authHeaders(userId), 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body)
  }));
}

describe('scoring formula', () => {
  test('matches the fixed price, lead, quality, tie, and incomplete rules', () => {
    const lines = [{ id: 1 }, { id: 2 }];
    const bids = [
      {
        bid_id: 1, supplier_id: 10, status: 'submitted', revision: 1, total_cents: 100,
        first_submitted_at: '2026-10-02T00:00:00.000Z',
        lines: [
          { event_line_id: 1, quoted: true, unit_price_cents: 40, line_total_cents: 40, lead_time_days: 1 },
          { event_line_id: 2, quoted: true, unit_price_cents: 60, line_total_cents: 60, lead_time_days: 1 }
        ]
      },
      {
        bid_id: 2, supplier_id: 11, status: 'submitted', revision: 1, total_cents: 200,
        first_submitted_at: '2026-10-01T00:00:00.000Z',
        lines: [
          { event_line_id: 1, quoted: true, unit_price_cents: 100, line_total_cents: 100, lead_time_days: 3 },
          { event_line_id: 2, quoted: true, unit_price_cents: 100, line_total_cents: 100, lead_time_days: 2 }
        ]
      },
      {
        bid_id: 3, supplier_id: 12, status: 'submitted', revision: 1, total_cents: 40,
        first_submitted_at: '2026-10-01T00:00:00.000Z',
        lines: [{ event_line_id: 1, quoted: true, unit_price_cents: 40, line_total_cents: 40, lead_time_days: 0 }]
      },
      {
        bid_id: 4, supplier_id: 13, status: 'withdrawn', revision: 1, total_cents: 10,
        lines: [
          { event_line_id: 1, quoted: true, unit_price_cents: 1, line_total_cents: 1, lead_time_days: 0 },
          { event_line_id: 2, quoted: true, unit_price_cents: 9, line_total_cents: 9, lead_time_days: 0 }
        ]
      }
    ];
    const scored = scoreComparison({
      lines,
      bids,
      weights: { price: 50, lead: 30, quality: 20 },
      qualityByBid: new Map([[1, [8]], [2, [5]]])
    });
    const byId = new Map(scored.bids.map((bid) => [bid.bid_id, bid]));
    assert.equal(scored.lowest_complete_total_cents, 100);
    assert.equal(byId.get(1).scores.price, 100);
    assert.equal(byId.get(2).scores.price, 50);
    assert.equal(byId.get(1).scores.lead_time, 100);
    assert.equal(byId.get(2).scores.lead_time, 50);
    assert.equal(byId.get(1).scores.quality, 80);
    assert.equal(byId.get(1).scores.total, 96);
    assert.equal(byId.get(2).scores.total, 50);
    assert.equal(byId.get(1).rank, 1);
    assert.equal(byId.get(2).rank, 2);
    assert.equal(byId.get(3).complete, false);
    assert.equal(byId.get(3).rank, null);
    assert.equal(byId.get(3).lines[0].is_lowest, true);
    assert.equal(byId.get(1).lines[0].is_lowest, true);
    assert.equal(byId.get(4).rank, null);
    assert.equal(byId.get(1).scores.total_display, 96);

    const tied = scoreComparison({
      lines: [{ id: 1 }],
      bids: [
        {
          bid_id: 8, supplier_id: 1, status: 'submitted', revision: 1, total_cents: 100,
          first_submitted_at: '2026-10-03T00:00:00.000Z',
          lines: [{ event_line_id: 1, quoted: true, unit_price_cents: 100, line_total_cents: 100, lead_time_days: 2 }]
        },
        {
          bid_id: 9, supplier_id: 2, status: 'submitted', revision: 1, total_cents: 100,
          first_submitted_at: '2026-10-02T00:00:00.000Z',
          lines: [{ event_line_id: 1, quoted: true, unit_price_cents: 100, line_total_cents: 100, lead_time_days: 2 }]
        }
      ],
      weights: { price: 100, lead: 0, quality: 0 }
    });
    assert.equal(tied.bids.find((bid) => bid.bid_id === 9).rank, 1);
    assert.equal(tied.bids.find((bid) => bid.bid_id === 8).rank, 2);

    const unscored = scoreComparison({
      lines: [{ id: 1 }],
      bids: [{
        bid_id: 1, supplier_id: 1, status: 'submitted', revision: 1, total_cents: 50,
        lines: [{ event_line_id: 1, quoted: true, unit_price_cents: 50, line_total_cents: 50, lead_time_days: 1 }]
      }],
      weights: { price: 40, lead: 20, quality: 40 }
    });
    assert.equal(unscored.bids[0].scores.total, null);
    assert.equal(unscored.bids[0].rank, null);
  });
});

describe('award, approval, and purchase orders', () => {
  test('an admin cannot read prices before the deadline', async () => {
    const { db, app } = await boot();
    const now = '2026-10-01T10:00:00.000Z';
    await db.prepare(`
      INSERT INTO sourcing_events (
        event_number, title, department_id, owner_user_id, status, currency, deadline_at, created_at, updated_at
      ) VALUES ('RFQ-2026-200', 'Sealed', 1, 3, 'published', 'EUR', '2099-01-01T00:00:00.000Z', ?, ?)
    `).run(now, now);
    const event = await db.prepare(`SELECT id FROM sourcing_events WHERE event_number = 'RFQ-2026-200'`).get();
    await db.prepare(`
      INSERT INTO sourcing_event_lines (event_id, line_no, description, category, quantity)
      VALUES (?, 1, 'Stoel', 'Office Supplies', 1)
    `).run(event.id);
    const line = await db.prepare(`SELECT id FROM sourcing_event_lines WHERE event_id = ?`).get(event.id);
    await db.prepare(`
      INSERT INTO sourcing_invitations (event_id, supplier_id, contact_email, invited_by_user_id, created_at)
      VALUES (?, 2, 'ann@active.test', 3, ?)
    `).run(event.id, now);
    const invitation = await db.prepare(`SELECT id FROM sourcing_invitations WHERE event_id = ?`).get(event.id);
    await db.prepare(`
      INSERT INTO sourcing_bids (event_id, invitation_id, supplier_id, first_submitted_at, last_submitted_at)
      VALUES (?, ?, 2, ?, ?)
    `).run(event.id, invitation.id, now, now);
    const bid = await db.prepare(`SELECT id FROM sourcing_bids WHERE event_id = ?`).get(event.id);
    await db.prepare(`
      INSERT INTO sourcing_bid_revisions (
        bid_id, revision, submission_id, total_cents, quoted_line_count, content_sha256, submitted_at
      ) VALUES (?, 1, 'sealed', 424242, 1, 'abc', ?)
    `).run(bid.id, now);
    await db.prepare(`
      INSERT INTO sourcing_bid_lines (bid_id, revision, event_line_id, quoted, unit_price_cents, line_total_cents)
      VALUES (?, 1, ?, 1, 424242, 424242)
    `).run(bid.id, line.id);
    await withFlag(() => withServer(app, async (base) => {
      const comparison = await json(await fetch(`${base}/api/sourcing/events/${event.id}/comparison`, {
        headers: authHeaders(5)
      }));
      assert.equal(comparison.status, 200, JSON.stringify(comparison.body));
      assert.equal(comparison.body.sealed, true);
      assert.equal(JSON.stringify(comparison.body).includes('424242'), false);
      assert.equal(comparison.body.matrix, undefined);
    }));
  });

  test('rejects a non-lowest award without a reason, and the database check does too', async () => {
    const { db, app } = await boot();
    const seeded = await seedClosedEvent(db, {
      supplierIds: [2, 1],
      unitPrice: [1000, 2000]
    });
    await withFlag(() => withServer(app, async (base) => {
      const evaluated = await post(base, `/api/sourcing/events/${seeded.eventId}/evaluate`, 3, { row_version: 0 });
      assert.equal(evaluated.status, 200, JSON.stringify(evaluated.body));
      const denied = await post(base, `/api/sourcing/events/${seeded.eventId}/awards`, 3, {
        award_type: 'full',
        bid_id: seeded.bids[1].bid_id,
        row_version: evaluated.body.row_version
      });
      assert.equal(denied.status, 400);
      assert.equal(denied.body.code, 'award_reason_required');
    }));
    await assert.rejects(async () => {
      await db.prepare(`
        INSERT INTO sourcing_awards (
          event_id, award_type, status, total_cents, is_lowest, has_expired_validity,
          reason, comparison_snapshot_json, proposed_by_user_id, proposed_at
        ) VALUES (?, 'full', 'pending_approval', 2000, 0, 0, 'kort', '{}', 3, '2026-10-09T00:00:00.000Z')
      `).run(seeded.eventId);
    }, /CHECK|constraint/i);
  });

  test('a split award becomes one requisition and one PO per supplier, and a repeat does not double them', async () => {
    const { db, app } = await boot();
    await budget(db);
    await db.prepare(`UPDATE suppliers SET id = id WHERE id IN (1, 2)`).run();
    const seeded = await seedClosedEvent(db, { supplierIds: [2, 1], unitPrice: [1500, 1800], lineCount: 2 });
    await withFlag(() => withServer(app, async (base) => {
      const evaluated = await post(base, `/api/sourcing/events/${seeded.eventId}/evaluate`, 3, { row_version: 0 });
      assert.equal(evaluated.status, 200, JSON.stringify(evaluated.body));
      const award = await post(base, `/api/sourcing/events/${seeded.eventId}/awards`, 3, {
        award_type: 'split',
        row_version: evaluated.body.row_version,
        reason: 'Elke regel naar de leverancier van die regel.',
        lines: [
          { event_line_id: seeded.lines[0].id, bid_id: seeded.bids[0].bid_id },
          { event_line_id: seeded.lines[1].id, bid_id: seeded.bids[1].bid_id }
        ]
      });
      assert.equal(award.status, 201, JSON.stringify(award.body));
      const again = await post(base, `/api/sourcing/events/${seeded.eventId}/awards`, 3, {
        award_type: 'split',
        row_version: award.body.event.row_version,
        reason: 'Elke regel naar de leverancier van die regel.',
        lines: [
          { event_line_id: seeded.lines[0].id, bid_id: seeded.bids[0].bid_id },
          { event_line_id: seeded.lines[1].id, bid_id: seeded.bids[1].bid_id }
        ]
      }, { 'Idempotency-Key': 'same-split' });
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.equal(again.body.replayed, true);
      const prs = await db.prepare(`SELECT COUNT(*) AS n FROM purchase_requisitions`).get();
      assert.equal(Number(prs.n), 1);
      const pending = await db.prepare(`
        SELECT id, approver_id FROM approval_requests WHERE requisition_id = ? AND status = 'pending'
      `).get(award.body.award.award_requisition_id);
      const decided = await post(base, `/api/approvals/${pending.id}/decide`, pending.approver_id, {
        decision: 'approved',
        comments: 'Akkoord'
      });
      assert.equal(decided.status, 200, JSON.stringify(decided.body));
      assert.equal(decided.body.outcome, 'approved');
      const pos = await post(base, `/api/sourcing/events/${seeded.eventId}/purchase-orders`, 3, {});
      assert.equal(pos.status, 201, JSON.stringify(pos.body));
      assert.equal(pos.body.purchase_orders.length, 2);
      const repeat = await post(base, `/api/sourcing/events/${seeded.eventId}/purchase-orders`, 6, {});
      assert.equal(repeat.status, 200, JSON.stringify(repeat.body));
      assert.equal(repeat.body.replayed, true);
      assert.equal(repeat.body.purchase_orders.length, 2);
      const stored = await db.prepare(`SELECT COUNT(*) AS n FROM purchase_orders`).get();
      assert.equal(Number(stored.n), 2);
      const notes = await db.prepare(`SELECT notes, requisition_id FROM purchase_orders`).all();
      assert.ok(notes.every((row) => String(row.notes).startsWith('RFQ RFQ-2026-100. Gunning ')));
      assert.ok(notes.every((row) => Number(row.requisition_id) === award.body.award.award_requisition_id));
    }));
  });

  test('above €1.000 the owner is excluded and a delegation back to the owner is forbidden', async () => {
    const { db, app } = await boot();
    await budget(db);
    const seeded = await seedClosedEvent(db, { supplierIds: [2, 1], unitPrice: [80000, 90000], lineCount: 2 });
    await withFlag(() => withServer(app, async (base) => {
      const evaluated = await post(base, `/api/sourcing/events/${seeded.eventId}/evaluate`, 3, { row_version: 0 });
      const award = await post(base, `/api/sourcing/events/${seeded.eventId}/awards`, 3, {
        award_type: 'full',
        bid_id: seeded.bids[0].bid_id,
        row_version: evaluated.body.row_version
      });
      assert.equal(award.status, 201, JSON.stringify(award.body));
      assert.equal(award.body.award.total_cents, 160000);
      const steps = await db.prepare(`
        SELECT approver_id, step_order, status FROM approval_requests
        WHERE requisition_id = ? ORDER BY step_order
      `).all(award.body.award.award_requisition_id);
      assert.deepEqual(steps.map((step) => step.approver_id), [2, 6]);
      await db.prepare(`
        INSERT INTO approval_delegations (delegator_user_id, delegate_user_id, active, reason, created_by_name)
        VALUES (2, 3, 1, 'Afwezig', 'Bob Approver')
      `).run();
      const pending = steps[0];
      const blocked = await post(base, `/api/approvals/${(await db.prepare(`SELECT id FROM approval_requests WHERE requisition_id = ? AND step_order = 1`).get(award.body.award.award_requisition_id)).id}/decide`, 3, {
        decision: 'approved',
        comments: 'Zelf'
      });
      assert.equal(blocked.status, 403);
      assert.equal(blocked.body.code, 'sod_award_self_approval');
      assert.equal(pending.approver_id, 2);
      const report = await queryApprovalCompliance(db);
      assert.equal(report.findings.some((row) => row.code === 'wrong_approver' && row.document_number === award.body.award.pr_number), false);
    }));
  });

  test('with only one procurement user the step escalates, and a forced owner step is reported', async () => {
    const { db, app } = await boot();
    await db.prepare(`UPDATE users SET role = 'requester' WHERE id = 6`).run();
    await budget(db);
    const seeded = await seedClosedEvent(db, { unitPrice: 80000, lineCount: 2 });
    await withFlag(() => withServer(app, async (base) => {
      const evaluated = await post(base, `/api/sourcing/events/${seeded.eventId}/evaluate`, 3, { row_version: 0 });
      const award = await post(base, `/api/sourcing/events/${seeded.eventId}/awards`, 3, {
        award_type: 'full',
        bid_id: seeded.bids[0].bid_id,
        row_version: evaluated.body.row_version
      });
      assert.equal(award.status, 201, JSON.stringify(award.body));
      const steps = await db.prepare(`
        SELECT approver_id FROM approval_requests WHERE requisition_id = ? ORDER BY step_order
      `).all(award.body.award.award_requisition_id);
      assert.deepEqual(steps.map((step) => step.approver_id), [2, 4]);
      await db.prepare(`
        UPDATE approval_requests SET approver_id = 3
        WHERE requisition_id = ? AND step_order = 2
      `).run(award.body.award.award_requisition_id);
      const report = await queryApprovalCompliance(db);
      assert.ok(report.findings.some((row) => row.code === 'sourcing_award_self_approval'));
    }));
  });

  test('fewer than three quotes above €10.000 is a warning and still awards', async () => {
    const { db, app } = await boot();
    await budget(db);
    const seeded = await seedClosedEvent(db, { supplierIds: [2, 1], unitPrice: [700000, 800000], lineCount: 2 });
    await withFlag(() => withServer(app, async (base) => {
      const evaluated = await post(base, `/api/sourcing/events/${seeded.eventId}/evaluate`, 3, { row_version: 0 });
      const award = await post(base, `/api/sourcing/events/${seeded.eventId}/awards`, 3, {
        award_type: 'full',
        bid_id: seeded.bids[0].bid_id,
        row_version: evaluated.body.row_version
      });
      assert.equal(award.status, 201, JSON.stringify(award.body));
      assert.deepEqual(award.body.award.warnings, ['few_quotes']);
      const compliance = await db.prepare(`
        SELECT details FROM compliance_audit_events WHERE action = 'SOURCING_AWARD_PROPOSED'
      `).get();
      assert.equal(JSON.parse(compliance.details).few_quotes, true);
    }));
  });

  test('final approval moves the budget from the source requisition to the award and a rejection leaves no PO', async () => {
    const { db, app } = await boot();
    const source = await db.prepare(`
      INSERT INTO purchase_requisitions (
        pr_number, requester_id, department_id, status, total_amount, justification, needed_by_date
      ) VALUES ('PR-2026-041', 1, 1, 'approved', 50000, 'Schatting', '2026-12-01')
    `).run();
    await budget(db, 50000);
    const seeded = await seedClosedEvent(db, {
      number: 'RFQ-2026-140',
      unitPrice: 40000,
      lineCount: 2,
      sourceRequisitionId: Number(source.lastInsertRowid)
    });
    const rejected = await seedClosedEvent(db, { number: 'RFQ-2026-141', unitPrice: 1000, lineCount: 1 });
    await withFlag(() => withServer(app, async (base) => {
      const evaluated = await post(base, `/api/sourcing/events/${seeded.eventId}/evaluate`, 3, { row_version: 0 });
      const award = await post(base, `/api/sourcing/events/${seeded.eventId}/awards`, 3, {
        award_type: 'full',
        bid_id: seeded.bids[0].bid_id,
        row_version: evaluated.body.row_version
      });
      assert.equal(award.status, 201, JSON.stringify(award.body));
      const steps = await db.prepare(`
        SELECT id, approver_id FROM approval_requests
        WHERE requisition_id = ? ORDER BY step_order
      `).all(award.body.award.award_requisition_id);
      for (const step of steps) {
        const pending = await db.prepare(`
          SELECT id, approver_id FROM approval_requests WHERE requisition_id = ? AND status = 'pending'
        `).get(award.body.award.award_requisition_id);
        const decided = await post(base, `/api/approvals/${pending.id}/decide`, pending.approver_id, {
          decision: 'approved',
          comments: 'Akkoord'
        });
        assert.equal(decided.status, 200, JSON.stringify(decided.body));
      }
      const committed = await db.prepare(`SELECT committed_amount FROM budgets WHERE department_id = 1`).get();
      assert.equal(Number(committed.committed_amount), 80000);
      const sourceRow = await db.prepare(`SELECT status FROM purchase_requisitions WHERE pr_number = 'PR-2026-041'`).get();
      assert.equal(sourceRow.status, 'approved');
      const trail = await json(await fetch(`${base}/api/document-trail?q=RFQ-2026-140`, { headers: authHeaders(3) }));
      assert.equal(trail.status, 200, JSON.stringify(trail.body));
      assert.equal(trail.body.requisition.pr_number, award.body.award.pr_number);

      const evalReject = await post(base, `/api/sourcing/events/${rejected.eventId}/evaluate`, 3, { row_version: 0 });
      const proposed = await post(base, `/api/sourcing/events/${rejected.eventId}/awards`, 3, {
        award_type: 'full',
        bid_id: rejected.bids[0].bid_id,
        row_version: evalReject.body.row_version
      });
      const pending = await db.prepare(`
        SELECT id, approver_id FROM approval_requests WHERE requisition_id = ? AND status = 'pending'
      `).get(proposed.body.award.award_requisition_id);
      const rejection = await post(base, `/api/approvals/${pending.id}/decide`, pending.approver_id, {
        decision: 'rejected',
        comments: 'Nee'
      });
      assert.equal(rejection.status, 200, JSON.stringify(rejection.body));
      const event = await db.prepare(`SELECT status FROM sourcing_events WHERE id = ?`).get(rejected.eventId);
      assert.equal(event.status, 'evaluated');
      const awardRow = await db.prepare(`SELECT status FROM sourcing_awards WHERE event_id = ?`).get(rejected.eventId);
      assert.equal(awardRow.status, 'rejected');
      const pos = await db.prepare(`SELECT COUNT(*) AS n FROM purchase_orders`).get();
      assert.equal(Number(pos.n), 0);
      const hook = await db.prepare(`
        SELECT event_type FROM webhook_outbox WHERE event_type = 'sourcing_event.award_rejected'
      `).get();
      assert.equal(hook.event_type, 'sourcing_event.award_rejected');
    }));
  });

  test('two different award proposals cannot both win, and two identical ones share one requisition', async () => {
    const { db, app } = await boot();
    const seeded = await seedClosedEvent(db, { supplierIds: [2, 1], unitPrice: [1000, 1000] });
    await withFlag(() => withServer(app, async (base) => {
      const evaluated = await post(base, `/api/sourcing/events/${seeded.eventId}/evaluate`, 3, { row_version: 0 });
      const version = evaluated.body.row_version;
      const calls = await Promise.all([
        post(base, `/api/sourcing/events/${seeded.eventId}/awards`, 3, {
          award_type: 'full', bid_id: seeded.bids[0].bid_id, row_version: version
        }),
        post(base, `/api/sourcing/events/${seeded.eventId}/awards`, 3, {
          award_type: 'full', bid_id: seeded.bids[1].bid_id, row_version: version
        })
      ]);
      const statuses = calls.map((row) => row.status).sort();
      assert.deepEqual(statuses, [201, 409]);
      assert.equal(calls.filter((row) => row.status === 409)[0].body.code, 'event_state_changed');
      const count = await db.prepare(`SELECT COUNT(*) AS n FROM purchase_requisitions`).get();
      assert.equal(Number(count.n), 1);
    }));

    const second = await boot();
    const again = await seedClosedEvent(second.db, { number: 'RFQ-2026-160', supplierIds: [2, 1], unitPrice: [1100, 1100] });
    await withFlag(() => withServer(second.app, async (base) => {
      const evaluated = await post(base, `/api/sourcing/events/${again.eventId}/evaluate`, 3, { row_version: 0 });
      const body = {
        award_type: 'full',
        bid_id: again.bids[0].bid_id,
        row_version: evaluated.body.row_version
      };
      const calls = await Promise.all([
        post(base, `/api/sourcing/events/${again.eventId}/awards`, 3, body, { 'Idempotency-Key': 'dup' }),
        post(base, `/api/sourcing/events/${again.eventId}/awards`, 3, body, { 'Idempotency-Key': 'dup' })
      ]);
      assert.deepEqual(calls.map((row) => row.status).sort(), [200, 201]);
      const count = await second.db.prepare(`SELECT COUNT(*) AS n FROM purchase_requisitions`).get();
      assert.equal(Number(count.n), 1);
    }));
  });

  test('award, approval, and purchase-order chunks stay within 25 statements at 50 lines and 20 suppliers', async () => {
    const { db, app } = await boot();
    for (let id = 4; id <= 23; id += 1) {
      await db.prepare(`
        INSERT INTO suppliers (id, name, code, email, status) VALUES (?, ?, ?, ?, 'active')
      `).run(id, `Cap ${id}`, `CAP${id}`, `cap${id}@supply.test`);
    }
    await budget(db);
    const supplierIds = [2, ...Array.from({ length: 19 }, (_, index) => index + 4)];
    const seeded = await seedClosedEvent(db, {
      number: 'RFQ-2026-180',
      lineCount: 50,
      supplierIds,
      unitPrice: 30000
    });
    const watch = watchTransactions(db);
    const measured = {};
    try {
      await withFlag(() => withServer(app, async (base) => {
        const beforeEval = watch.counts.length;
        const evaluated = await post(base, `/api/sourcing/events/${seeded.eventId}/evaluate`, 3, { row_version: 0 });
        assert.equal(evaluated.status, 200, JSON.stringify(evaluated.body));
        measured.evaluate = watch.counts.slice(beforeEval);
        const lines = seeded.lines.map((line, index) => ({
          event_line_id: line.id,
          bid_id: seeded.bids[index % seeded.bids.length].bid_id
        }));
        const beforeAward = watch.counts.length;
        const award = await post(base, `/api/sourcing/events/${seeded.eventId}/awards`, 3, {
          award_type: 'split',
          row_version: evaluated.body.row_version,
          lines
        });
        assert.equal(award.status, 201, JSON.stringify(award.body));
        measured.award = watch.counts.slice(beforeAward);
        const beforeApproval = watch.counts.length;
        for (;;) {
          const pending = await db.prepare(`
            SELECT id, approver_id FROM approval_requests
            WHERE requisition_id = ? AND status = 'pending'
          `).get(award.body.award.award_requisition_id);
          if (!pending) break;
          const decided = await post(base, `/api/approvals/${pending.id}/decide`, pending.approver_id, {
            decision: 'approved',
            comments: 'Akkoord'
          });
          assert.equal(decided.status, 200, JSON.stringify(decided.body));
        }
        measured.approval = watch.counts.slice(beforeApproval);
        const beforePo = watch.counts.length;
        const pos = await post(base, `/api/sourcing/events/${seeded.eventId}/purchase-orders`, 3, {});
        assert.equal(pos.status, 201, JSON.stringify(pos.body));
        assert.equal(pos.body.purchase_orders.length, 20);
        measured.purchase_orders = watch.counts.slice(beforePo);
        const duplicate = await post(base, `/api/sourcing/events/${seeded.eventId}/purchase-orders`, 3, {});
        assert.equal(duplicate.status, 200);
        assert.equal(duplicate.body.purchase_orders.length, 20);
      }));
    } finally {
      watch.restore();
    }
    console.log(`STATEMENTS sqlite ${JSON.stringify(measured)}`);
    for (const [name, counts] of Object.entries(measured)) {
      assert.ok(counts.length > 0, name);
      for (const count of counts) {
        assert.ok(count > 0 && count <= 25, `${name} used ${count}`);
      }
    }
  });
});
