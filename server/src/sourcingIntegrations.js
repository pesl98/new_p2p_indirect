/**
 * Sourcing for machine clients (Sprint 8d).
 *
 * A key can read events, bids (after the deadline) and the award, create a
 * draft RFQ and add invitees to a draft. It can never publish, award, cancel,
 * or see portal links, tokens or contact emails. The draft belongs to the
 * user who created the key, who must be procurement or admin.
 */

import { IntegrationError } from './apiKeys.js';
import { loadMachineBids } from './sourcingBidReadModel.js';
import { createEvent, getEvent, updateEvent } from './sourcingService.js';

const EVENT_STATUSES = ['draft', 'published', 'closed', 'evaluated', 'awarded', 'cancelled'];

function fail(message, status = 400, code = 'integration_error') {
  throw new IntegrationError(message, status, code);
}

async function keyOwner(db, apiKey) {
  const user = await db.prepare(`
    SELECT id, name, role, department_id, status FROM users WHERE id = ?
  `).get(apiKey.created_by_user_id);
  if (!user || user.status !== 'active' || (user.role !== 'procurement' && user.role !== 'admin')) {
    fail('The API key owner cannot create RFQs.', 403, 'key_owner_not_buyer');
  }
  return user;
}

async function loadByNumber(db, number) {
  const row = await db.prepare(`SELECT id FROM sourcing_events WHERE event_number = ?`).get(String(number));
  if (!row) fail('RFQ was not found.', 404, 'event_not_found');
  return row.id;
}

function present(event) {
  return {
    event_number: event.event_number,
    title: event.title,
    status: event.status,
    currency: event.currency,
    deadline_at: event.deadline_at,
    published_at: event.published_at,
    closed_at: event.closed_at,
    awarded_at: event.awarded_at,
    outcome_published_at: event.outcome_published_at || null,
    updated_at: event.updated_at
  };
}

export async function listSourcingEvents(db, query = {}) {
  const params = [];
  let sql = `
    SELECT e.event_number, e.title, e.status, e.currency, e.deadline_at, e.published_at,
           e.closed_at, e.awarded_at, e.outcome_published_at, e.updated_at,
           l.external_id
    FROM sourcing_events e
    LEFT JOIN integration_sourcing_links l ON l.event_id = e.id
    WHERE 1 = 1
  `;
  if (query.status && query.status !== 'all') {
    if (!EVENT_STATUSES.includes(String(query.status))) fail('Unknown status filter.', 400, 'invalid_status');
    sql += ' AND e.status = ?';
    params.push(String(query.status));
  }
  if (query.updated_since) {
    const since = Date.parse(String(query.updated_since));
    if (!Number.isFinite(since)) fail('updated_since must be an ISO timestamp.', 400, 'invalid_updated_since');
    sql += ' AND e.updated_at >= ?';
    params.push(new Date(since).toISOString());
  }
  sql += ' ORDER BY e.updated_at ASC, e.id ASC LIMIT 200';
  return { events: await db.prepare(sql).all(...params) };
}

export async function readSourcingEvent(db, number, now = new Date()) {
  const id = await loadByNumber(db, number);
  const event = await getEvent(db, id, now);
  const link = await db.prepare(`SELECT external_id FROM integration_sourcing_links WHERE event_id = ?`).get(id);
  const lines = event.lines.map((line) => ({
    line_no: line.line_no,
    description: line.description,
    quantity: line.quantity,
    unit_of_measure: line.unit_of_measure,
    target_unit_price_cents: line.target_unit_price_cents
  }));
  const invited = await db.prepare(`
    SELECT s.code AS supplier_code, s.name AS supplier_name, i.declined_at
    FROM sourcing_invitations i JOIN suppliers s ON s.id = i.supplier_id
    WHERE i.event_id = ? AND i.revoked_at IS NULL ORDER BY i.id ASC
  `).all(id);
  const bids = await loadMachineBids(db, event, now);
  return {
    ...present(event),
    external_id: link?.external_id || null,
    lines,
    invitations: invited.map((row) => ({
      supplier_code: row.supplier_code,
      supplier_name: row.supplier_name,
      declined: Boolean(row.declined_at)
    })),
    bids_sealed: bids.sealed,
    bids: bids.bids
  };
}

