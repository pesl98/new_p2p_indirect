/**
 * Buyer RFQ drafts. Create, edit, cancel, invite, and attach PDFs.
 * Publishing, magic links, bids, comparison, and award are later sprints.
 * Money is integer cents. Invitations are never copied from a requisition
 * line: estimated_supplier_id defaults to supplier 1 and is not a chosen invitee.
 */

import { actorFromSession, appendComplianceEvent } from './complianceAudit.js';
import { nextDocumentNumber } from './docNumbers.js';
import { LineTypeError, normalizeLineType, resolveServiceBasis } from './lineType.js';
import { isUniqueConstraint } from './masterData.js';
import { lineTotalCents, requireIntegerCents } from './money.js';
import {
  MAX_EVENT_FILES,
  MAX_EVENT_LINES,
  MAX_INVITATIONS,
  SOURCING_CATEGORIES,
  SPEC_LINE_DESCRIPTION,
  isPdfBuffer,
  parseDeadline,
  safePdfFilename,
  sha256Pdf,
  utcIso
} from './sourcingConfig.js';
import { assertTransition } from './sourcingStatus.js';

export class SourcingError extends Error {
  constructor(message, statusCode = 400, code = 'sourcing_error') {
    super(message);
    this.name = 'SourcingError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fail(message, statusCode, code) {
  throw new SourcingError(message, statusCode, code);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function optionalText(value, max, code = 'text_too_long') {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > max) fail('Text is too long.', 400, code);
  return text;
}

function requireText(value, max, code, message) {
  const text = optionalText(value, max, code);
  if (!text) fail(message, 400, code);
  return text;
}

function optionalCents(value, field) {
  if (value == null || value === '') return null;
  let cents;
  try {
    cents = requireIntegerCents(value, field);
  } catch (error) {
    fail(error.message, 400, 'invalid_amount');
  }
  if (cents < 0) fail(`${field} cannot be negative.`, 400, 'invalid_amount');
  return cents;
}

function readQuantity(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 1_000_000) {
    fail('Quantity must be a positive whole number.', 400, 'invalid_quantity');
  }
  return n;
}

function readCategory(value, { required = false } = {}) {
  if (value == null || String(value).trim() === '') {
    if (required) fail('Category is required.', 400, 'category_invalid');
    return null;
  }
  const category = String(value).trim();
  if (!SOURCING_CATEGORIES.includes(category)) {
    fail('Category is not one of the sourcing categories.', 400, 'category_invalid');
  }
  return category;
}

function readWeights(input) {
  const keys = ['weight_price', 'weight_lead_time', 'weight_quality'];
  const present = keys.filter((key) => input[key] != null && input[key] !== '');
  if (present.length === 0) return null;
  if (present.length !== 3) {
    fail('Send price, lead time, and quality weights together. They must add up to 100.', 400, 'weights_invalid');
  }
  const weights = {};
  for (const key of keys) {
    const n = Number(input[key]);
    if (!Number.isInteger(n) || n < 0 || n > 100) {
      fail('Scoring weights must be integers from 0 to 100 that add up to 100.', 400, 'weights_invalid');
    }
    weights[key] = n;
  }
  if (weights.weight_price + weights.weight_lead_time + weights.weight_quality !== 100) {
    fail('Scoring weights must add up to 100.', 400, 'weights_invalid');
  }
  return weights;
}

function readSchedule(input) {
  const schedule = {};
  if (hasOwn(input, 'deadline_at')) {
    const deadline = parseDeadline(input.deadline_at);
    if (input.deadline_at != null && String(input.deadline_at).trim() !== '' && !deadline) {
      fail('Deadline is not a valid date and time.', 400, 'invalid_deadline');
    }
    schedule.deadline_at = deadline;
  }
  if (hasOwn(input, 'qa_enabled')) {
    const flag = input.qa_enabled;
    const on = flag === true || flag === 1 || flag === '1';
    const off = flag === false || flag === 0 || flag === '0' || flag == null || flag === '';
    if (!on && !off) fail('qa_enabled must be true or false.', 400, 'invalid_deadline');
    schedule.qa_enabled = on ? 1 : 0;
  }
  if (hasOwn(input, 'qa_deadline_at')) {
    const qa = parseDeadline(input.qa_deadline_at);
    if (input.qa_deadline_at != null && String(input.qa_deadline_at).trim() !== '' && !qa) {
      fail('Question deadline is not a valid date and time.', 400, 'invalid_deadline');
    }
    schedule.qa_deadline_at = qa;
  }
  return schedule;
}

function assertScheduleOrder(deadline, qaEnabled, qaDeadline) {
  if (qaEnabled && qaDeadline && deadline && qaDeadline > deadline) {
    fail('The question deadline must be at or before the RFQ deadline.', 400, 'invalid_deadline');
  }
}

function assertWriter(actor) {
  if (actor?.role !== 'procurement' && actor?.role !== 'admin') {
    fail('Insufficient role for this action', 403, 'read_only');
  }
}

