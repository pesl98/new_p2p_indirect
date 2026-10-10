import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from './app.js';
import { loadDbConfig } from './dbConfig.js';
import { withCookie } from './testSession.js';
import { buildApprovalSteps } from './approvalPolicy.js';
import { decideApprovalStep } from './approvalsService.js';
import { queryApprovalCompliance } from './complianceReports.js';
import { createMemoryDatabase } from './db.js';
import { currentFiscalYear } from './fiscalYear.js';
import { createAwardPurchaseOrders, getAward, proposeAward, awardSnapshotForRequisition } from './sourcingAwardService.js';
import {
  buyerEvaluation,
  completeEvaluation,
  declareCoi,
  reassignOwner,
  recordScores
} from './sourcingEvaluationService.js';
import { scoreBids } from './sourcingScoring.js';

const CAROL = { id: 3, name: 'Carol Zhang', role: 'procurement' };
const FRANK = { id: 6, name: 'Frank Buyer', role: 'procurement' };
const ELENA = { id: 5, name: 'Elena Rostova', role: 'admin' };
const DAVID = { id: 4, name: 'David Miller', role: 'finance' };
const BOB = { id: 2, name: 'Bob Approver', role: 'approver' };
const NOW = new Date('2026-10-20T12:00:00Z');
const FY = currentFiscalYear();

async function seedWorld() {
  const db = await createMemoryDatabase();
  await db.prepare(`INSERT INTO departments (id, code, name) VALUES (1, 'MKT', 'Marketing'), (2, 'FIN', 'Finance')`).run();
  await db.prepare(`
    INSERT INTO users (id, name, email, role, department_id, title, status) VALUES
      (1, 'Alice Chen', 'alice@example.com', 'requester', 1, 'Specialist', 'active'),
      (2, 'Bob Approver', 'bob@example.com', 'approver', 1, 'Head', 'active'),
      (3, 'Carol Zhang', 'carol@example.com', 'procurement', 1, 'Buyer', 'active'),
      (4, 'David Miller', 'david@example.com', 'finance', 2, 'Controller', 'active'),
      (5, 'Elena Rostova', 'elena@example.com', 'admin', 2, 'CFO', 'active'),
      (6, 'Frank Buyer', 'frank@example.com', 'procurement', 1, 'Buyer', 'active')
  `).run();
  await db.prepare(`UPDATE departments SET approver_user_id = 2 WHERE id = 1`).run();
  await db.prepare(`
    INSERT INTO suppliers (id, name, code, contact_person, email, status) VALUES
      (2, 'Alpha Supply', 'ALP', 'A', 'a@a.test', 'active'),
      (3, 'Beta Supply', 'BET', 'B', 'b@b.test', 'active'),
      (4, 'Gamma Supply', 'GAM', 'G', 'g@g.test', 'active')
  `).run();
  await db.prepare(`
    INSERT INTO budgets (department_id, fiscal_year, total_budget, committed_amount, actual_spent)
    VALUES (1, ?, 100000000, 200000, 0)
  `).run(FY);
  return db;
}

/**
 * An evaluated-ready RFQ: 2 lines (qty 10 and 5), bids from suppliers 2, 3, 4.
 * Alpha is complete and cheapest in total; Beta wins line 2; Gamma is incomplete.
 */
