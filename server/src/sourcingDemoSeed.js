/**
 * Demo RFQs for `npm run seed` (Sprint 8d). Non-production only: the seed itself is
 * destructive and never runs against a customer tenant.
 *
 *   RFQ-2026-001  published, deadline in 7 days, three invitations, two sealed bids
 *   RFQ-2026-002  closed, three complete bids, owner Carol Zhang, evaluator David Miller
 *                 with a declared conflict of interest
 *   RFQ-2026-003  awarded as a split, award requisition approved, converted to POs
 *
 * Demo portal links are printed to the console. Only token hashes are stored.
 */

import { decideApprovalStep } from './approvalsService.js';
import { createAwardPurchaseOrders, proposeAward } from './sourcingAwardService.js';
import { completeEvaluation, declareCoi } from './sourcingEvaluationService.js';
import { hashPortalToken, mintPortalToken, portalLink, portalTokenSecret } from './sourcingPortalTokens.js';

export const DEMO_PORTAL_TOKEN_SECRET = 'demo-portal-token-secret-not-for-production-use';

const DAY = 24 * 60 * 60 * 1000;
const OWNER = { id: 3, name: 'Carol Zhang', role: 'procurement', department_id: 3 };
const EVALUATOR = { id: 4, name: 'David Miller', role: 'finance', department_id: 5 };

// Bids can only be written before the deadline, so the closed RFQs start open and are closed after.
const OPEN_DEADLINE = '2999-01-01T00:00:00.000Z';

async function close(db, eventId, deadline) {
  await db.prepare(`
    UPDATE sourcing_events SET status = 'closed', deadline_at = ?, closed_at = ?, updated_at = ? WHERE id = ?
  `).run(deadline, deadline, deadline, eventId);
}

const iso = (ms) => new Date(ms).toISOString();

/** The secret for demo links: the configured one, or a fixed demo one outside production. */
export function demoPortalSecret(env = process.env) {
  const configured = portalTokenSecret(env);
  if (configured) return configured;
  if (env.NODE_ENV === 'production' || env.VERCEL) return null;
  return DEMO_PORTAL_TOKEN_SECRET;
}

async function insertEvent(db, { number, title, status, owner = OWNER, deadline, publishedAt, closedAt, createdAt, lines }) {
  await db.prepare(`
    INSERT INTO sourcing_events (
      event_number, kind, title, description, category, department_id, owner_user_id, status, currency,
      deadline_at, qa_enabled, weight_price, weight_lead_time, weight_quality, target_total_cents,
      published_at, closed_at, row_version, created_at, updated_at
    ) VALUES (?, 'rfq', ?, ?, 'Office Supplies', ?, ?, ?, 'EUR', ?, 0, 70, 15, 15, ?, ?, ?, 0, ?, ?)
  `).run(
    number, title, `Demo: ${title}`, owner.department_id, owner.id, status, deadline,
    lines.reduce((sum, line) => sum + line.quantity * (line.target || 0), 0),
    publishedAt || null, closedAt || null, createdAt, createdAt
  );
  const event = await db.prepare(`SELECT id FROM sourcing_events WHERE event_number = ?`).get(number);
  const lineIds = [];
  for (const [index, line] of lines.entries()) {
    await db.prepare(`
      INSERT INTO sourcing_event_lines (event_id, line_no, description, category, quantity, unit_of_measure, target_unit_price_cents)
      VALUES (?, ?, ?, 'Office Supplies', ?, 'each', ?)
    `).run(event.id, index + 1, line.description, line.quantity, line.target || null);
    const row = await db.prepare(`SELECT id FROM sourcing_event_lines WHERE event_id = ? AND line_no = ?`).get(event.id, index + 1);
    lineIds.push(Number(row.id));
  }
  return { id: Number(event.id), lineIds };
}