function assertOwner(actor, event) {
  assertWriter(actor);
  if (actor.role === 'admin') return;
  if (Number(event.owner_user_id) !== Number(actor.id)) {
    fail('Only the RFQ owner or an admin can edit this draft.', 403, 'not_owner');
  }
}

function assertDraft(event) {
  if (event.status !== 'draft') {
    fail('Only a draft RFQ can be edited.', 409, 'event_not_draft');
  }
}

function rejectStatusSpoof(input, currentStatus) {
  if (!hasOwn(input, 'status') || input.status == null || input.status === '') return;
  if (input.status !== currentStatus) {
    fail('Status changes go through the sourcing transition.', 409, 'invalid_transition');
  }
}

async function writeAudit(db, entityType, entityId, action, actorName, details) {
  await db.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
    VALUES (?, ?, ?, ?, ?)
  `).run(entityType, entityId, action, actorName, details);
}

async function writeCompliance(db, actor, action, entityType, entityId, details) {
  await appendComplianceEvent(db, {
    ...actorFromSession(actor),
    action,
    entity_type: entityType,
    entity_id: entityId,
    details: JSON.stringify(details)
  });
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email || email.length > 200 || !EMAIL_RE.test(email)) return null;
  return email;
}

async function readDepartment(db, actor, value) {
  if (value == null || value === '') {
    if (actor.department_id == null) fail('department_id is required.', 400, 'department_not_found');
    return Number(actor.department_id);
  }
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) fail('Department was not found.', 400, 'department_not_found');
  const row = await db.prepare(`SELECT id FROM departments WHERE id = ?`).get(id);
  if (!row) fail('Department was not found.', 400, 'department_not_found');
  return id;
}

function buyerLine(item, { trustCatalog = false } = {}) {
  const description = requireText(item.description || item.item_description, 2000, 'line_invalid', 'Each line needs a description.');
  const category = readCategory(item.category, { required: true });
  const quantity = readQuantity(item.quantity);
  const unit = optionalText(item.unit_of_measure, 40) || 'each';
  let lineType;
  let serviceBasis;
  try {
    lineType = normalizeLineType(item.line_type, category);
    if (lineType !== 'service' && item.service_basis) {
      fail('A goods line cannot have a service basis.', 400, 'line_invalid');
    }
    serviceBasis = resolveServiceBasis(item.service_basis, lineType);
  } catch (error) {
    if (error instanceof SourcingError) throw error;
    if (error instanceof LineTypeError) fail(error.message, 400, 'line_invalid');
    throw error;
  }
  const catalogId = item.catalog_item_id == null || item.catalog_item_id === ''
    ? null
    : Number(item.catalog_item_id);
  if (catalogId != null && (!Number.isInteger(catalogId) || catalogId <= 0)) {
    fail('Catalog item was not found.', 400, 'line_invalid');
  }
  const requisitionItemId = item.requisition_item_id == null || item.requisition_item_id === ''
    ? null
    : Number(item.requisition_item_id);
  if (requisitionItemId != null && (!Number.isInteger(requisitionItemId) || requisitionItemId <= 0)) {
    fail('Requisition line was not found.', 400, 'line_invalid');
  }
  return {
    description,
    category,
    quantity,
    unit_of_measure: unit,
    line_type: lineType,
    service_basis: serviceBasis,
    target_unit_price_cents: optionalCents(item.target_unit_price_cents, 'target_unit_price_cents'),
    notes: optionalText(item.notes, 2000),
    catalog_item_id: catalogId,
    requisition_item_id: requisitionItemId,
    trustCatalog
  };
}

function readLines(input) {
  const spec = input.spec_only === true || input.spec_only === 1 || input.spec_only === '1';
  const hasLines = Array.isArray(input.lines) && input.lines.length > 0;
  if (spec && hasLines) {
    fail('A specification-only RFQ cannot also include lines.', 400, 'spec_and_lines');
  }
  if (!spec && input.lines == null) return undefined;
  if (spec) {
    const category = readCategory(input.category, { required: true });
    return [buyerLine({
      description: SPEC_LINE_DESCRIPTION,
      category,
      quantity: 1,
      unit_of_measure: 'each',
      line_type: 'service',
      service_basis: 'lump_sum',
      target_unit_price_cents: input.target_unit_price_cents
    })];
  }
  if (!Array.isArray(input.lines)) fail('Lines must be a list.', 400, 'line_invalid');
  if (input.lines.length > MAX_EVENT_LINES) {
    fail(`An RFQ can have at most ${MAX_EVENT_LINES} lines.`, 400, 'too_many_lines');
  }
  return input.lines.map((item) => buyerLine(item));
}

async function assertCatalogLines(db, lines) {
  if (!lines) return;
  for (const line of lines) {
    if (line.catalog_item_id == null || line.trustCatalog) continue;
    const item = await db.prepare(`SELECT id, status FROM catalog_items WHERE id = ?`).get(line.catalog_item_id);
    if (!item || (item.status && item.status !== 'active')) {
      fail('Catalog item was not found or is not active.', 400, 'line_invalid');
    }
  }
}

async function readInvitations(db, raw) {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) fail('Invitations must be a list.', 400, 'supplier_not_found');
  if (raw.length > MAX_INVITATIONS) {
    fail(`An RFQ can invite at most ${MAX_INVITATIONS} suppliers.`, 400, 'too_many_invitations');
  }
  const seen = new Set();
  const rows = [];
  for (const item of raw) {
    const supplierId = Number(item?.supplier_id);
    if (!Number.isInteger(supplierId) || supplierId <= 0) {
      fail('Supplier was not found.', 400, 'supplier_not_found');
    }
    if (seen.has(supplierId)) fail('Each supplier can be invited once.', 400, 'duplicate_invitation');
    seen.add(supplierId);
    const supplier = await db.prepare(`
      SELECT id, code, email, contact_person, status FROM suppliers WHERE id = ?
    `).get(supplierId);
    if (!supplier) fail('Supplier was not found.', 400, 'supplier_not_found');
    if (supplier.status !== 'active') {
      fail('Only an active supplier can be invited.', 400, 'supplier_not_active');
    }
    const email = normalizeEmail(item.contact_email || supplier.email);
    if (!email) fail('Each invitation needs a contact email.', 400, 'contact_email_required');
    rows.push({
      supplier_id: supplierId,
      supplier_code: supplier.code,
      contact_name: optionalText(item.contact_name, 200) || optionalText(supplier.contact_person, 200),
      contact_email: email
    });
  }
  return rows;
}

async function readEvaluators(db, raw) {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) fail('Evaluators must be a list.', 400, 'evaluator_not_found');
  if (raw.length > 20) fail('An RFQ can have at most 20 evaluators.', 400, 'too_many_lines');
  const seen = new Set();
  const ids = [];
  for (const item of raw) {
    const userId = Number(typeof item === 'object' && item ? item.user_id : item);
    if (!Number.isInteger(userId) || userId <= 0) fail('Evaluator was not found.', 400, 'evaluator_not_found');
    if (seen.has(userId)) continue;
    seen.add(userId);
    const user = await db.prepare(`SELECT id, status FROM users WHERE id = ?`).get(userId);
    if (!user || user.status === 'inactive') fail('Evaluator was not found.', 400, 'evaluator_not_found');
    ids.push(userId);
  }
  return ids;
}

function targetTotal(lines) {
  if (!lines?.length) return null;
  if (lines.some((line) => line.target_unit_price_cents == null)) return null;
  return lines.reduce((sum, line) => sum + lineTotalCents(line.quantity, line.target_unit_price_cents), 0);
}

async function insertLines(db, eventId, lines) {
  const insert = db.prepare(`
    INSERT INTO sourcing_event_lines (
      event_id, line_no, requisition_item_id, catalog_item_id, description, category,
      quantity, unit_of_measure, line_type, service_basis, target_unit_price_cents, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    await insert.run(
      eventId,
      index + 1,
      line.requisition_item_id,
      line.catalog_item_id,
      line.description,
      line.category,
      line.quantity,
      line.unit_of_measure,
      line.line_type,
      line.service_basis,
      line.target_unit_price_cents,
      line.notes
    );
  }
}