async function seedEvent(db, { sourcePr = false } = {}) {
  let sourcePrId = null;
  if (sourcePr) {
    await db.prepare(`
      INSERT INTO purchase_requisitions (pr_number, requester_id, department_id, status, total_amount, justification, needed_by_date)
      VALUES ('PR-SRC-001', 1, 1, 'approved', 200000, 'source', '2026-12-01')
    `).run();
    sourcePrId = Number((await db.prepare(`SELECT id FROM purchase_requisitions WHERE pr_number = 'PR-SRC-001'`).get()).id);
  }
  await db.prepare(`
    INSERT INTO sourcing_events (event_number, kind, title, department_id, owner_user_id, source_requisition_id,
      status, currency, deadline_at, row_version, created_at, updated_at)
    VALUES ('RFQ-2026-001', 'rfq', 'Office refresh', 1, 3, ?, 'published', 'EUR', '2999-01-01T00:00:00Z', 0,
      '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')
  `).run(sourcePrId);
  const event = await db.prepare(`SELECT id FROM sourcing_events WHERE event_number = 'RFQ-2026-001'`).get();
  const eventId = Number(event.id);
  for (const [no, desc, qty] of [[1, 'Desk', 10], [2, 'Chair', 5]]) {
    await db.prepare(`
      INSERT INTO sourcing_event_lines (event_id, line_no, description, category, quantity)
      VALUES (?, ?, ?, 'Office Supplies', ?)
    `).run(eventId, no, desc, qty);
  }
  const lines = await db.prepare(`SELECT id FROM sourcing_event_lines WHERE event_id = ? ORDER BY line_no`).all(eventId);
  const bids = [
    // supplier, lead, [unit price line 1, unit price line 2 | null], validity
    [2, 5, [10000, 5000], '2999-01-01'],
    [3, 10, [11000, 4500], '2999-01-01'],
    [4, 3, [9000, null], '2999-01-01']
  ];
  const ids = {};
  for (const [supplierId, lead, prices, validity] of bids) {
    await db.prepare(`
      INSERT INTO sourcing_invitations (event_id, supplier_id, contact_email, invited_by_user_id, created_at)
      VALUES (?, ?, 'x@x.test', 3, '2026-10-01T00:00:00Z')
    `).run(eventId, supplierId);
    const inv = await db.prepare(`SELECT id FROM sourcing_invitations WHERE event_id = ? AND supplier_id = ?`).get(eventId, supplierId);
    await db.prepare(`
      INSERT INTO sourcing_bids (event_id, invitation_id, supplier_id, status, current_revision, first_submitted_at, last_submitted_at)
      VALUES (?, ?, ?, 'submitted', 1, '2026-10-05T10:00:00Z', '2026-10-05T10:00:00Z')
    `).run(eventId, inv.id, supplierId);
    const bid = await db.prepare(`SELECT id FROM sourcing_bids WHERE invitation_id = ?`).get(inv.id);
    const quantities = [10, 5];
    const total = prices.reduce((sum, price, i) => sum + (price == null ? 0 : price * quantities[i]), 0);
    await db.prepare(`
      INSERT INTO sourcing_bid_revisions (bid_id, revision, submission_id, total_cents, quoted_line_count,
        validity_until, default_lead_time_days, content_sha256, submitted_at)
      VALUES (?, 1, ?, ?, ?, ?, ?, 'h', '2026-10-05T10:00:00Z')
    `).run(bid.id, `sub-${supplierId}`, total, prices.filter((p) => p != null).length, validity, lead);
    prices.forEach((price, i) => {
      db.prepare(`
        INSERT INTO sourcing_bid_lines (bid_id, revision, event_line_id, quoted, unit_price_cents, line_total_cents, lead_time_days)
        VALUES (?, 1, ?, ?, ?, ?, NULL)
      `).run(bid.id, lines[i].id, price == null ? 0 : 1, price, price == null ? null : price * quantities[i]);
    });
    ids[supplierId] = Number(bid.id);
  }
  await db.prepare(`
    UPDATE sourcing_events SET status = 'closed', deadline_at = '2026-10-10T00:00:00Z', closed_at = '2026-10-10T00:00:00Z' WHERE id = ?
  `).run(eventId);
  return { eventId, bids: ids, lines: lines.map((l) => Number(l.id)), sourcePrId };
}

async function evaluate(db, ctx) {
  await declareCoi(db, CAROL, ctx.eventId, { status: 'none_declared' }, { now: NOW });
  await completeEvaluation(db, CAROL, ctx.eventId, { override_reason: 'scores skipped in test' }, { now: NOW });
}

describe('scoring formula (§8.1)', () => {
  const event = { weight_price: 70, weight_lead_time: 15, weight_quality: 15 };
  const lines = [{ id: 1 }, { id: 2 }];
  const mk = (bid_id, total, lead, p1, p2, first = '2026-10-05') => ({
    bid_id, status: 'submitted', total_cents: total, default_lead_time_days: lead, first_submitted_at: first,
    lines: [
      { event_line_id: 1, quoted: p1 != null, unit_price_cents: p1, lead_time_days: null },
      { event_line_id: 2, quoted: p2 != null, unit_price_cents: p2, lead_time_days: null }
    ]
  });

  test('price, lead time and quality parts combine by weight', () => {
    const result = scoreBids({
      event,
      lines,
      bids: [mk(1, 1000, 4, 600, 400), mk(2, 2000, 9, 700, 1300)],
      quality: new Map([[1, 5], [2, 10]])
    });
    const [a, b] = result.bids;
    assert.equal(result.lowest_complete_total_cents, 1000);
    assert.equal(a.price_score, 100);
    assert.equal(b.price_score, 50);
    assert.equal(a.lead_score, 100);
    assert.equal(b.lead_score, 50);
    assert.equal(a.quality_score, 50);
    assert.equal(b.quality_score, 100);
    assert.equal(a.total_score, (70 * 100 + 15 * 100 + 15 * 50) / 100);
    assert.equal(b.total_score, (70 * 50 + 15 * 50 + 15 * 100) / 100);
    assert.equal(a.rank, 1);
    assert.equal(b.rank, 2);
  });

  test('incomplete and withdrawn bids get no total or rank; lowest per line ignores withdrawn', () => {
    const withdrawn = { ...mk(3, 100, 1, 1, 1), status: 'withdrawn' };
    const result = scoreBids({ event, lines, bids: [mk(1, 1000, 4, 600, 400), mk(2, 300, 2, 300, null), withdrawn] });
    const incomplete = result.bids.find((row) => row.bid_id === 2);
    assert.equal(incomplete.complete, false);
    assert.equal(incomplete.total_score, null);
    assert.equal(incomplete.rank, null);
    assert.equal(result.bids.some((row) => row.bid_id === 3), false);
    assert.equal(result.lowest_per_line[1], 300);
    assert.equal(result.lowest_per_line[2], 400);
    assert.equal(result.lowest_complete_total_cents, 1000);
  });

  test('ties: equal scores rank by lower total, then earlier first submit; equal prices are all lowest', () => {
    const tie = scoreBids({
      event: { weight_price: 0, weight_lead_time: 0, weight_quality: 100 },
      lines,
      bids: [mk(1, 2000, 1, 1, 1, '2026-10-06'), mk(2, 1000, 1, 1, 1, '2026-10-07'), mk(3, 1000, 1, 1, 1, '2026-10-05')],
      quality: new Map([[1, 5], [2, 5], [3, 5]])
    });
    const order = tie.bids.slice().sort((a, b) => a.rank - b.rank).map((row) => row.bid_id);
    assert.deepEqual(order, [3, 2, 1]);
    assert.equal(tie.lowest_per_line[1], 1);
    assert.equal(tie.bids.filter((row) => row.line_lowest.includes(1)).length, 3);
  });
});