async function invite(db, eventId, supplierIds, { secret, createdAt, expiresAt, links, label }) {
  const out = {};
  for (const supplierId of supplierIds) {
    const supplier = await db.prepare(`SELECT code, email, contact_person FROM suppliers WHERE id = ?`).get(supplierId);
    const minted = secret ? mintPortalToken(secret) : null;
    await db.prepare(`
      INSERT INTO sourcing_invitations (
        event_id, supplier_id, contact_name, contact_email, token_hash, token_prefix, expires_at,
        delivery_status, invited_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'copied', ?, ?)
    `).run(
      eventId, supplierId, supplier.contact_person, supplier.email,
      minted ? hashPortalToken(minted.token) : null, minted ? minted.token_prefix : null,
      minted ? expiresAt : null, OWNER.id, createdAt
    );
    const row = await db.prepare(`SELECT id FROM sourcing_invitations WHERE event_id = ? AND supplier_id = ?`).get(eventId, supplierId);
    out[supplierId] = Number(row.id);
    if (minted && links) links.push({ label, supplier: supplier.code, url: portalLink(minted.token) });
  }
  return out;
}

async function insertBid(db, { eventId, invitationId, supplierId, lineIds, quantities, prices, lead, validity, submittedAt }) {
  await db.prepare(`
    INSERT INTO sourcing_bids (event_id, invitation_id, supplier_id, status, current_revision, first_submitted_at, last_submitted_at)
    VALUES (?, ?, ?, 'submitted', 1, ?, ?)
  `).run(eventId, invitationId, supplierId, submittedAt, submittedAt);
  const bid = await db.prepare(`SELECT id FROM sourcing_bids WHERE invitation_id = ?`).get(invitationId);
  const total = prices.reduce((sum, price, i) => sum + (price == null ? 0 : price * quantities[i]), 0);
  await db.prepare(`
    INSERT INTO sourcing_bid_revisions (
      bid_id, revision, submission_id, total_cents, quoted_line_count, validity_until,
      default_lead_time_days, content_sha256, submitted_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)
  `).run(bid.id, `demo-${eventId}-${supplierId}`, total, prices.filter((p) => p != null).length, validity, lead, `demo-${eventId}-${supplierId}`, submittedAt);
  for (const [i, price] of prices.entries()) {
    await db.prepare(`
      INSERT INTO sourcing_bid_lines (bid_id, revision, event_line_id, quoted, unit_price_cents, line_total_cents, lead_time_days)
      VALUES (?, 1, ?, ?, ?, ?, NULL)
    `).run(bid.id, lineIds[i], price == null ? 0 : 1, price, price == null ? null : price * quantities[i]);
  }
  return Number(bid.id);
}

async function approveAll(db, requisitionId) {
  for (let guard = 0; guard < 8; guard += 1) {
    const step = await db.prepare(`
      SELECT id, approver_id FROM approval_requests WHERE requisition_id = ? AND status = 'pending'
    `).get(requisitionId);
    if (!step) return;
    const user = await db.prepare(`SELECT name FROM users WHERE id = ?`).get(step.approver_id);
    await decideApprovalStep(db, {
      approvalId: step.id, decision: 'approved', approver_id: step.approver_id, approver_name: user.name
    });
  }
}