export async function readSourcingAward(db, number) {
  const id = await loadByNumber(db, number);
  const award = await db.prepare(`
    SELECT id, status, proposed_at FROM sourcing_awards WHERE event_id = ? ORDER BY id DESC LIMIT 1
  `).get(id);
  if (!award) return { award: null };
  const lines = await db.prepare(`
    SELECT l.line_no, s.code AS supplier_code, s.name AS supplier_name, al.quantity,
           al.unit_price_cents, al.line_total_cents
    FROM sourcing_award_lines al
    JOIN suppliers s ON s.id = al.supplier_id
    JOIN sourcing_event_lines l ON l.id = al.event_line_id
    WHERE al.award_id = ? ORDER BY l.line_no ASC
  `).all(award.id);
  const orders = await db.prepare(`
    SELECT po.po_number, s.code AS supplier_code, po.total_amount
    FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
    WHERE po.award_id = ? ORDER BY po.id ASC
  `).all(award.id);
  return { award: { status: award.status, proposed_at: award.proposed_at, lines, purchase_orders: orders } };
}

async function supplierIdForExternal(db, externalId) {
  const row = await db.prepare(`
    SELECT entity_id FROM integration_entity_links WHERE entity_type = 'supplier' AND external_id = ?
  `).get(String(externalId ?? ''));
  if (!row) fail('Supplier external id is unknown.', 400, 'supplier_not_found');
  return row.entity_id;
}

function cleanExternalId(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 200) fail('external_id is required (max 200 characters).', 400, 'external_id_required');
  return text;
}

export async function createSourcingDraft(db, apiKey, body, { currency } = {}) {
  const input = body && typeof body === 'object' ? body : {};
  const externalId = cleanExternalId(input.external_id);
  const existing = await db.prepare(`
    SELECT e.event_number FROM integration_sourcing_links l
    JOIN sourcing_events e ON e.id = l.event_id WHERE l.external_id = ?
  `).get(externalId);
  if (existing) return { status: 200, body: await readSourcingEvent(db, existing.event_number) };
  for (const forbidden of ['status', 'published_at', 'evaluators', 'source_requisition_id']) {
    if (input[forbidden] != null) fail(`${forbidden} cannot be set through the API.`, 400, 'field_not_allowed');
  }
  const owner = await keyOwner(db, apiKey);
  const invitations = [];
  for (const item of Array.isArray(input.invitations) ? input.invitations : []) {
    invitations.push({ supplier_id: await supplierIdForExternal(db, item?.supplier_external_id) });
  }
  const created = await createEvent(
    db,
    owner,
    { ...input, kind: 'rfq', invitations, evaluators: undefined, external_id: undefined },
    { currency }
  );
  await db.prepare(`
    INSERT INTO integration_sourcing_links (event_id, external_id, created_at) VALUES (?, ?, ?)
  `).run(created.id, externalId, new Date().toISOString());
  return { status: 201, body: await readSourcingEvent(db, created.event_number) };
}

export async function addSourcingInvitations(db, apiKey, number, body) {
  const id = await loadByNumber(db, number);
  const owner = await keyOwner(db, apiKey);
  const event = await getEvent(db, id);
  if (event.status !== 'draft') fail('Invitees can only be added to a draft RFQ.', 409, 'event_not_draft');
  const wanted = Array.isArray(body?.invitations) ? body.invitations : [];
  if (!wanted.length) fail('invitations is required.', 400, 'invitations_required');
  const rows = event.invitations.map((item) => ({
    supplier_id: item.supplier_id,
    contact_name: item.contact_name,
    contact_email: item.contact_email
  }));
  for (const item of wanted) {
    const supplierId = await supplierIdForExternal(db, item?.supplier_external_id);
    if (!rows.some((row) => Number(row.supplier_id) === Number(supplierId))) rows.push({ supplier_id: supplierId });
  }
  // Updating as the key owner keeps the normal owner rules; an admin can edit any draft.
  await updateEvent(db, owner, id, { row_version: event.row_version, invitations: rows });
  return { status: 200, body: await readSourcingEvent(db, number) };
}