async function insertInvitations(db, eventId, actor, invitations, now) {
  const insert = db.prepare(`
    INSERT INTO sourcing_invitations (
      event_id, supplier_id, contact_name, contact_email, delivery_status, invited_by_user_id, created_at
    ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `);
  for (const invitation of invitations) {
    const result = await insert.run(
      eventId,
      invitation.supplier_id,
      invitation.contact_name,
      invitation.contact_email,
      actor.id,
      now
    );
    let invitationId = Number(result.lastInsertRowid);
    if (!invitationId) {
      const created = await db.prepare(`
        SELECT id FROM sourcing_invitations WHERE event_id = ? AND supplier_id = ?
      `).get(eventId, invitation.supplier_id);
      invitationId = Number(created?.id || 0);
    }
    await writeCompliance(db, actor, 'SOURCING_INVITATION_CREATED', 'sourcing_invitation', invitationId, {
      supplier_code: invitation.supplier_code,
      token_prefix: null,
      delivery: 'pending'
    });
    await writeAudit(
      db,
      'sourcing_event',
      eventId,
      'INVITATION_CREATED',
      actor.name,
      `Invited ${invitation.supplier_code} (${invitation.contact_email})`
    );
  }
}

async function insertEvaluators(db, eventId, actor, userIds, now) {
  const insert = db.prepare(`
    INSERT INTO sourcing_evaluators (event_id, user_id, added_by_user_id, created_at)
    VALUES (?, ?, ?, ?)
  `);
  for (const userId of userIds) {
    await insert.run(eventId, userId, actor.id, now);
  }
}

async function loadEventRow(db, id) {
  const eventId = Number(id);
  if (!Number.isInteger(eventId) || eventId <= 0) return null;
  return db.prepare(`SELECT * FROM sourcing_events WHERE id = ?`).get(eventId);
}

export async function findOpenSourcingEvent(db, requisitionId) {
  return db.prepare(`
    SELECT id, event_number, status
    FROM sourcing_events
    WHERE source_requisition_id = ? AND status != 'cancelled'
    LIMIT 1
  `).get(requisitionId);
}