describe('approval policy exclusions', () => {
  test('re-resolves to the next user with the same role, then escalates, then fails closed', async () => {
    const db = await seedWorld();
    const amount = 150000;
    let steps = await buildApprovalSteps({ totalAmount: amount, departmentId: 1, db });
    assert.deepEqual(steps.map((s) => s.approver_id), [2, 3]);
    steps = await buildApprovalSteps({ totalAmount: amount, departmentId: 1, db, excludeUserIds: [3] });
    assert.deepEqual(steps.map((s) => s.approver_id), [2, 6]);
    steps = await buildApprovalSteps({ totalAmount: amount, departmentId: 1, db, excludeUserIds: [3, 6] });
    assert.deepEqual(steps.map((s) => s.approver_id), [2, 4], 'procurement escalates to finance');
    await assert.rejects(
      buildApprovalSteps({ totalAmount: amount, departmentId: 1, db, excludeUserIds: [3, 6, 4, 5] }),
      (e) => e.statusCode === 422 && e.code === 'sod_no_alternate_approver'
    );
  });
});

describe('evaluation', () => {
  test('matrix marks lowest per line and lowest complete total; sealed before the deadline', async () => {
    const db = await seedWorld();
    const ctx = await seedEvent(db);
    await declareCoi(db, CAROL, ctx.eventId, { status: 'none_declared' }, { now: NOW });
    const view = await buyerEvaluation(db, CAROL, ctx.eventId, NOW);
    assert.equal(view.sealed, false);
    const alpha = view.matrix.bids.find((b) => b.supplier_code === 'ALP');
    const beta = view.matrix.bids.find((b) => b.supplier_code === 'BET');
    const gamma = view.matrix.bids.find((b) => b.supplier_code === 'GAM');
    assert.equal(view.matrix.lowest_complete_total_cents, 125000);
    assert.equal(alpha.is_lowest_complete_total, true);
    assert.equal(gamma.complete, false);
    assert.equal(gamma.rank, null);
    assert.equal(alpha.rank, 1);
    assert.equal(beta.rank, 2);
    assert.equal(alpha.lines[0].is_line_lowest, false, 'Gamma quoted line 1 lower');
    assert.equal(beta.lines[1].is_line_lowest, true);
    assert.equal(view.matrix.lowest_per_line[ctx.lines[0]], 9000);

    const before = new Date('2026-10-01T00:00:00Z');
    await db.prepare(`UPDATE sourcing_events SET status = 'published', deadline_at = '2999-01-01T00:00:00Z' WHERE id = ?`).run(ctx.eventId);
    const sealed = await buyerEvaluation(db, CAROL, ctx.eventId, before);
    assert.equal(sealed.sealed, true);
    assert.equal(sealed.matrix, undefined);
  });

  test('COI: conflict needs a note; conflict evaluators cannot score; pending evaluators see no prices', async () => {
    const db = await seedWorld();
    const ctx = await seedEvent(db);
    await db.prepare(`
      INSERT INTO sourcing_evaluators (event_id, user_id, added_by_user_id, created_at) VALUES (?, 4, 3, '2026-10-01T00:00:00Z'), (?, 6, 3, '2026-10-01T00:00:00Z')
    `).run(ctx.eventId, ctx.eventId);
    const pending = await buyerEvaluation(db, FRANK, ctx.eventId, NOW);
    assert.equal(pending.prices_hidden, true);
    await assert.rejects(
      declareCoi(db, FRANK, ctx.eventId, { status: 'conflict_declared' }, { now: NOW }),
      (e) => e.code === 'coi_note_required'
    );
    await declareCoi(db, FRANK, ctx.eventId, { status: 'conflict_declared', note: 'Cousin owns Alpha' }, { now: NOW });
    await assert.rejects(
      recordScores(db, FRANK, ctx.eventId, { scores: [{ bid_id: ctx.bids[2], quality_score: 5 }] }, { now: NOW }),
      (e) => e.statusCode === 403
    );
    await declareCoi(db, DAVID, ctx.eventId, { status: 'none_declared' }, { now: NOW });
    await recordScores(db, DAVID, ctx.eventId, { scores: [{ bid_id: ctx.bids[2], quality_score: 8 }, { bid_id: ctx.bids[3], quality_score: 6 }] }, { now: NOW });
    await assert.rejects(
      recordScores(db, DAVID, ctx.eventId, { scores: [{ bid_id: ctx.bids[2], quality_score: 11 }] }, { now: NOW }),
      (e) => e.code === 'invalid_scores'
    );
    const view = await buyerEvaluation(db, CAROL, ctx.eventId, NOW);
    assert.equal(view.matrix.bids.find((b) => b.supplier_code === 'ALP').quality_average, 8);
    const outsider = { id: 1, name: 'Alice Chen', role: 'procurement' };
    await assert.rejects(declareCoi(db, outsider, ctx.eventId, { status: 'none_declared' }, { now: NOW }), (e) => e.code === 'not_evaluator');
  });

  test('"Beoordeling afronden": blocked by pending COI or missing scores unless an override reason is given', async () => {
    const db = await seedWorld();
    const ctx = await seedEvent(db);
    await assert.rejects(completeEvaluation(db, CAROL, ctx.eventId, {}, { now: NOW }), (e) => e.code === 'coi_pending');
    await declareCoi(db, CAROL, ctx.eventId, { status: 'none_declared' }, { now: NOW });
    await assert.rejects(completeEvaluation(db, CAROL, ctx.eventId, {}, { now: NOW }), (e) => e.code === 'scores_missing');
    await assert.rejects(completeEvaluation(db, FRANK, ctx.eventId, { override_reason: 'long enough reason' }, { now: NOW }), (e) => e.statusCode === 403);
    const done = await completeEvaluation(db, CAROL, ctx.eventId, { override_reason: 'Quality not scored: urgent buy' }, { now: NOW });
    assert.equal(done.status, 'evaluated');
    await assert.rejects(completeEvaluation(db, CAROL, ctx.eventId, {}, { now: NOW }), (e) => e.statusCode === 409);
    const audit = await db.prepare(`SELECT details FROM compliance_audit_events WHERE action = 'SOURCING_EVENT_EVALUATED'`).get();
    assert.match(audit.details, /urgent buy/);
  });
});