/** Seed the three demo RFQs. Returns the demo portal links (also printed by the caller). */
export async function seedSourcingDemo(db, { now = new Date(), env = process.env } = {}) {
  const secret = demoPortalSecret(env);
  const links = [];
  const t0 = now.getTime();
  const expiresAt = iso(t0 + 30 * DAY);

  // 1. Published, two sealed bids.
  const one = await insertEvent(db, {
    number: 'RFQ-2026-001', title: 'Ergonomische bureaustoelen Q4', status: 'published',
    deadline: iso(t0 + 7 * DAY), publishedAt: iso(t0 - DAY), createdAt: iso(t0 - 2 * DAY),
    lines: [
      { description: 'Ergonomische bureaustoel', quantity: 20, target: 45000 },
      { description: 'Verstelbare armleuning (set)', quantity: 20, target: 6000 }
    ]
  });
  const oneInv = await invite(db, one.id, [3, 1, 4], { secret, createdAt: iso(t0 - DAY), expiresAt, links, label: 'RFQ-2026-001' });
  await insertBid(db, { eventId: one.id, invitationId: oneInv[3], supplierId: 3, lineIds: one.lineIds, quantities: [20, 20], prices: [42500, 5800], lead: 14, validity: iso(t0 + 60 * DAY).slice(0, 10), submittedAt: iso(t0 - 3600_000) });
  await insertBid(db, { eventId: one.id, invitationId: oneInv[1], supplierId: 1, lineIds: one.lineIds, quantities: [20, 20], prices: [46900, 6200], lead: 10, validity: iso(t0 + 60 * DAY).slice(0, 10), submittedAt: iso(t0 - 7200_000) });

  // 2. Closed, three complete bids, conflicted evaluator.
  const two = await insertEvent(db, {
    number: 'RFQ-2026-002', title: 'Laptopvervanging marketing', status: 'published',
    deadline: OPEN_DEADLINE, publishedAt: iso(t0 - 14 * DAY), createdAt: iso(t0 - 15 * DAY),
    lines: [{ description: 'Zakelijke laptop 14 inch', quantity: 8, target: 130000 }]
  });
  const twoInv = await invite(db, two.id, [1, 2, 3], { secret: null, createdAt: iso(t0 - 14 * DAY), expiresAt, links: null });
  for (const [supplierId, price, lead] of [[1, 128000, 7], [2, 124500, 14], [3, 131000, 5]]) {
    await insertBid(db, { eventId: two.id, invitationId: twoInv[supplierId], supplierId, lineIds: two.lineIds, quantities: [8], prices: [price], lead, validity: iso(t0 + 60 * DAY).slice(0, 10), submittedAt: iso(t0 - 5 * DAY) });
  }
  await close(db, two.id, iso(t0 - 3 * DAY));
  await db.prepare(`
    INSERT INTO sourcing_evaluators (event_id, user_id, coi_status, coi_declared_at, coi_note, added_by_user_id, created_at)
    VALUES (?, ?, 'conflict_declared', ?, 'Demo: eerder zakelijk verbonden met een bieder.', ?, ?)
  `).run(two.id, EVALUATOR.id, iso(t0 - 2 * DAY), OWNER.id, iso(t0 - 14 * DAY));

  // 3. Awarded as a split and converted to purchase orders, through the real services.
  const three = await insertEvent(db, {
    number: 'RFQ-2026-003', title: 'Schoonmaakdienst kantoor', status: 'published',
    deadline: OPEN_DEADLINE, publishedAt: iso(t0 - 30 * DAY), createdAt: iso(t0 - 31 * DAY),
    lines: [
      { description: 'Dagelijkse kantoorreiniging (maand)', quantity: 3, target: 150000 },
      { description: 'Sanitaire verbruiksartikelen (pallet)', quantity: 2, target: 40000 }
    ]
  });
  const threeInv = await invite(db, three.id, [4, 3, 1], { secret: null, createdAt: iso(t0 - 30 * DAY), expiresAt, links: null });
  const threeBids = {};
  for (const [supplierId, prices, lead] of [[4, [145000, 41000], 5], [3, [152000, 38500], 7], [1, [149000, 39800], 6]]) {
    threeBids[supplierId] = await insertBid(db, { eventId: three.id, invitationId: threeInv[supplierId], supplierId, lineIds: three.lineIds, quantities: [3, 2], prices, lead, validity: iso(t0 + 60 * DAY).slice(0, 10), submittedAt: iso(t0 - 22 * DAY) });
  }
  await close(db, three.id, iso(t0 - 20 * DAY));
  const evalOptions = { now };
  await declareCoi(db, OWNER, three.id, { status: 'none_declared' }, evalOptions);
  await completeEvaluation(db, OWNER, three.id, { override_reason: 'Demo: scores overgeslagen.' }, evalOptions);
  const award = await proposeAward(db, OWNER, three.id, {
    award_type: 'split',
    lines: [
      { event_line_id: three.lineIds[0], bid_id: threeBids[4] },
      { event_line_id: three.lineIds[1], bid_id: threeBids[3] }
    ]
  }, evalOptions);
  await approveAll(db, award.award.requisition.id);
  await createAwardPurchaseOrders(db, OWNER, three.id, evalOptions);

  return links;
}