async function copyRequisitionLines(db, requisitionId) {
  const rows = await db.prepare(`
    SELECT
      ri.id, ri.item_description, ri.category, ri.quantity, ri.unit_price,
      ri.line_type, ri.service_basis, ri.catalog_item_id, ci.unit AS catalog_unit
    FROM requisition_items ri
    LEFT JOIN catalog_items ci ON ci.id = ri.catalog_item_id
    WHERE ri.requisition_id = ?
    ORDER BY ri.id ASC
  `).all(requisitionId);
  if (!rows.length) fail('The requisition has no lines to copy.', 400, 'requisition_has_no_lines');
  if (rows.length > MAX_EVENT_LINES) {
    fail(`An RFQ can have at most ${MAX_EVENT_LINES} lines.`, 400, 'too_many_lines');
  }
  return rows.map((row) => buyerLine({
    description: row.item_description,
    category: row.category,
    quantity: row.quantity,
    unit_of_measure: row.catalog_unit || 'each',
    line_type: row.line_type,
    service_basis: row.service_basis,
    target_unit_price_cents: row.unit_price,
    requisition_item_id: row.id,
    catalog_item_id: row.catalog_item_id
  }, { trustCatalog: true }));
}

function sharedCategory(lines) {
  const first = lines[0]?.category;
  if (first && lines.every((line) => line.category === first)) return readCategory(first);
  return null;
}

async function replaceLines(db, eventId, lines) {
  await db.prepare(`DELETE FROM sourcing_event_lines WHERE event_id = ?`).run(eventId);
  await insertLines(db, eventId, lines);
}

async function replaceInvitations(db, eventId, actor, invitations, now) {
  const existing = await db.prepare(`
    SELECT id, supplier_id, token_hash FROM sourcing_invitations WHERE event_id = ?
  `).all(eventId);
  const keep = new Set(invitations.map((row) => row.supplier_id));
  for (const row of existing) {
    if (keep.has(row.supplier_id)) continue;
    if (row.token_hash) fail('An invitation with a link cannot be removed here.', 409, 'event_state_changed');
    await db.prepare(`DELETE FROM sourcing_invitations WHERE id = ? AND token_hash IS NULL`).run(row.id);
  }
  const already = new Set(existing.filter((row) => keep.has(row.supplier_id)).map((row) => row.supplier_id));
  const fresh = invitations.filter((row) => !already.has(row.supplier_id));
  await insertInvitations(db, eventId, actor, fresh, now);
  for (const row of invitations) {
    if (!already.has(row.supplier_id)) continue;
    await db.prepare(`
      UPDATE sourcing_invitations
      SET contact_name = ?, contact_email = ?
      WHERE event_id = ? AND supplier_id = ? AND token_hash IS NULL
    `).run(row.contact_name, row.contact_email, eventId, row.supplier_id);
  }
}

async function replaceEvaluators(db, eventId, actor, userIds, now) {
  const existing = await db.prepare(`SELECT user_id FROM sourcing_evaluators WHERE event_id = ?`).all(eventId);
  const keep = new Set(userIds);
  for (const row of existing) {
    if (!keep.has(row.user_id)) {
      await db.prepare(`DELETE FROM sourcing_evaluators WHERE event_id = ? AND user_id = ?`).run(eventId, row.user_id);
    }
  }
  const already = new Set(existing.map((row) => row.user_id));
  await insertEvaluators(db, eventId, actor, userIds.filter((id) => !already.has(id)), now);
}

function eventIdFromInsert(result, fallbackId) {
  const id = Number(result.lastInsertRowid) || Number(fallbackId) || 0;
  if (!id) fail('Failed to allocate an RFQ id after insert.', 500, 'sourcing_error');
  return id;
}

