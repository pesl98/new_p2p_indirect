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
import { insertIdempotency, prepareIdempotency, updateIdempotencyBody } from './integrationConnectors.js';
import { isUniqueConstraint } from './masterData.js';
import { addDraftInvitations, createEvent, getEvent, readInvitations } from './sourcingService.js';

const EVENT_STATUSES = ['draft', 'published', 'closed', 'evaluated', 'awarded', 'cancelled'];

function fail(message, status = 400, code = 'integration_error') {
  throw new IntegrationError(message, status, code);
}

/**
 * The person a key acts for: its creator, who must still be an active buyer or admin. Reads and
 * writes both check this, so demoting or deactivating the creator switches the key off.
 */
export async function keyOwner(db, apiKey) {
  const user = await db.prepare(`
    SELECT id, name, role, department_id, status FROM users WHERE id = ?
  `).get(apiKey.created_by_user_id);
  if (!user || user.status !== 'active' || (user.role !== 'procurement' && user.role !== 'admin')) {
    fail('The API key owner is no longer allowed to use sourcing.', 403, 'key_owner_not_buyer');
  }
  return { ...user, name: `${user.name} (API key #${apiKey.id})`, api_key_id: apiKey.id };
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
    SELECT id, status, proposed_at FROM sourcing_awards
    WHERE event_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 1
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

/** Map supplier external ids to local ids with one query. */
async function supplierIdsForExternal(db, items) {
  const wanted = (Array.isArray(items) ? items : []).map((item) => String(item?.supplier_external_id ?? ''));
  if (wanted.length > 20) fail('An RFQ can invite at most 20 suppliers.', 400, 'too_many_invitations');
  if (!wanted.length) return [];
  const rows = await db.prepare(`
    SELECT external_id, entity_id FROM integration_entity_links
    WHERE entity_type = 'supplier' AND external_id IN (${wanted.map(() => '?').join(', ')})
  `).all(...wanted);
  const byExternal = new Map(rows.map((row) => [row.external_id, Number(row.entity_id)]));
  return wanted.map((externalId) => {
    if (!byExternal.has(externalId)) fail('Supplier external id is unknown.', 400, 'supplier_not_found');
    return { supplier_id: byExternal.get(externalId) };
  });
}

function cleanExternalId(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 200) fail('external_id is required (max 200 characters).', 400, 'external_id_required');
  return text;
}

function conflictOf(error, table) {
  return isUniqueConstraint(error) && new RegExp(table, 'i').test(String(error?.message || ''));
}

async function existingDraft(db, apiKey, externalId) {
  return db.prepare(`
    SELECT e.event_number FROM integration_sourcing_links l
    JOIN sourcing_events e ON e.id = l.event_id
    WHERE l.api_key_id = ? AND l.external_id = ?
  `).get(apiKey.id, externalId);
}

/**
 * Create a draft RFQ for a machine client. Everything that can be read is read before the
 * transaction. The RFQ, its link row and the idempotency row are written in the RFQ creation's own
 * BEGIN IMMEDIATE transaction (with its busy and number retry). The full response is built after
 * commit and stored for replays.
 */
export async function createSourcingDraft(db, apiKey, body, { currency, idempotencyKey = null } = {}) {
  const input = body && typeof body === 'object' ? body : {};
  const idem = await prepareIdempotency(db, apiKey, idempotencyKey, input);
  if (idem.replay) return { ...idem.replay, replayed: true };
  const externalId = cleanExternalId(input.external_id);
  const known = await existingDraft(db, apiKey, externalId);
  if (known) return { status: 200, body: await readSourcingEvent(db, known.event_number) };
  for (const forbidden of ['status', 'published_at', 'evaluators', 'source_requisition_id']) {
    if (input[forbidden] != null) fail(`${forbidden} cannot be set through the API.`, 400, 'field_not_allowed');
  }
  const owner = await keyOwner(db, apiKey);
  const invitations = await supplierIdsForExternal(db, input.invitations);
  let eventNumber;
  try {
    await createEvent(
      db,
      owner,
      { ...input, kind: 'rfq', invitations, evaluators: undefined, external_id: undefined },
      {
        currency,
        idOnly: true,
        afterInsert: async (eventId, number) => {
          eventNumber = number;
          await db.prepare(`
            INSERT INTO integration_sourcing_links (api_key_id, event_id, external_id, created_at)
            VALUES (?, ?, ?, ?)
          `).run(apiKey.id, eventId, externalId, new Date().toISOString());
          await insertIdempotency(db, apiKey, idem, 201, { event_number: number, external_id: externalId, status: 'draft' });
        }
      }
    );
  } catch (error) {
    // A parallel request with the same external id or Idempotency-Key won the race.
    if (conflictOf(error, 'integration_sourcing_links')) {
      const winner = await existingDraft(db, apiKey, externalId);
      if (winner) return { status: 200, body: await readSourcingEvent(db, winner.event_number) };
    }
    if (conflictOf(error, 'integration_idempotency')) {
      const again = await prepareIdempotency(db, apiKey, idempotencyKey, input);
      if (again.replay) return { ...again.replay, replayed: true };
    }
    throw error;
  }
  const view = await readSourcingEvent(db, eventNumber);
  await updateIdempotencyBody(db, apiKey, idem, view);
  return { status: 201, body: view };
}

export async function addSourcingInvitations(db, apiKey, number, body, { idempotencyKey = null } = {}) {
  const input = body && typeof body === 'object' ? { ...body, event_number: String(number) } : { event_number: String(number) };
  const idem = await prepareIdempotency(db, apiKey, idempotencyKey, input);
  if (idem.replay) return { ...idem.replay, replayed: true };
  const id = await loadByNumber(db, number);
  const owner = await keyOwner(db, apiKey);
  const wanted = Array.isArray(body?.invitations) ? body.invitations : [];
  if (!wanted.length) fail('invitations is required.', 400, 'invitations_required');
  const rows = await readInvitations(db, await supplierIdsForExternal(db, wanted));
  try {
    await addDraftInvitations(db, owner, id, rows, {
      afterWrite: (eventNumber) => insertIdempotency(db, apiKey, idem, 200, { event_number: eventNumber, status: 'draft' })
    });
  } catch (error) {
    if (conflictOf(error, 'integration_idempotency')) {
      const again = await prepareIdempotency(db, apiKey, idempotencyKey, input);
      if (again.replay) return { ...again.replay, replayed: true };
    }
    throw error;
  }
  const view = await readSourcingEvent(db, number);
  await updateIdempotencyBody(db, apiKey, idem, view);
  return { status: 200, body: view };
}