describe('award', () => {
  test('a non-lowest award needs a reason (400) and the database CHECK rejects it too', async () => {
    const db = await seedWorld();
    const ctx = await seedEvent(db);
    await evaluate(db, ctx);
    await assert.rejects(
      proposeAward(db, CAROL, ctx.eventId, { award_type: 'full', bid_id: ctx.bids[3] }, { now: NOW }),
      (e) => e.statusCode === 400 && e.code === 'award_reason_required'
    );
    await assert.rejects(
      async () => db.prepare(`
        INSERT INTO sourcing_awards (event_id, award_type, total_cents, is_lowest, comparison_snapshot_json, proposed_by_user_id, proposed_at)
        VALUES (?, 'full', 1, 0, '{}', 3, 'x')
      `).run(ctx.eventId),
      /CHECK/i
    );
    const view = await proposeAward(db, CAROL, ctx.eventId, { award_type: 'full', bid_id: ctx.bids[2] }, { now: NOW });
    assert.equal(view.award.is_lowest, true);
    assert.equal(view.award.total_cents, 125000);
  });

  test('a full award must go to one supplier that quoted every line; only evaluated events can be awarded', async () => {
    const db = await seedWorld();
    const ctx = await seedEvent(db);
    await assert.rejects(
      proposeAward(db, CAROL, ctx.eventId, { award_type: 'full', bid_id: ctx.bids[2] }, { now: NOW }),
      (e) => e.code === 'event_state_changed'
    );
    await evaluate(db, ctx);
    await assert.rejects(
      proposeAward(db, CAROL, ctx.eventId, { award_type: 'full', bid_id: ctx.bids[4], reason: 'Gamma is quick' }, { now: NOW }),
      (e) => e.code === 'invalid_award'
    );
    await assert.rejects(
      proposeAward(db, FRANK, ctx.eventId, { award_type: 'full', bid_id: ctx.bids[2] }, { now: NOW }),
      (e) => e.code === 'not_owner'
    );
  });

  test('owner must declare no conflict; an admin reassigns a conflicted owner', async () => {
    const db = await seedWorld();
    const ctx = await seedEvent(db);
    await declareCoi(db, CAROL, ctx.eventId, { status: 'conflict_declared', note: 'Own shares in Alpha' }, { now: NOW });
    await db.prepare(`UPDATE sourcing_events SET status = 'evaluated', evaluated_at = '2026-10-11T00:00:00Z' WHERE id = ?`).run(ctx.eventId);
    // A conflict can only be declared before evaluation, so the owner state is frozen here.
    await assert.rejects(
      proposeAward(db, CAROL, ctx.eventId, { award_type: 'full', bid_id: ctx.bids[2] }, { now: NOW }),
      (e) => e.statusCode === 403 && e.code === 'owner_conflict'
    );
    await assert.rejects(reassignOwner(db, FRANK, ctx.eventId, { user_id: 6, reason: 'long enough reason' }), (e) => e.statusCode === 403);
    await reassignOwner(db, ELENA, ctx.eventId, { user_id: 6, reason: 'Owner declared a conflict' }, { now: NOW });
    await assert.rejects(
      proposeAward(db, FRANK, ctx.eventId, { award_type: 'full', bid_id: ctx.bids[2] }, { now: NOW }),
      (e) => e.code === 'owner_coi_required'
    );
    const row = await db.prepare(`SELECT details FROM compliance_audit_events WHERE action = 'SOURCING_OWNER_REASSIGNED'`).get();
    assert.match(row.details, /Owner declared a conflict/);
  });

  test('split award: one award PR, convert yields one PO per supplier at awarded prices', async () => {
    const db = await seedWorld();
    const ctx = await seedEvent(db);
    await evaluate(db, ctx);
    // Line 1 to Gamma (lowest), line 2 to Beta (lowest): split and lowest, no reason needed.
    const view = await proposeAward(db, CAROL, ctx.eventId, {
      award_type: 'split',
      lines: [{ event_line_id: ctx.lines[0], bid_id: ctx.bids[4] }, { event_line_id: ctx.lines[1], bid_id: ctx.bids[3] }]
    }, { now: NOW });
    assert.equal(view.award.is_lowest, true);
    assert.equal(view.award.total_cents, 9000 * 10 + 4500 * 5);
    const prs = await db.prepare(`SELECT COUNT(*) AS n FROM purchase_requisitions WHERE pr_number LIKE 'PR-2026-%' OR id = ?`).get(view.award.requisition.id);
    assert.ok(prs.n >= 1);
    const lines = await db.prepare(`SELECT estimated_supplier_id, unit_price FROM requisition_items WHERE requisition_id = ? ORDER BY id`).all(view.award.requisition.id);
    assert.deepEqual(lines.map((l) => [Number(l.estimated_supplier_id), Number(l.unit_price)]), [[4, 9000], [3, 4500]]);

    await approveAll(db, view.award.requisition.id);
    const awarded = await getAward(db, CAROL, ctx.eventId);
    assert.equal(awarded.award.status, 'approved');
    assert.equal(awarded.event_status, 'awarded');

    const created = await createAwardPurchaseOrders(db, CAROL, ctx.eventId);
    assert.equal(created.split, true);
    assert.equal(created.purchase_orders.length, 2);
    const pos = await db.prepare(`SELECT supplier_id, total_amount, notes FROM purchase_orders WHERE requisition_id = ? ORDER BY supplier_id`).all(view.award.requisition.id);
    assert.deepEqual(pos.map((p) => [Number(p.supplier_id), Number(p.total_amount)]), [[3, 22500], [4, 90000]]);
    assert.match(pos[0].notes, /RFQ-2026-001/);
    const again = await createAwardPurchaseOrders(db, CAROL, ctx.eventId);
    assert.equal(again.replayed, true);
    assert.equal(again.done, true);
    assert.equal(again.purchase_orders.length, 2);
    assert.equal(Number((await db.prepare(`SELECT COUNT(*) AS n FROM purchase_orders WHERE requisition_id = ?`).get(view.award.requisition.id)).n), 2);
    await assert.rejects(createAwardPurchaseOrders(db, DAVID, ctx.eventId), (e) => e.statusCode === 403);
  });

  test('two concurrent proposals: one wins, one gets 409', async () => {
    const db = await seedWorld();
    const ctx = await seedEvent(db);
    await evaluate(db, ctx);
    const body = { award_type: 'full', bid_id: ctx.bids[2] };
    const results = await Promise.allSettled([
      proposeAward(db, CAROL, ctx.eventId, body, { now: NOW }),
      proposeAward(db, ELENA, ctx.eventId, body, { now: NOW })
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const failed = results.find((r) => r.status === 'rejected');
    assert.equal(failed.reason.statusCode, 409);
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM sourcing_awards`).get();
    assert.equal(Number(n.n), 1);
  });
});

async function approveAll(db, prId) {
  for (let guard = 0; guard < 5; guard += 1) {
    const step = await db.prepare(`
      SELECT id, approver_id FROM approval_requests WHERE requisition_id = ? AND status = 'pending'
    `).get(prId);
    if (!step) return;
    const user = await db.prepare(`SELECT name FROM users WHERE id = ?`).get(step.approver_id);
    await decideApprovalStep(db, {
      approvalId: step.id,
      decision: 'approved',
      approver_id: step.approver_id,
      approver_name: user.name
    });
  }
}

describe('approval, SoD and budget', () => {
  async function awardedFixture({ sourcePr = true } = {}) {
    const db = await seedWorld();
    const ctx = await seedEvent(db, { sourcePr });
    await evaluate(db, ctx);
    const view = await proposeAward(db, CAROL, ctx.eventId, { award_type: 'full', bid_id: ctx.bids[2] }, { now: NOW });
    return { db, ctx, view, prId: view.award.requisition.id };
  }

  test('the chain excludes the owner above the threshold; procurement step goes to the other buyer', async () => {
    const { db, view } = await awardedFixture();
    assert.deepEqual(view.award.approvals.map((a) => a.approver_id), [2, 6]);
  });

  test('with one procurement user the step escalates to finance; with nobody left it fails closed with 422', async () => {
    const db = await seedWorld();
    await db.prepare(`UPDATE users SET status = 'inactive' WHERE id = 6`).run();
    const ctx = await seedEvent(db);
    await evaluate(db, ctx);
    const view = await proposeAward(db, CAROL, ctx.eventId, { award_type: 'full', bid_id: ctx.bids[2] }, { now: NOW });
    assert.deepEqual(view.award.approvals.map((a) => a.approver_id), [2, 4]);

    const db2 = await seedWorld();
    await db2.prepare(`UPDATE users SET status = 'inactive' WHERE id IN (4, 5, 6)`).run();
    const ctx2 = await seedEvent(db2);
    await evaluate(db2, ctx2);
    await assert.rejects(
      proposeAward(db2, CAROL, ctx2.eventId, { award_type: 'full', bid_id: ctx2.bids[2] }, { now: NOW }),
      (e) => e.statusCode === 422 && e.code === 'sod_no_alternate_approver'
    );
    const prs = await db2.prepare(`SELECT COUNT(*) AS n FROM purchase_requisitions`).get();
    assert.equal(Number(prs.n), 0, 'the failed proposal leaves no requisition behind');
    const awards = await db2.prepare(`SELECT COUNT(*) AS n FROM sourcing_awards`).get();
    assert.equal(Number(awards.n), 0);
  });

  test('the owner cannot decide the award, directly or through a delegation', async () => {
    const { db, prId } = await awardedFixture();
    const step = await db.prepare(`SELECT id, approver_id FROM approval_requests WHERE requisition_id = ? AND status = 'pending'`).get(prId);
    await assert.rejects(
      decideApprovalStep(db, { approvalId: step.id, decision: 'approved', approver_id: CAROL.id, approver_name: CAROL.name }),
      (e) => e.statusCode === 403
    );
    await db.prepare(`
      INSERT INTO approval_delegations (delegator_user_id, delegate_user_id, active, reason) VALUES (2, 3, 1, 'OOO')
    `).run();
    await assert.rejects(
      decideApprovalStep(db, { approvalId: step.id, decision: 'approved', approver_id: CAROL.id, approver_name: CAROL.name }),
      (e) => e.statusCode === 403 && e.code === 'sod_award_self_approval'
    );
    // The legitimate approver still can.
    await decideApprovalStep(db, { approvalId: step.id, decision: 'approved', approver_id: BOB.id, approver_name: BOB.name });
  });

  test('final approval commits the award and releases the source PR in one transaction; budget reconciles', async () => {
    const { db, ctx, prId } = await awardedFixture();
    const before = await db.prepare(`SELECT committed_amount FROM budgets WHERE department_id = 1`).get();
    assert.equal(Number(before.committed_amount), 200000);
    await approveAll(db, prId);
    const after = await db.prepare(`SELECT committed_amount, actual_spent FROM budgets WHERE department_id = 1`).get();
    // 200000 (source estimate) - 200000 released + 125000 awarded
    assert.equal(Number(after.committed_amount), 125000);
    assert.equal(Number(after.actual_spent), 0);
    const event = await db.prepare(`SELECT status, awarded_at FROM sourcing_events WHERE id = ?`).get(ctx.eventId);
    assert.equal(event.status, 'awarded');
    assert.ok(event.awarded_at);
    const hook = await db.prepare(`SELECT action FROM audit_logs WHERE action = 'SOURCING_SOURCE_REQUISITION_SUPERSEDED'`).get();
    assert.ok(hook);
    const webhook = await db.prepare(`SELECT payload FROM webhook_outbox WHERE event_type = 'sourcing_event.awarded'`).get();
    const payload = JSON.parse(webhook.payload);
    assert.equal(payload.award_total_cents, 125000);
    assert.equal(payload.currency, 'EUR');
    assert.deepEqual(payload.suppliers, [{ supplier_id: 2, total_cents: 125000 }]);
    // The superseded source PR cannot be converted any more.
    const { convertRequisitionToPurchaseOrders } = await import('./purchaseOrdersService.js');
    await assert.rejects(
      convertRequisitionToPurchaseOrders(db, { requisition_id: ctx.sourcePrId, created_by: 3 }),
      (e) => e.code === 'requisition_in_sourcing'
    );
  });

  test('from-scratch events (no source PR) commit the award without a release', async () => {
    const { db, prId } = await awardedFixture({ sourcePr: false });
    await approveAll(db, prId);
    const after = await db.prepare(`SELECT committed_amount FROM budgets WHERE department_id = 1`).get();
    assert.equal(Number(after.committed_amount), 200000 + 125000);
  });

  test('a budget failure on final approval rolls back the release too', async () => {
    const { db, prId } = await awardedFixture();
    await db.prepare(`UPDATE budgets SET total_budget = 100 WHERE department_id = 1`).run();
    const step1 = await db.prepare(`SELECT id FROM approval_requests WHERE requisition_id = ? AND step_order = 1`).get(prId);
    await decideApprovalStep(db, { approvalId: step1.id, decision: 'approved', approver_id: 2, approver_name: 'Bob Approver' });
    const step2 = await db.prepare(`SELECT id FROM approval_requests WHERE requisition_id = ? AND step_order = 2`).get(prId);
    await assert.rejects(
      decideApprovalStep(db, { approvalId: step2.id, decision: 'approved', approver_id: 6, approver_name: 'Frank Buyer' }),
      /Insufficient remaining budget/
    );
    const budget = await db.prepare(`SELECT committed_amount FROM budgets WHERE department_id = 1`).get();
    assert.equal(Number(budget.committed_amount), 200000, 'source commitment was not released');
    const event = await db.prepare(`SELECT status FROM sourcing_events WHERE id = 1`).get();
    assert.equal(event.status, 'evaluated');
  });

  test('a rejected award leaves the event evaluated, creates no POs, and allows a new proposal', async () => {
    const { db, ctx, prId } = await awardedFixture();
    const step = await db.prepare(`SELECT id FROM approval_requests WHERE requisition_id = ? AND status = 'pending'`).get(prId);
    await decideApprovalStep(db, { approvalId: step.id, decision: 'rejected', approver_id: 2, approver_name: 'Bob Approver', comments: 'too expensive' });
    const award = await getAward(db, CAROL, ctx.eventId);
    assert.equal(award.award.status, 'rejected');
    assert.equal(award.event_status, 'evaluated');
    const pos = await db.prepare(`SELECT COUNT(*) AS n FROM purchase_orders`).get();
    assert.equal(Number(pos.n), 0);
    const budget = await db.prepare(`SELECT committed_amount FROM budgets WHERE department_id = 1`).get();
    assert.equal(Number(budget.committed_amount), 200000);
    await assert.rejects(createAwardPurchaseOrders(db, CAROL, ctx.eventId), (e) => e.code === 'award_not_approved');
    const again = await proposeAward(db, CAROL, ctx.eventId, { award_type: 'full', bid_id: ctx.bids[2] }, { now: NOW });
    assert.equal(again.award.status, 'pending_approval');
  });

  test('approvers see the frozen snapshot; outsiders do not', async () => {
    const { db, view, prId } = await awardedFixture();
    const snap = await awardSnapshotForRequisition(db, BOB, prId);
    assert.equal(snap.event_number, 'RFQ-2026-001');
    assert.equal(snap.snapshot.award.total_cents, 125000);
    assert.equal(snap.snapshot.matrix.lowest_complete_total_cents, 125000);
    await assert.rejects(
      awardSnapshotForRequisition(db, { id: 1, name: 'Alice Chen', role: 'requester' }, prId),
      (e) => e.statusCode === 403
    );
    // Later price changes do not touch the stored snapshot.
    await db.prepare(`UPDATE sourcing_events SET weight_price = 10, weight_lead_time = 10, weight_quality = 80 WHERE id = 1`).run();
    const again = await awardSnapshotForRequisition(db, DAVID, prId);
    assert.equal(again.snapshot.weights.price, 70);
    assert.ok(view);
  });

  test('compliance: no wrong_approver for award PRs; sourcing_award_self_approval when forced; not-lowest is informational', async () => {
    const { db, ctx, prId } = await awardedFixture();
    let report = await queryApprovalCompliance(db);
    assert.equal(report.findings.filter((f) => f.code === 'wrong_approver').length, 0);
    assert.equal(report.findings.filter((f) => f.code === 'sourcing_award_self_approval').length, 0);
    // Force the owner onto a step, the way a manual database edit would.
    await db.prepare(`UPDATE approval_requests SET approver_id = 3 WHERE requisition_id = ? AND step_order = 2`).run(prId);
    report = await queryApprovalCompliance(db);
    assert.equal(report.findings.filter((f) => f.code === 'sourcing_award_self_approval').length, 1);
    assert.ok(report.definition.sourcing_award_self_approval);
    // Not-lowest awards are reported as info with the reason.
    const db2 = await seedWorld();
    const ctx2 = await seedEvent(db2);
    await evaluate(db2, ctx2);
    await proposeAward(db2, CAROL, ctx2.eventId, { award_type: 'full', bid_id: ctx2.bids[3], reason: 'Better warranty terms' }, { now: NOW });
    const report2 = await queryApprovalCompliance(db2);
    const info = report2.findings.find((f) => f.code === 'sourcing_award_not_lowest');
    assert.equal(info.severity, 'info');
    assert.match(info.message, /Better warranty/);
    assert.ok(ctx);
  });
});

describe('sourcing 8c HTTP routes', () => {
  async function withApp(db, fn) {
    const prev = process.env.SOURCING_ENABLED;
    process.env.SOURCING_ENABLED = '1';
    const app = createApp({ db, config: loadDbConfig({}), now: () => NOW });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await fn(base);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      if (prev == null) delete process.env.SOURCING_ENABLED; else process.env.SOURCING_ENABLED = prev;
    }
  }
  const call = (base, userId, method, path, body) => fetch(`${base}${path}`, withCookie(userId, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));

  test('owner flow over HTTP; finance is read-only except coi/scores; approvers get the snapshot', async () => {
    const db = await seedWorld();
    const ctx = await seedEvent(db);
    await withApp(db, async (base) => {
      const id = ctx.eventId;
      const financeAward = await call(base, 4, 'POST', `/api/sourcing/events/${id}/awards`, { award_type: 'full', bid_id: ctx.bids[2] });
      assert.equal(financeAward.status, 403);
      assert.equal(financeAward.body.code, 'read_only');
      const financeCoi = await call(base, 4, 'POST', `/api/sourcing/events/${id}/coi`, { status: 'none_declared' });
      assert.equal(financeCoi.body.code, 'not_evaluator', 'finance reaches the handler');
      assert.equal((await call(base, 1, 'GET', `/api/sourcing/events/${id}/award`)).status, 403);

      assert.equal((await call(base, 3, 'POST', `/api/sourcing/events/${id}/coi`, { status: 'none_declared' })).status, 200);
      const early = await call(base, 3, 'POST', `/api/sourcing/events/${id}/evaluate`, {});
      assert.equal(early.status, 409);
      assert.deepEqual(early.body.blockers, ['scores_missing']);
      const done = await call(base, 3, 'POST', `/api/sourcing/events/${id}/evaluate`, { override_reason: 'no evaluators on this RFQ' });
      assert.equal(done.status, 200);
      const view = await call(base, 3, 'GET', `/api/sourcing/events/${id}/comparison`);
      assert.equal(view.body.matrix.bids.length, 3);

      const proposed = await call(base, 3, 'POST', `/api/sourcing/events/${id}/awards`, { award_type: 'full', bid_id: ctx.bids[2] });
      assert.equal(proposed.status, 201);
      const prId = proposed.body.award.requisition.id;
      const snap = await call(base, 2, 'GET', `/api/approvals/award-snapshot/${prId}`);
      assert.equal(snap.status, 200);
      assert.equal(snap.body.event_number, 'RFQ-2026-001');
      const inbox = await call(base, 2, 'GET', '/api/approvals');
      assert.equal(inbox.body.find((row) => row.requisition_id === prId).rfq_number, 'RFQ-2026-001');
      const stepId = proposed.body.award.approvals[0] && inbox.body.find((row) => row.requisition_id === prId).approval_id;
      const ownerDecides = await call(base, 3, 'POST', `/api/approvals/${stepId}/decide`, { decision: 'approved' });
      assert.equal(ownerDecides.status, 403);
      const noPos = await call(base, 3, 'POST', `/api/sourcing/events/${id}/purchase-orders`);
      assert.equal(noPos.status, 409);
      assert.equal(noPos.body.code, 'award_not_approved');
    });
  });
});

describe('statement budget (plan §6.1: ≤ 25 prepared statements per interactive transaction)', () => {
  function countPrepares(db) {
    const original = db.prepare.bind(db);
    const state = { total: 0, inTx: 0, depth: 0 };
    db.prepare = (sql) => {
      state.total += 1;
      if (state.depth > 0) state.inTx += 1;
      return original(sql);
    };
    const wrap = (name) => {
      const originalTx = db[name].bind(db);
      db[name] = (fn) => originalTx(async (...args) => {
        state.depth += 1;
        try { return await fn(...args); } finally { state.depth -= 1; }
      });
    };
    wrap('immediateTransaction');
    wrap('transaction');
    return state;
  }

  test('proposing a split award and the final approval stay within 25', async () => {
    const db = await seedWorld();
    const ctx = await seedEvent(db, { sourcePr: true });
    await evaluate(db, ctx);
    const proposeCount = countPrepares(db);
    const view = await proposeAward(db, CAROL, ctx.eventId, {
      award_type: 'split',
      lines: [{ event_line_id: ctx.lines[0], bid_id: ctx.bids[4] }, { event_line_id: ctx.lines[1], bid_id: ctx.bids[3] }]
    }, { now: NOW });
    const proposeUsed = proposeCount.inTx;
    assert.ok(proposeUsed <= 25, `propose used ${proposeUsed} prepared statements in its transaction`);
    const prId = view.award.requisition.id;
    const steps = await db.prepare(`SELECT id, approver_id FROM approval_requests WHERE requisition_id = ? ORDER BY step_order`).all(prId);
    await decideApprovalStep(db, { approvalId: steps[0].id, decision: 'approved', approver_id: steps[0].approver_id, approver_name: 'x' });
    const finalCount = countPrepares(db);
    await decideApprovalStep(db, { approvalId: steps[1].id, decision: 'approved', approver_id: steps[1].approver_id, approver_name: 'x' });
    assert.ok(finalCount.inTx <= 25, `final approval used ${finalCount.inTx} prepared statements`);
    console.log(`# 8c statement counts: propose ${proposeUsed}, final approval ${finalCount.inTx}`);
  });
});