async function insertEvent(db, actor, fields, lines, invitations, evaluators, source) {
  const now = utcIso();
  const currency = fields.currency;
  if (!currency) fail('Currency is not configured.', 500, 'sourcing_error');
  await assertCatalogLines(db, lines);
  const weights = fields.weights || { weight_price: 70, weight_lead_time: 15, weight_quality: 15 };
  assertScheduleOrder(fields.deadline_at || null, fields.qa_enabled || 0, fields.qa_deadline_at || null);
  if (fields.source_requisition_id) {
    const open = await findOpenSourcingEvent(db, fields.source_requisition_id);
    if (open) fail('This requisition already has an open RFQ.', 409, 'requisition_in_sourcing');
  }

  try {
    return await db.transaction(async () => {
      const year = Number(String(now).slice(0, 4));
      const eventNumber = await nextDocumentNumber(db, 'rfq', year);
      const result = await db.prepare(`
        INSERT INTO sourcing_events (
          event_number, kind, title, description, category, department_id, owner_user_id,
          source_requisition_id, status, currency, deadline_at, qa_enabled, qa_deadline_at,
          weight_price, weight_lead_time, weight_quality, target_total_cents,
          row_version, created_at, updated_at
        ) VALUES (?, 'rfq', ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(
        eventNumber,
        fields.title,
        fields.description,
        fields.category,
        fields.department_id,
        actor.id,
        fields.source_requisition_id,
        currency,
        fields.deadline_at || null,
        fields.qa_enabled || 0,
        fields.qa_deadline_at || null,
        weights.weight_price,
        weights.weight_lead_time,
        weights.weight_quality,
        targetTotal(lines || []),
        now,
        now
      );
      let eventId = Number(result.lastInsertRowid);
      if (!eventId) {
        const created = await db.prepare(`SELECT id FROM sourcing_events WHERE event_number = ?`).get(eventNumber);
        eventId = eventIdFromInsert(result, created?.id);
      }
      if (lines?.length) await insertLines(db, eventId, lines);
      if (invitations?.length) await insertInvitations(db, eventId, actor, invitations, now);
      if (evaluators?.length) await insertEvaluators(db, eventId, actor, evaluators, now);
      await writeAudit(
        db,
        'sourcing_event',
        eventId,
        'CREATED',
        actor.name,
        source === 'requisition'
          ? `RFQ ${eventNumber} created from requisition ${fields.source_requisition_id}`
          : `RFQ ${eventNumber} created from scratch`
      );
      await writeCompliance(db, actor, 'SOURCING_EVENT_CREATED', 'sourcing_event', eventId, {
        source,
        source_requisition_id: fields.source_requisition_id || null
      });
      return eventId;
    })();
  } catch (error) {
    if (error instanceof SourcingError) throw error;
    if (isUniqueConstraint(error) && /source_requisition/i.test(String(error.message || ''))) {
      fail('This requisition already has an open RFQ.', 409, 'requisition_in_sourcing');
    }
    if (isUniqueConstraint(error) && /sourcing_invitations/i.test(String(error.message || ''))) {
      fail('Each supplier can be invited once.', 409, 'duplicate_invitation');
    }
    throw error;
  }
}

export async function createEvent(db, actor, input, { currency } = {}) {
  assertWriter(actor);
  rejectStatusSpoof(input, 'draft');
  if (input.kind != null && input.kind !== '' && input.kind !== 'rfq') {
    fail('Only an RFQ can be created. Tenders are out of scope.', 400, 'kind_not_supported');
  }
  if (input.source_requisition_id != null && input.source_requisition_id !== '') {
    fail('Use the from-requisition action to copy an approved requisition.', 400, 'requisition_not_approved');
  }
  const title = requireText(input.title, 200, 'title_required', 'Title is required.');
  const description = optionalText(input.description, 20000);
  const category = readCategory(input.category);
  const departmentId = await readDepartment(db, actor, input.department_id);
  const schedule = readSchedule(input);
  const weights = readWeights(input);
  const lines = readLines(input) || [];
  const invitations = await readInvitations(db, input.invitations) || [];
  const evaluators = await readEvaluators(db, input.evaluators) || [];
  const eventId = await insertEvent(db, actor, {
    title,
    description,
    category,
    department_id: departmentId,
    source_requisition_id: null,
    currency,
    deadline_at: schedule.deadline_at || null,
    qa_enabled: schedule.qa_enabled || 0,
    qa_deadline_at: schedule.qa_deadline_at || null,
    weights
  }, lines, invitations, evaluators, 'scratch');
  return getEvent(db, eventId);
}

export async function createEventFromRequisition(db, actor, requisitionId, input = {}, { currency } = {}) {
  assertWriter(actor);
  const id = Number(requisitionId);
  if (!Number.isInteger(id) || id <= 0) fail('Requisition was not found.', 404, 'requisition_not_found');
  const pr = await db.prepare(`
    SELECT id, pr_number, status, department_id, justification FROM purchase_requisitions WHERE id = ?
  `).get(id);
  if (!pr) fail('Requisition was not found.', 404, 'requisition_not_found');
  if (pr.status !== 'approved') {
    fail('An RFQ can only be raised from an approved requisition.', 400, 'requisition_not_approved');
  }
  const lines = await copyRequisitionLines(db, pr.id);
  const body = input && typeof input === 'object' ? input : {};
  rejectStatusSpoof(body, 'draft');
  if (body.kind != null && body.kind !== '' && body.kind !== 'rfq') {
    fail('Only an RFQ can be created. Tenders are out of scope.', 400, 'kind_not_supported');
  }
  const title = optionalText(body.title, 200) || `Offerteaanvraag ${pr.pr_number}`;
  const description = hasOwn(body, 'description')
    ? optionalText(body.description, 20000)
    : optionalText(pr.justification, 20000);
  const schedule = readSchedule(body);
  const weights = readWeights(body);
  const invitations = await readInvitations(db, body.invitations) || [];
  const evaluators = await readEvaluators(db, body.evaluators) || [];
  const eventId = await insertEvent(db, actor, {
    title,
    description,
    category: sharedCategory(lines),
    department_id: pr.department_id,
    source_requisition_id: pr.id,
    currency,
    deadline_at: schedule.deadline_at || null,
    qa_enabled: schedule.qa_enabled || 0,
    qa_deadline_at: schedule.qa_deadline_at || null,
    weights
  }, lines, invitations, evaluators, 'requisition');
  return getEvent(db, eventId);
}

export async function updateEvent(db, actor, id, input) {
  const existing = await loadEventRow(db, id);
  if (!existing) fail('RFQ was not found.', 404, 'event_not_found');
  assertOwner(actor, existing);
  assertDraft(existing);
  rejectStatusSpoof(input, existing.status);
  if (input.row_version == null || input.row_version === '') {
    fail('row_version is required.', 400, 'row_version_required');
  }
  const version = Number(input.row_version);
  if (!Number.isInteger(version) || version !== Number(existing.row_version)) {
    fail('The RFQ changed while it was being saved.', 409, 'event_state_changed');
  }
  if (input.kind != null && input.kind !== existing.kind) {
    fail('Only an RFQ can be created. Tenders are out of scope.', 400, 'kind_not_supported');
  }

  const title = hasOwn(input, 'title')
    ? requireText(input.title, 200, 'title_required', 'Title is required.')
    : existing.title;
  const description = hasOwn(input, 'description') ? optionalText(input.description, 20000) : existing.description;
  const category = hasOwn(input, 'category') ? readCategory(input.category) : existing.category;
  const departmentId = hasOwn(input, 'department_id')
    ? await readDepartment(db, actor, input.department_id)
    : existing.department_id;
  const schedule = readSchedule(input);
  const deadline = hasOwn(schedule, 'deadline_at') ? schedule.deadline_at : existing.deadline_at;
  const qaEnabled = hasOwn(schedule, 'qa_enabled') ? schedule.qa_enabled : existing.qa_enabled;
  const qaDeadline = hasOwn(schedule, 'qa_deadline_at') ? schedule.qa_deadline_at : existing.qa_deadline_at;
  assertScheduleOrder(deadline, qaEnabled, qaDeadline);
  const weights = readWeights(input) || {
    weight_price: existing.weight_price,
    weight_lead_time: existing.weight_lead_time,
    weight_quality: existing.weight_quality
  };
  const lines = readLines({ ...input, category: category || input.category });
  if (lines) await assertCatalogLines(db, lines);
  const invitations = await readInvitations(db, input.invitations);
  const evaluators = await readEvaluators(db, input.evaluators);
  const now = utcIso();

  const changed = await db.immediateTransaction(async () => {
    if (lines) await replaceLines(db, existing.id, lines);
    if (invitations) await replaceInvitations(db, existing.id, actor, invitations, now);
    if (evaluators) await replaceEvaluators(db, existing.id, actor, evaluators, now);
    const lineRows = lines || await db.prepare(`
      SELECT quantity, target_unit_price_cents FROM sourcing_event_lines WHERE event_id = ?
    `).all(existing.id);
    const result = await db.prepare(`
      UPDATE sourcing_events
      SET title = ?, description = ?, category = ?, department_id = ?,
          deadline_at = ?, qa_enabled = ?, qa_deadline_at = ?,
          weight_price = ?, weight_lead_time = ?, weight_quality = ?,
          target_total_cents = ?, row_version = row_version + 1, updated_at = ?
      WHERE id = ? AND status = 'draft' AND row_version = ?
    `).run(
      title,
      description,
      category,
      departmentId,
      deadline,
      qaEnabled,
      qaDeadline,
      weights.weight_price,
      weights.weight_lead_time,
      weights.weight_quality,
      targetTotal(lineRows),
      now,
      existing.id,
      version
    );
    if (!result.changes) return 0;
    await writeAudit(db, 'sourcing_event', existing.id, 'UPDATED', actor.name, `RFQ ${existing.event_number} draft updated`);
    return result.changes;
  })();
  if (!changed) fail('The RFQ changed while it was being saved.', 409, 'event_state_changed');
  return getEvent(db, existing.id);
}

export async function cancelEvent(db, actor, id, input = {}) {
  const existing = await loadEventRow(db, id);
  if (!existing) fail('RFQ was not found.', 404, 'event_not_found');
  assertOwner(actor, existing);
  if (existing.status !== 'draft') {
    fail('Only a draft RFQ can be cancelled in this release.', 409, 'event_state_changed');
  }
  assertTransition(existing.status, 'cancelled');
  const reason = requireText(input.reason, 2000, 'cancel_reason_required', 'A cancel reason is required.');
  const now = utcIso();
  const beforeDeadline = !existing.deadline_at || existing.deadline_at > now ? 1 : 0;
  const changed = await db.immediateTransaction(async () => {
    const result = await db.prepare(`
      UPDATE sourcing_events
      SET status = 'cancelled', cancel_reason = ?, cancelled_at = ?,
          cancelled_before_deadline = ?, row_version = row_version + 1, updated_at = ?
      WHERE id = ? AND status = 'draft'
    `).run(reason, now, beforeDeadline, now, existing.id);
    if (!result.changes) return 0;
    await writeAudit(
      db,
      'sourcing_event',
      existing.id,
      'CANCELLED',
      actor.name,
      `RFQ ${existing.event_number} cancelled: ${reason}`
    );
    await writeCompliance(db, actor, 'SOURCING_EVENT_CANCELLED', 'sourcing_event', existing.id, {
      reason,
      before_deadline: beforeDeadline === 1
    });
    return result.changes;
  })();
  if (!changed) fail('The RFQ changed while it was being saved.', 409, 'event_state_changed');
  return getEvent(db, existing.id);
}

export async function listEvents(db, query = {}) {
  const params = [];
  let sql = `
    SELECT
      e.id, e.event_number, e.title, e.status, e.deadline_at, e.owner_user_id,
      e.department_id, e.source_requisition_id, e.currency, e.updated_at,
      u.name AS owner_name,
      (SELECT COUNT(*) FROM sourcing_invitations i WHERE i.event_id = e.id) AS invitation_count,
      (SELECT COUNT(*) FROM sourcing_bids b WHERE b.event_id = e.id AND b.status = 'submitted') AS submitted_count
    FROM sourcing_events e
    JOIN users u ON u.id = e.owner_user_id
    WHERE 1 = 1
  `;
  if (query.status && query.status !== 'all') {
    if (!['draft', 'published', 'closed', 'evaluated', 'awarded', 'cancelled'].includes(query.status)) {
      fail('Unknown RFQ status filter.', 400, 'invalid_transition');
    }
    sql += ` AND e.status = ?`;
    params.push(query.status);
  }
  if (query.source_requisition_id != null && query.source_requisition_id !== '') {
    const sourceId = Number(query.source_requisition_id);
    if (!Number.isInteger(sourceId) || sourceId <= 0) fail('Requisition was not found.', 400, 'requisition_not_found');
    sql += ` AND e.source_requisition_id = ? AND e.status != 'cancelled'`;
    params.push(sourceId);
  }
  sql += ` ORDER BY e.id DESC`;
  return db.prepare(sql).all(...params);
}

const FILE_META_SQL = `
  SELECT id, event_id, filename, content_type, size_bytes, sha256, uploaded_by_user_id, removed_at, created_at
  FROM sourcing_files
  WHERE event_id = ? AND owner_kind = 'event'
  ORDER BY id ASC
`;

export async function getEvent(db, id) {
  const event = await db.prepare(`
    SELECT
      e.id, e.event_number, e.kind, e.title, e.description, e.category, e.department_id,
      e.owner_user_id, e.source_requisition_id, e.status, e.currency, e.deadline_at,
      e.qa_enabled, e.qa_deadline_at, e.weight_price, e.weight_lead_time, e.weight_quality,
      e.target_total_cents, e.published_at, e.closed_at, e.evaluated_at, e.awarded_at,
      e.cancelled_at, e.cancel_reason, e.cancelled_before_deadline, e.row_version,
      e.created_at, e.updated_at,
      u.name AS owner_name,
      d.name AS department_name,
      pr.pr_number AS source_pr_number
    FROM sourcing_events e
    JOIN users u ON u.id = e.owner_user_id
    JOIN departments d ON d.id = e.department_id
    LEFT JOIN purchase_requisitions pr ON pr.id = e.source_requisition_id
    WHERE e.id = ?
  `).get(id);
  if (!event) fail('RFQ was not found.', 404, 'event_not_found');

  const lines = await db.prepare(`
    SELECT
      id, line_no, requisition_item_id, catalog_item_id, description, category, quantity,
      unit_of_measure, line_type, service_basis, target_unit_price_cents, notes
    FROM sourcing_event_lines
    WHERE event_id = ?
    ORDER BY line_no ASC
  `).all(event.id);
  const invitations = await db.prepare(`
    SELECT
      i.id, i.supplier_id, i.contact_name, i.contact_email, i.delivery_status, i.created_at,
      s.name AS supplier_name, s.code AS supplier_code, s.status AS supplier_status
    FROM sourcing_invitations i
    JOIN suppliers s ON s.id = i.supplier_id
    WHERE i.event_id = ?
    ORDER BY i.id ASC
  `).all(event.id);
  const evaluators = await db.prepare(`
    SELECT ev.user_id, ev.coi_status, ev.created_at, u.name AS user_name, u.role AS user_role
    FROM sourcing_evaluators ev
    JOIN users u ON u.id = ev.user_id
    WHERE ev.event_id = ?
    ORDER BY ev.id ASC
  `).all(event.id);
  const files = await db.prepare(FILE_META_SQL).all(event.id);
  const history = await db.prepare(`
    SELECT id, action, actor_name, details, created_at
    FROM audit_logs
    WHERE entity_type = 'sourcing_event' AND entity_id = ?
    ORDER BY id ASC
  `).all(event.id);

  return {
    ...event,
    qa_enabled: Number(event.qa_enabled) === 1,
    lines,
    invitations,
    evaluators,
    files: files.filter((file) => !file.removed_at),
    history
  };
}

export async function addEventFile(db, actor, id, { buffer, filename } = {}) {
  const existing = await loadEventRow(db, id);
  if (!existing) fail('RFQ was not found.', 404, 'event_not_found');
  assertOwner(actor, existing);
  assertDraft(existing);
  if (!isPdfBuffer(buffer)) fail('The file is not a PDF.', 400, 'not_a_pdf');
  const safeName = safePdfFilename(filename);
  const now = utcIso();
  const digest = sha256Pdf(buffer);
  const fileId = await db.immediateTransaction(async () => {
    const count = await db.prepare(`
      SELECT COUNT(*) AS n FROM sourcing_files
      WHERE event_id = ? AND owner_kind = 'event' AND removed_at IS NULL
    `).get(existing.id);
    if (Number(count?.n || 0) >= MAX_EVENT_FILES) {
      fail(`An RFQ can have at most ${MAX_EVENT_FILES} files.`, 400, 'too_many_files');
    }
    const result = await db.prepare(`
      INSERT INTO sourcing_files (
        event_id, owner_kind, filename, content_type, size_bytes, sha256, uploaded_by_user_id, created_at
      ) VALUES (?, 'event', ?, 'application/pdf', ?, ?, ?, ?)
    `).run(existing.id, safeName, buffer.length, digest, actor.id, now);
    let createdId = Number(result.lastInsertRowid);
    if (!createdId) {
      const created = await db.prepare(`
        SELECT id FROM sourcing_files WHERE event_id = ? AND sha256 = ? ORDER BY id DESC LIMIT 1
      `).get(existing.id, digest);
      createdId = Number(created?.id || 0);
    }
    if (!createdId) fail('Failed to store the PDF.', 500, 'sourcing_error');
    await db.prepare(`INSERT INTO sourcing_file_blobs (file_id, bytes) VALUES (?, ?)`).run(createdId, buffer);
    await writeAudit(
      db,
      'sourcing_event',
      existing.id,
      'FILE_UPLOADED',
      actor.name,
      `PDF ${safeName} uploaded (${buffer.length} bytes)`
    );
    await writeCompliance(db, actor, 'SOURCING_FILE_UPLOADED', 'sourcing_event', existing.id, {
      file_id: createdId,
      sha256: digest
    });
    return createdId;
  })();
  const file = await db.prepare(`
    SELECT id, event_id, filename, content_type, size_bytes, sha256, uploaded_by_user_id, removed_at, created_at
    FROM sourcing_files WHERE id = ?
  `).get(fileId);
  return file;
}

export async function readEventFile(db, eventId, fileId) {
  const meta = await db.prepare(`
    SELECT id, event_id, filename, content_type, size_bytes, removed_at
    FROM sourcing_files
    WHERE id = ? AND event_id = ? AND owner_kind = 'event'
  `).get(fileId, eventId);
  if (!meta || meta.removed_at) fail('File was not found.', 404, 'file_not_found');
  const blob = await db.prepare(`SELECT bytes FROM sourcing_file_blobs WHERE file_id = ?`).get(meta.id);
  if (!blob?.bytes) fail('File was not found.', 404, 'file_not_found');
  return { ...meta, bytes: blob.bytes };
}

export async function removeEventFile(db, actor, eventId, fileId) {
  const existing = await loadEventRow(db, eventId);
  if (!existing) fail('RFQ was not found.', 404, 'event_not_found');
  assertOwner(actor, existing);
  assertDraft(existing);
  const now = utcIso();
  const changed = await db.immediateTransaction(async () => {
    const result = await db.prepare(`
      UPDATE sourcing_files
      SET removed_at = ?
      WHERE id = ? AND event_id = ? AND owner_kind = 'event' AND removed_at IS NULL
    `).run(now, fileId, existing.id);
    if (!result.changes) return 0;
    // Draft only. bytes is NOT NULL and the blob trigger rejects UPDATE, so the
    // row is deleted. Metadata and the audit line stay. Later statuses never
    // reach this path.
    await db.prepare(`DELETE FROM sourcing_file_blobs WHERE file_id = ?`).run(fileId);
    await writeAudit(db, 'sourcing_event', existing.id, 'FILE_REMOVED', actor.name, `PDF file ${fileId} removed from the draft`);
    return result.changes;
  })();
  if (!changed) fail('File was not found.', 404, 'file_not_found');
  return { id: Number(fileId), removed_at: now };
}

export async function sourcingAccess(db, actor) {
  const canWrite = actor.role === 'procurement' || actor.role === 'admin';
  const closed = await db.prepare(`SELECT COUNT(*) AS n FROM sourcing_events WHERE status = 'closed'`).get();
  const awaitingPo = await db.prepare(`
    SELECT COUNT(*) AS n
    FROM sourcing_events e
    JOIN sourcing_awards a ON a.event_id = e.id AND a.status = 'approved'
    WHERE e.status = 'awarded'
      AND a.award_requisition_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM purchase_orders po WHERE po.requisition_id = a.award_requisition_id
      )
  `).get();
  return {
    enabled: true,
    canSee: true,
    canWrite,
    attention_count: Number(closed?.n || 0) + Number(awaitingPo?.n || 0),
    role: actor.role
  };
}
