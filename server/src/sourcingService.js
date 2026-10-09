/**
 * Buyer RFQ authoring, publish, and lifecycle.
 * Money is integer cents. Invitations are never copied from a requisition
 * line: estimated_supplier_id defaults to supplier 1 and is not a chosen invitee.
 * Bid prices are not read here. That stays in sourcingBidReadModel.js.
 */

import { createHash } from 'node:crypto';
import { actorFromSession, appendComplianceEvent, appendComplianceEvents, utcTimestamp } from './complianceAudit.js';
import { nextDocumentNumber } from './docNumbers.js';
import { LineTypeError, normalizeLineType, resolveServiceBasis } from './lineType.js';
import { isUniqueConstraint } from './masterData.js';
import { lineTotalCents, requireIntegerCents } from './money.js';
import { loadMailConfig, mailIsConfigured, sendMail } from './mail/index.js';
import {
  MAX_EVENT_FILES,
  MAX_EVENT_FILE_BYTES,
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
import { buyerInvitationActivity, loadBuyerComparison, presentInvitationActivity, readBuyerBidFile } from './sourcingBidReadModel.js';
import { invitationExpiry, mintPortalToken, portalLink, portalTokenSecret } from './sourcingPortalTokens.js';
import { BUYER_UPLOADS_PER_MINUTE, consumeRateWindow } from './sourcingRates.js';
import { assertTransition, publishBlockers } from './sourcingStatus.js';
import { scheduleBackground } from './background.js';
import { enqueueWebhook, kickWebhookDispatch, WEBHOOK_EVENTS } from './webhookOutbox.js';

export class SourcingError extends Error {
  constructor(message, statusCode = 400, code = 'sourcing_error') {
    super(message);
    this.name = 'SourcingError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EVENT_NUMBER_ATTEMPTS = 3;
/** Stay under SQLite's historical 999-variable limit, including Turso. */
const SQL_VARIABLE_BUDGET = 900;

function fail(message, statusCode, code, extra) {
  const error = new SourcingError(message, statusCode, code);
  if (extra?.retryAfterSeconds) error.retryAfterSeconds = extra.retryAfterSeconds;
  throw error;
}

/** Jittered wait between RFQ-number retries. Inclusive range 100–300 ms. */
export function createRetryDelayMs(random = Math.random) {
  const unit = Number(random());
  const fraction = Number.isFinite(unit) ? Math.min(1, Math.max(0, unit)) : 0;
  return 100 + Math.min(200, Math.floor(fraction * 201));
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
  let id;
  if (value == null || value === '') {
    if (actor.department_id == null) fail('department_id is required.', 400, 'department_not_found');
    id = Number(actor.department_id);
  } else {
    id = Number(value);
    if (!Number.isInteger(id) || id <= 0) fail('Department was not found.', 400, 'department_not_found');
    if (actor.role !== 'admin' && id !== Number(actor.department_id)) {
      fail('That department is not available to this buyer.', 403, 'department_not_allowed');
    }
  }
  const row = await db.prepare(`SELECT id FROM departments WHERE id = ?`).get(id);
  if (!row) fail('Department was not found.', 400, 'department_not_found');
  return id;
}

async function departmentForUpdate(db, actor, input, existing) {
  if (!hasOwn(input, 'department_id') || input.department_id == null || input.department_id === '') {
    return existing.department_id;
  }
  const id = Number(input.department_id);
  if (!Number.isInteger(id) || id <= 0) fail('Department was not found.', 400, 'department_not_found');
  if (id === Number(existing.department_id)) return id;
  if (existing.source_requisition_id) {
    fail('The department of an RFQ from a requisition cannot be changed.', 409, 'department_locked');
  }
  return readDepartment(db, actor, id);
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function lineDigest(lines) {
  return digest((lines || []).map((line, index) => ({
    line_no: index + 1,
    description: line.description,
    category: line.category,
    quantity: line.quantity,
    unit_of_measure: line.unit_of_measure,
    line_type: line.line_type,
    service_basis: line.service_basis,
    target_unit_price_cents: line.target_unit_price_cents,
    catalog_item_id: line.catalog_item_id,
    requisition_item_id: line.requisition_item_id
  })));
}

function inviteDigest(invitations) {
  return digest((invitations || []).map((row) => ({
    supplier_id: row.supplier_id,
    supplier_code: row.supplier_code,
    contact_email: row.contact_email
  })));
}

function saveDetails(source, sourceRequisitionId, lines, invitations) {
  return {
    source: source || null,
    source_requisition_id: sourceRequisitionId || null,
    line_count: lines ? lines.length : null,
    lines_sha256: lines ? lineDigest(lines) : null,
    invitation_count: invitations ? invitations.length : null,
    invites_sha256: invitations ? inviteDigest(invitations) : null
  };
}

function isEventNumberConflict(error) {
  return isUniqueConstraint(error) && /event_number/i.test(String(error.message || ''));
}

function isBusyConflict(error) {
  const code = String(error?.code || '');
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT' || code === 'SQLITE_BUSY_TIMEOUT') return true;
  return /SQLITE_BUSY|database is locked/i.test(String(error?.message || ''));
}

/**
 * BEGIN IMMEDIATE can fail at once when another writer holds the lock
 * (busy_timeout is 0). Retry the whole transaction a few times. A
 * SourcingError is the caller's outcome and is not retried.
 */
export async function withBusyRetry(work, random = Math.random) {
  for (let attempt = 1; attempt <= EVENT_NUMBER_ATTEMPTS; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof SourcingError || !isBusyConflict(error) || attempt === EVENT_NUMBER_ATTEMPTS) {
        if (!(error instanceof SourcingError) && isBusyConflict(error)) {
          fail('The database is busy. Try again.', 503, 'busy', { retryAfterSeconds: 1 });
        }
        throw error;
      }
      await wait(createRetryDelayMs(random));
    }
  }
  fail('The database is busy. Try again.', 503, 'busy', { retryAfterSeconds: 1 });
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function insertRows(db, table, columns, rows) {
  if (!rows.length) return;
  const chunkSize = Math.max(1, Math.floor(SQL_VARIABLE_BUDGET / columns.length));
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const tuples = chunk.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
    await db.prepare(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples}`
    ).run(...chunk.flat());
  }
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
  await insertRows(
    db,
    'sourcing_event_lines',
    [
      'event_id', 'line_no', 'requisition_item_id', 'catalog_item_id', 'description', 'category',
      'quantity', 'unit_of_measure', 'line_type', 'service_basis', 'target_unit_price_cents', 'notes'
    ],
    lines.map((line, index) => [
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
    ])
  );
}

async function insertInvitations(db, eventId, actor, invitations, now) {
  await insertRows(
    db,
    'sourcing_invitations',
    ['event_id', 'supplier_id', 'contact_name', 'contact_email', 'delivery_status', 'invited_by_user_id', 'created_at'],
    invitations.map((invitation) => [
      eventId,
      invitation.supplier_id,
      invitation.contact_name,
      invitation.contact_email,
      'pending',
      actor.id,
      now
    ])
  );
}

async function insertEvaluators(db, eventId, actor, userIds, now) {
  await insertRows(
    db,
    'sourcing_evaluators',
    ['event_id', 'user_id', 'added_by_user_id', 'created_at'],
    userIds.map((userId) => [eventId, userId, actor.id, now])
  );
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
    SELECT id, supplier_id, contact_name, contact_email, token_hash
    FROM sourcing_invitations WHERE event_id = ?
  `).all(eventId);
  const keep = new Set(invitations.map((row) => row.supplier_id));
  for (const row of existing) {
    if (row.token_hash && !keep.has(row.supplier_id)) {
      fail('An invitation with a link cannot be removed here.', 409, 'event_state_changed');
    }
  }
  const bySupplier = new Map(existing.map((row) => [row.supplier_id, row]));
  const dropIds = existing
    .filter((row) => !row.token_hash && !keep.has(row.supplier_id))
    .map((row) => row.supplier_id);
  if (dropIds.length) {
    const marks = dropIds.map(() => '?').join(', ');
    await db.prepare(`
      DELETE FROM sourcing_invitations
      WHERE event_id = ? AND token_hash IS NULL AND supplier_id IN (${marks})
    `).run(eventId, ...dropIds);
  }
  const fresh = [];
  const changed = [];
  for (const invitation of invitations) {
    const row = bySupplier.get(invitation.supplier_id);
    if (!row) {
      fresh.push(invitation);
      continue;
    }
    if (row.token_hash) continue;
    const nextName = invitation.contact_name || null;
    const prevName = row.contact_name || null;
    if (prevName !== nextName || row.contact_email !== invitation.contact_email) {
      changed.push(invitation);
    }
  }
  if (changed.length) {
    const nameCase = changed.map(() => 'WHEN ? THEN ?').join(' ');
    const emailCase = changed.map(() => 'WHEN ? THEN ?').join(' ');
    const marks = changed.map(() => '?').join(', ');
    const nameArgs = changed.flatMap((row) => [row.supplier_id, row.contact_name || null]);
    const emailArgs = changed.flatMap((row) => [row.supplier_id, row.contact_email]);
    await db.prepare(`
      UPDATE sourcing_invitations
      SET contact_name = CASE supplier_id ${nameCase} ELSE contact_name END,
          contact_email = CASE supplier_id ${emailCase} ELSE contact_email END
      WHERE event_id = ? AND token_hash IS NULL AND supplier_id IN (${marks})
    `).run(...nameArgs, ...emailArgs, eventId, ...changed.map((row) => row.supplier_id));
  }
  if (fresh.length) await insertInvitations(db, eventId, actor, fresh, now);
}

async function replaceEvaluators(db, eventId, actor, userIds, now) {
  if (!userIds.length) {
    await db.prepare(`DELETE FROM sourcing_evaluators WHERE event_id = ?`).run(eventId);
    return;
  }
  const marks = userIds.map(() => '?').join(', ');
  await db.prepare(`
    DELETE FROM sourcing_evaluators WHERE event_id = ? AND user_id NOT IN (${marks})
  `).run(eventId, ...userIds);
  const existing = await db.prepare(`
    SELECT user_id FROM sourcing_evaluators WHERE event_id = ?
  `).all(eventId);
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

  for (let attempt = 1; attempt <= EVENT_NUMBER_ATTEMPTS; attempt += 1) {
    try {
      return await db.immediateTransaction(async () => {
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
        const counts = `${lines?.length || 0} lines, ${invitations?.length || 0} invitations`;
        await writeAudit(
          db,
          'sourcing_event',
          eventId,
          'CREATED',
          actor.name,
          source === 'requisition'
            ? `RFQ ${eventNumber} created from requisition ${fields.source_requisition_id} (${counts})`
            : `RFQ ${eventNumber} created from scratch (${counts})`
        );
        await writeCompliance(db, actor, 'SOURCING_EVENT_CREATED', 'sourcing_event', eventId, {
          ...saveDetails(source, fields.source_requisition_id, lines || [], invitations || [])
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
      if (isEventNumberConflict(error) || isBusyConflict(error)) {
        if (attempt < EVENT_NUMBER_ATTEMPTS) {
          await wait(createRetryDelayMs());
          continue;
        }
        fail('Could not allocate an RFQ number.', 409, 'event_number_conflict');
      }
      throw error;
    }
  }
  fail('Could not allocate an RFQ number.', 409, 'event_number_conflict');
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

export async function updateEvent(db, actor, id, input, options = {}) {
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
  const departmentId = await departmentForUpdate(db, actor, input, existing);
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
    const counts = `${lines ? lines.length : 'unchanged'} lines, ${invitations ? invitations.length : 'unchanged'} invitations`;
    await writeAudit(
      db,
      'sourcing_event',
      existing.id,
      'UPDATED',
      actor.name,
      `RFQ ${existing.event_number} draft updated (${counts})`
    );
    await writeCompliance(db, actor, 'SOURCING_EVENT_UPDATED', 'sourcing_event', existing.id, {
      ...saveDetails(null, existing.source_requisition_id, lines || null, invitations || null)
    });
    return result.changes;
  })();
  if (!changed) fail('The RFQ changed while it was being saved.', 409, 'event_state_changed');
  const nowDate = options.now instanceof Date ? options.now : new Date();
  return getEvent(db, existing.id, nowDate);
}

export async function cancelEvent(db, actor, id, input = {}, options = {}) {
  const nowDate = options.now instanceof Date ? options.now : new Date();
  await closeDueEvents(db, nowDate, { eventId: id });
  const existing = await loadEventRow(db, id);
  if (!existing) fail('RFQ was not found.', 404, 'event_not_found');
  assertOwner(actor, existing);
  if (!['draft', 'published', 'closed', 'evaluated'].includes(existing.status)) {
    fail('This RFQ cannot be cancelled from its current status.', 409, 'event_state_changed');
  }
  const openAward = await db.prepare(`
    SELECT id FROM sourcing_awards
    WHERE event_id = ? AND status IN ('pending_approval', 'approved')
    LIMIT 1
  `).get(existing.id);
  if (openAward) {
    fail('An RFQ with an open award cannot be cancelled.', 409, 'award_open');
  }
  assertTransition(existing.status, 'cancelled');
  const reason = requireText(input.reason, 2000, 'cancel_reason_required', 'A cancel reason is required.');
  const now = utcIso(nowDate);
  const beforeDeadline = !existing.deadline_at || existing.deadline_at > now ? 1 : 0;
  const fromStatus = existing.status;
  const changed = await db.immediateTransaction(async () => {
    const result = await db.prepare(`
      UPDATE sourcing_events
      SET status = 'cancelled', cancel_reason = ?, cancelled_at = ?,
          cancelled_before_deadline = ?, row_version = row_version + 1, updated_at = ?
      WHERE id = ? AND status = ?
    `).run(reason, now, beforeDeadline, now, existing.id, fromStatus);
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
      before_deadline: beforeDeadline === 1,
      from_status: fromStatus
    });
    if (fromStatus !== 'draft') {
      await enqueueWebhook(db, {
        eventType: WEBHOOK_EVENTS.SOURCING_EVENT_CANCELLED,
        entityType: 'sourcing_event',
        entityId: existing.id,
        data: {
          event_number: existing.event_number,
          status: 'cancelled',
          cancel_reason: reason,
          from_status: fromStatus
        },
        now: nowDate
      });
    }
    return result.changes;
  })();
  if (!changed) fail('The RFQ changed while it was being saved.', 409, 'event_state_changed');
  kickWebhookDispatch(db);
  const view = await getEvent(db, existing.id, nowDate);
  if (fromStatus !== 'draft') {
    const notice = await notifyInvitees(db, existing, {
      subject: `Offerteaanvraag ${existing.event_number} geannuleerd`,
      text: [
        `Offerteaanvraag ${existing.event_number} (${existing.title}) is geannuleerd.`,
        `Reden: ${reason}`,
        'U hoeft geen offerte meer in te dienen. De link toont de geannuleerde status.'
      ].join('\n'),
      tag: 'sourcing_cancelled'
    }, options);
    view.notice = notice;
  }
  return view;
}

async function assertEventVisible(db, actor, event) {
  if (!actor) return;
  if (actor.role === 'procurement' || actor.role === 'admin' || actor.role === 'finance') return;
  const named = await db.prepare(`
    SELECT 1 AS ok FROM sourcing_evaluators WHERE event_id = ? AND user_id = ?
  `).get(event.id, actor.id);
  if (!named) fail('Insufficient role for this action', 403, 'read_only');
}

export async function listEvents(db, query = {}, now = new Date(), actor = null) {
  await closeDueEvents(db, now, { limit: 20 });
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
  if (actor && !['procurement', 'admin', 'finance'].includes(actor.role)) {
    sql += ` AND EXISTS (
      SELECT 1 FROM sourcing_evaluators ev WHERE ev.event_id = e.id AND ev.user_id = ?
    )`;
    params.push(Number(actor.id));
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

export async function getEvent(db, id, now = new Date(), actor = null) {
  await closeDueEvents(db, now, { eventId: id });
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
  await assertEventVisible(db, actor, event);

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
      i.token_prefix, i.token_version, i.expires_at, i.revoked_at, i.declined_at, i.first_opened_at,
      s.name AS supplier_name, s.code AS supplier_code, s.status AS supplier_status
    FROM sourcing_invitations i
    JOIN suppliers s ON s.id = i.supplier_id
    WHERE i.event_id = ?
    ORDER BY i.id ASC
  `).all(event.id);
  const activity = await buyerInvitationActivity(db, event.id);
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
  const awardRow = await db.prepare(`
    SELECT a.id, a.award_type, a.status, a.award_requisition_id, a.total_cents,
           a.is_lowest, a.has_expired_validity, a.reason, a.proposed_at, a.decided_at,
           a.comparison_snapshot_json, pr.pr_number, pr.status AS requisition_status
    FROM sourcing_awards a
    LEFT JOIN purchase_requisitions pr ON pr.id = a.award_requisition_id
    WHERE a.event_id = ?
    ORDER BY a.id DESC
    LIMIT 1
  `).get(event.id);
  let award = null;
  let purchaseOrders = [];
  if (awardRow) {
    let comparisonSnapshot = null;
    try {
      comparisonSnapshot = JSON.parse(awardRow.comparison_snapshot_json);
    } catch {
      comparisonSnapshot = null;
    }
    award = {
      id: Number(awardRow.id),
      award_type: awardRow.award_type,
      status: awardRow.status,
      award_requisition_id: awardRow.award_requisition_id == null ? null : Number(awardRow.award_requisition_id),
      pr_number: awardRow.pr_number || null,
      requisition_status: awardRow.requisition_status || null,
      total_cents: Number(awardRow.total_cents),
      is_lowest: Number(awardRow.is_lowest) === 1,
      has_expired_validity: Number(awardRow.has_expired_validity) === 1,
      reason: awardRow.reason,
      proposed_at: awardRow.proposed_at,
      decided_at: awardRow.decided_at,
      comparison_snapshot: comparisonSnapshot
    };
    if (award.award_requisition_id) {
      purchaseOrders = await db.prepare(`
        SELECT po.id, po.po_number, po.supplier_id, po.status, po.total_amount, s.name AS supplier_name
        FROM purchase_orders po
        JOIN suppliers s ON s.id = po.supplier_id
        WHERE po.requisition_id = ?
        ORDER BY po.id ASC
      `).all(award.award_requisition_id);
    }
  }

  return {
    ...event,
    qa_enabled: Number(event.qa_enabled) === 1,
    lines,
    invitations: invitations.map((row) => ({
      ...row,
      ...presentInvitationActivity(row, activity, now)
    })),
    evaluators,
    files: files.filter((file) => !file.removed_at),
    history,
    award,
    purchase_orders: purchaseOrders,
    warnings: event.deadline_at && Date.parse(event.deadline_at) < (now instanceof Date ? now.getTime() : Date.now())
      ? ['deadline_in_the_past']
      : []
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
  const active = await db.prepare(`
    SELECT COUNT(*) AS n FROM sourcing_files
    WHERE event_id = ? AND owner_kind = 'event' AND removed_at IS NULL
  `).get(existing.id);
  if (Number(active?.n || 0) >= MAX_EVENT_FILES) {
    fail(`An RFQ can have at most ${MAX_EVENT_FILES} files.`, 400, 'too_many_files');
  }
  const usedBytes = await db.prepare(`
    SELECT COALESCE(SUM(size_bytes), 0) AS n FROM sourcing_files
    WHERE event_id = ? AND owner_kind = 'event' AND removed_at IS NULL
  `).get(existing.id);
  if (Number(usedBytes?.n || 0) + buffer.length > MAX_EVENT_FILE_BYTES) {
    fail('The RFQ attachments exceed 40 MB.', 400, 'event_files_too_large');
  }
  const uploadRate = await consumeRateWindow(db, `buyer:${actor.id}:upload`, BUYER_UPLOADS_PER_MINUTE, new Date(now));
  if (uploadRate.limited) {
    fail('Too many uploads. Try again in a minute.', 429, 'rate_limited', { retryAfterSeconds: uploadRate.retryAfterSeconds });
  }
  const digest = sha256Pdf(buffer);
  const fileId = await db.immediateTransaction(async () => {
    const count = await db.prepare(`
      SELECT COUNT(*) AS n FROM sourcing_files
      WHERE event_id = ? AND owner_kind = 'event' AND removed_at IS NULL
    `).get(existing.id);
    if (Number(count?.n || 0) >= MAX_EVENT_FILES) {
      fail(`An RFQ can have at most ${MAX_EVENT_FILES} files.`, 400, 'too_many_files');
    }
    const used = await db.prepare(`
      SELECT COALESCE(SUM(size_bytes), 0) AS n FROM sourcing_files
      WHERE event_id = ? AND owner_kind = 'event' AND removed_at IS NULL
    `).get(existing.id);
    if (Number(used?.n || 0) + buffer.length > MAX_EVENT_FILE_BYTES) {
      fail('The RFQ attachments exceed 40 MB.', 400, 'event_files_too_large');
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

export async function readEventFile(db, eventId, fileId, now = new Date()) {
  await closeDueEvents(db, now, { eventId });
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
        AND EXISTS (
          SELECT 1 FROM sourcing_events e
          WHERE e.id = sourcing_files.event_id AND e.status = 'draft'
        )
    `).run(now, fileId, existing.id);
    if (!result.changes) {
      const current = await db.prepare(`SELECT status FROM sourcing_events WHERE id = ?`).get(existing.id);
      if (!current || current.status !== 'draft') {
        fail('The RFQ is no longer a draft.', 409, 'event_state_changed');
      }
      return 0;
    }
    // Draft only. bytes is NOT NULL and the blob trigger rejects UPDATE, so the
    // row is deleted. Metadata and the audit line stay. The status check is
    // repeated on the DELETE so a publish that won the write lock keeps the blob.
    const removed = await db.prepare(`
      DELETE FROM sourcing_file_blobs
      WHERE file_id = ?
        AND EXISTS (
          SELECT 1 FROM sourcing_events e
          JOIN sourcing_files f ON f.event_id = e.id
          WHERE f.id = ? AND e.status = 'draft'
        )
    `).run(fileId, fileId);
    if (!removed.changes) {
      const current = await db.prepare(`SELECT status FROM sourcing_events WHERE id = ?`).get(existing.id);
      if (!current || current.status !== 'draft') {
        fail('The RFQ is no longer a draft.', 409, 'event_state_changed');
      }
    }
    await writeAudit(db, 'sourcing_event', existing.id, 'FILE_REMOVED', actor.name, `PDF file ${fileId} removed from the draft`);
    await writeCompliance(db, actor, 'SOURCING_FILE_REMOVED', 'sourcing_event', existing.id, {
      file_id: Number(fileId)
    });
    return result.changes;
  })();
  if (!changed) fail('File was not found.', 404, 'file_not_found');
  return { id: Number(fileId), removed_at: now };
}

export async function closeDueEvents(db, now = new Date(), { limit = 20, eventId = null } = {}) {
  const clock = now instanceof Date ? now : new Date(now);
  const instant = utcIso(clock);
  // A named RFQ is closed even when older events fill the batch of 20.
  // A list still closes only the oldest `limit` so one page cannot sweep the table.
  const due = eventId == null
    ? await db.prepare(`
        SELECT id, event_number FROM sourcing_events
        WHERE status = 'published' AND deadline_at <= ?
        ORDER BY deadline_at ASC
        LIMIT ?
      `).all(instant, limit)
    : await db.prepare(`
        SELECT id, event_number FROM sourcing_events
        WHERE id = ? AND status = 'published' AND deadline_at <= ?
      `).all(Number(eventId), instant);
  const closed = [];
  for (const row of due || []) {
    const changed = await db.immediateTransaction(async () => {
      const result = await db.prepare(`
        UPDATE sourcing_events
        SET status = 'closed', closed_at = ?, row_version = row_version + 1, updated_at = ?
        WHERE id = ? AND status = 'published' AND deadline_at <= ?
      `).run(instant, instant, row.id, instant);
      if (!result.changes) return 0;
      await writeAudit(db, 'sourcing_event', row.id, 'CLOSED', 'system', `RFQ ${row.event_number} closed at the deadline`);
      await appendComplianceEvent(db, {
        actor_user_id: null,
        actor_name: 'system',
        actor_role: 'system',
        action: 'SOURCING_EVENT_CLOSED',
        entity_type: 'sourcing_event',
        entity_id: row.id,
        details: JSON.stringify({ deadline_at: instant }),
        created_at: utcTimestamp(clock)
      });
      await enqueueWebhook(db, {
        eventType: WEBHOOK_EVENTS.SOURCING_EVENT_CLOSED,
        entityType: 'sourcing_event',
        entityId: row.id,
        data: { event_number: row.event_number, status: 'closed' },
        now: clock
      });
      return 1;
    })();
    if (changed) closed.push(row.id);
  }
  if (closed.length) kickWebhookDispatch(db);
  return closed;
}

function requireRowVersion(input, existing) {
  if (input.row_version == null || input.row_version === '') {
    fail('row_version is required.', 400, 'row_version_required');
  }
  const version = Number(input.row_version);
  if (!Number.isInteger(version) || version !== Number(existing.row_version)) {
    fail('The RFQ changed while it was being saved.', 409, 'event_state_changed');
  }
  return version;
}

async function applyInvitationTokens(db, eventId, minted, expiresAt) {
  if (!minted.length) return;
  const hashCase = minted.map(() => 'WHEN ? THEN ?').join(' ');
  const prefixCase = minted.map(() => 'WHEN ? THEN ?').join(' ');
  const marks = minted.map(() => '?').join(', ');
  await db.prepare(`
    UPDATE sourcing_invitations
    SET token_hash = CASE id ${hashCase} END,
        token_prefix = CASE id ${prefixCase} END,
        token_version = token_version + 1,
        expires_at = ?,
        revoked_at = NULL,
        delivery_status = 'pending'
    WHERE event_id = ? AND id IN (${marks})
  `).run(
    ...minted.flatMap((row) => [row.id, row.token_hash]),
    ...minted.flatMap((row) => [row.id, row.token_prefix]),
    expiresAt,
    eventId,
    ...minted.map((row) => row.id)
  );
}

async function notifyInvitees(db, event, message, options = {}) {
  const invitations = await db.prepare(`
    SELECT id, contact_email, revoked_at FROM sourcing_invitations
    WHERE event_id = ? AND revoked_at IS NULL
    ORDER BY id ASC
  `).all(event.id);
  const sendAll = async () => {
    const deliveries = await Promise.all(invitations.map(async (invitation) => {
      const result = await sendMail({
        to: invitation.contact_email,
        subject: message.subject,
        text: message.text,
        tag: message.tag
      }, { transport: options.mailTransport, env: options.env, timeoutMs: options.mailTimeoutMs });
      const deliveryStatus = deliveryStatusFor(result);
      await recordDelivery(db, event.id, invitation.id, deliveryStatus);
      return deliveryStatus;
    }));
    const status = deliveries.some((row) => row === 'failed')
      ? 'failed'
      : deliveries.some((row) => row === 'sent')
        ? 'sent'
        : 'copied';
    return {
      text: message.text,
      delivery_status: status,
      invitations: deliveries.length
    };
  };
  if (shouldAwaitMail(options)) return sendAll();
  scheduleBackground(sendAll, options);
  return {
    text: message.text,
    delivery_status: 'pending',
    invitations: invitations.length
  };
}

export async function publishEvent(db, actor, id, input = {}, options = {}) {
  const nowDate = options.now instanceof Date ? options.now : new Date();
  const secret = portalTokenSecret(options.env);
  if (!secret) fail('Portal links are not configured.', 503, 'portal_not_configured');
  const existing = await loadEventRow(db, id);
  if (!existing) fail('RFQ was not found.', 404, 'event_not_found');
  assertOwner(actor, existing);
  const version = requireRowVersion(input, existing);
  const lineCountRow = await db.prepare(`SELECT COUNT(*) AS n FROM sourcing_event_lines WHERE event_id = ?`).get(existing.id);
  const invitations = await db.prepare(`
    SELECT id, supplier_id, contact_email, token_hash FROM sourcing_invitations
    WHERE event_id = ? ORDER BY id ASC
  `).all(existing.id);
  const blockers = publishBlockers(existing, {
    now: nowDate,
    lineCount: Number(lineCountRow?.n || 0),
    invitationCount: invitations.length
  });
  if (blockers.length) {
    const error = new SourcingError('The RFQ cannot be published yet.', 409, blockers[0]);
    error.blockers = blockers;
    throw error;
  }
  assertTransition('draft', 'published');
  const now = utcIso(nowDate);
  const expiresAt = invitationExpiry(existing.deadline_at);
  const minted = invitations.map((row) => {
    const token = mintPortalToken(secret);
    return {
      id: row.id,
      contact_email: row.contact_email,
      ...token,
      portal_url: portalLink(token.token, options.env)
    };
  });
  const target = Number(existing.target_total_cents || 0);
  const fewInvitations = target >= 1_000_000 && invitations.length < 3;
  await db.immediateTransaction(async () => {
    const result = await db.prepare(`
      UPDATE sourcing_events
      SET status = 'published', published_at = ?, row_version = row_version + 1, updated_at = ?
      WHERE id = ? AND status = 'draft' AND row_version = ?
    `).run(now, now, existing.id, version);
    if (!result.changes) fail('The RFQ changed while it was being saved.', 409, 'event_state_changed');
    await applyInvitationTokens(db, existing.id, minted, expiresAt);
    await writeAudit(
      db,
      'sourcing_event',
      existing.id,
      'PUBLISHED',
      actor.name,
      `RFQ ${existing.event_number} published to ${minted.length} suppliers`
    );
    await appendComplianceEvents(db, [
      {
        ...actorFromSession(actor),
        action: 'SOURCING_EVENT_PUBLISHED',
        entity_type: 'sourcing_event',
        entity_id: existing.id,
        details: JSON.stringify({
          invitation_count: minted.length,
          deadline_at: existing.deadline_at
        }),
        created_at: utcTimestamp(nowDate)
      },
      ...minted.map((row) => ({
        ...actorFromSession(actor),
        action: 'SOURCING_INVITATION_SENT',
        entity_type: 'sourcing_invitation',
        entity_id: row.id,
        details: JSON.stringify({
          invitation_id: row.id,
          event_id: existing.id,
          token_prefix: row.token_prefix
        }),
        created_at: utcTimestamp(nowDate)
      }))
    ]);
    await enqueueWebhook(db, {
      eventType: WEBHOOK_EVENTS.SOURCING_EVENT_PUBLISHED,
      entityType: 'sourcing_event',
      entityId: existing.id,
      data: {
        event_number: existing.event_number,
        status: 'published',
        deadline_at: existing.deadline_at,
        invitation_count: minted.length
      },
      now: nowDate
    });
  })();
  kickWebhookDispatch(db);
  // Links are in the response whether or not SMTP finishes. A hung relay
  // must not hold the request, because the plaintext token is not stored.
  // On Vercel the background send is kept alive with waitUntil, and each
  // invitation's delivery status is written as that send finishes.
  const mailWork = () => deliverInvitationMail(db, existing, minted, options);
  if (shouldAwaitMail(options)) await mailWork();
  else scheduleBackground(mailWork, options);
  const view = await getEvent(db, existing.id, nowDate);
  const links = new Map(minted.map((row) => [row.id, row.portal_url]));
  view.invitations = view.invitations.map((row) => (
    links.has(row.id) ? { ...row, portal_url: links.get(row.id) } : row
  ));
  if (fewInvitations) view.warnings = [...(view.warnings || []), 'few_invitations'];
  return view;
}

function shouldAwaitMail(options) {
  if (options.awaitMail === true) return true;
  if (options.awaitMail === false) return false;
  if (typeof options.mailTransport === 'function') return false;
  return !mailIsConfigured(loadMailConfig(options.env));
}

function deliveryStatusFor(result) {
  if (result?.status === 'sent') return 'sent';
  if (result?.status === 'failed') return 'failed';
  return 'copied';
}

async function recordDelivery(db, eventId, invitationId, status) {
  await db.prepare(`
    UPDATE sourcing_invitations
    SET delivery_status = ?
    WHERE id = ? AND event_id = ?
  `).run(status, invitationId, eventId);
}

async function deliverInvitationMail(db, event, minted, options) {
  await Promise.all(minted.map(async (row) => {
    const result = await sendMail({
      to: row.contact_email,
      subject: `Uitnodiging offerteaanvraag ${event.event_number}`,
      text: [
        `U bent uitgenodigd voor offerteaanvraag ${event.event_number}: ${event.title}.`,
        'Open alleen deze link:',
        row.portal_url,
        `Sluitingstijd: ${event.deadline_at}.`,
        'De link is persoonlijk. Stuur hem niet door.'
      ].join('\n'),
      tag: 'sourcing_invitation'
    }, { transport: options.mailTransport, env: options.env, timeoutMs: options.mailTimeoutMs });
    await recordDelivery(db, event.id, row.id, deliveryStatusFor(result));
  }));
}

export async function extendDeadline(db, actor, id, input = {}, options = {}) {
  const nowDate = options.now instanceof Date ? options.now : new Date();
  await closeDueEvents(db, nowDate, { eventId: id });
  const existing = await loadEventRow(db, id);
  if (!existing) fail('RFQ was not found.', 404, 'event_not_found');
  assertOwner(actor, existing);
  const currentDeadline = existing.deadline_at ? Date.parse(existing.deadline_at) : NaN;
  if (!Number.isFinite(currentDeadline) || currentDeadline <= nowDate.getTime()) {
    fail('The deadline has passed.', 409, 'deadline_passed');
  }
  if (existing.status !== 'published') fail('Only a published RFQ can have its deadline extended.', 409, 'event_state_changed');
  const version = requireRowVersion(input, existing);
  const deadline = parseDeadline(input.deadline_at);
  if (deadline == null) fail('The deadline is not a valid date and time.', 400, 'invalid_deadline');
  if (deadline <= existing.deadline_at) {
    fail('The deadline can only be moved later.', 409, 'deadline_not_later');
  }
  if (Date.parse(deadline) < nowDate.getTime() + 60 * 60 * 1000) {
    fail('The deadline must be at least one hour from now.', 409, 'deadline_too_soon');
  }
  const expiresAt = invitationExpiry(deadline);
  const now = utcIso(nowDate);
  const changed = await db.immediateTransaction(async () => {
    const result = await db.prepare(`
      UPDATE sourcing_events
      SET deadline_at = ?, row_version = row_version + 1, updated_at = ?
      WHERE id = ? AND status = 'published' AND row_version = ?
        AND deadline_at > ? AND deadline_at < ?
    `).run(deadline, now, existing.id, version, now, deadline);
    if (!result.changes) return 0;
    await db.prepare(`
      UPDATE sourcing_invitations
      SET expires_at = ?
      WHERE event_id = ? AND revoked_at IS NULL
    `).run(expiresAt, existing.id);
    await writeAudit(db, 'sourcing_event', existing.id, 'DEADLINE_EXTENDED', actor.name, `Deadline moved to ${deadline}`);
    await writeCompliance(db, actor, 'SOURCING_DEADLINE_EXTENDED', 'sourcing_event', existing.id, {
      deadline_at: deadline,
      previous_deadline_at: existing.deadline_at
    });
    return 1;
  })();
  if (!changed) fail('The RFQ changed while it was being saved.', 409, 'event_state_changed');
  const notice = await notifyInvitees(db, existing, {
    subject: `Sluitingstijd gewijzigd voor ${existing.event_number}`,
    text: [
      `De sluitingstijd van offerteaanvraag ${existing.event_number} is verplaatst naar ${deadline}.`,
      'Gebruik de link die u al hebt ontvangen.'
    ].join('\n'),
    tag: 'sourcing_deadline_extended'
  }, options);
  const view = await getEvent(db, existing.id, nowDate);
  view.notice = notice;
  return view;
}

export async function rotateInvitationLink(db, actor, eventId, invitationId, options = {}) {
  const nowDate = options.now instanceof Date ? options.now : new Date();
  await closeDueEvents(db, nowDate, { eventId });
  const secret = portalTokenSecret(options.env);
  if (!secret) fail('Portal links are not configured.', 503, 'portal_not_configured');
  const existing = await loadEventRow(db, eventId);
  if (!existing) fail('RFQ was not found.', 404, 'event_not_found');
  assertOwner(actor, existing);
  if (existing.status === 'draft' || existing.status === 'cancelled') {
    fail('A link can be rotated only while the RFQ is open.', 409, 'event_state_changed');
  }
  const invitation = await db.prepare(`
    SELECT id, contact_email, token_version FROM sourcing_invitations
    WHERE id = ? AND event_id = ?
  `).get(invitationId, existing.id);
  if (!invitation) fail('Invitation was not found.', 404, 'invitation_not_found');
  const token = mintPortalToken(secret);
  const expiresAt = invitationExpiry(existing.deadline_at);
  const now = utcIso(nowDate);
  await db.immediateTransaction(async () => {
    const result = await db.prepare(`
      UPDATE sourcing_invitations
      SET token_hash = ?, token_prefix = ?, token_version = token_version + 1,
          expires_at = ?, revoked_at = NULL, revoked_by_user_id = NULL, revoke_reason = NULL,
          delivery_status = 'pending'
      WHERE id = ? AND event_id = ?
    `).run(token.token_hash, token.token_prefix, expiresAt, invitation.id, existing.id);
    if (!result.changes) fail('Invitation was not found.', 404, 'invitation_not_found');
    await writeAudit(db, 'sourcing_event', existing.id, 'LINK_ROTATED', actor.name, `Invitation ${invitation.id} link rotated`);
    await writeCompliance(db, actor, 'SOURCING_LINK_ROTATED', 'sourcing_invitation', invitation.id, {
      invitation_id: invitation.id,
      token_prefix: token.token_prefix
    });
  })();
  const portalUrl = portalLink(token.token, options.env);
  const sent = await sendMail({
    to: invitation.contact_email,
    subject: `Nieuwe link voor ${existing.event_number}`,
    text: [
      `Er is een nieuwe link voor offerteaanvraag ${existing.event_number}.`,
      'De vorige link werkt niet meer.',
      portalUrl
    ].join('\n'),
    tag: 'sourcing_link_rotated'
  }, { transport: options.mailTransport, env: options.env, timeoutMs: options.mailTimeoutMs });
  const delivery = sent.status === 'sent' ? 'sent' : sent.status === 'failed' ? 'failed' : 'copied';
  await db.prepare(`UPDATE sourcing_invitations SET delivery_status = ? WHERE id = ?`).run(delivery, invitation.id);
  return {
    invitation_id: invitation.id,
    token_prefix: token.token_prefix,
    portal_url: portalUrl,
    delivery_status: delivery,
    expires_at: expiresAt
  };
}

export async function revokeInvitationLink(db, actor, eventId, invitationId, input = {}, options = {}) {
  const nowDate = options.now instanceof Date ? options.now : new Date();
  await closeDueEvents(db, nowDate, { eventId });
  const existing = await loadEventRow(db, eventId);
  if (!existing) fail('RFQ was not found.', 404, 'event_not_found');
  assertOwner(actor, existing);
  const reason = requireText(input.reason, 2000, 'revoke_reason_required', 'A revoke reason is required.');
  const invitation = await db.prepare(`
    SELECT id, revoked_at FROM sourcing_invitations WHERE id = ? AND event_id = ?
  `).get(invitationId, existing.id);
  if (!invitation) fail('Invitation was not found.', 404, 'invitation_not_found');
  if (invitation.revoked_at) fail('The link is already revoked.', 409, 'link_already_revoked');
  const now = utcIso(nowDate);
  await db.immediateTransaction(async () => {
    const result = await db.prepare(`
      UPDATE sourcing_invitations
      SET revoked_at = ?, revoked_by_user_id = ?, revoke_reason = ?
      WHERE id = ? AND event_id = ? AND revoked_at IS NULL
    `).run(now, actor.id, reason, invitation.id, existing.id);
    if (!result.changes) return 0;
    await writeAudit(db, 'sourcing_event', existing.id, 'LINK_REVOKED', actor.name, `Invitation ${invitation.id} link revoked: ${reason}`);
    await writeCompliance(db, actor, 'SOURCING_LINK_REVOKED', 'sourcing_invitation', invitation.id, {
      invitation_id: invitation.id,
      reason
    });
    return 1;
  })();
  return { invitation_id: invitation.id, revoked_at: now };
}

export async function answerQuestion(db, actor, eventId, questionId, input = {}, options = {}) {
  const nowDate = options.now instanceof Date ? options.now : new Date();
  await closeDueEvents(db, nowDate, { eventId });
  const existing = await loadEventRow(db, eventId);
  if (!existing) fail('RFQ was not found.', 404, 'event_not_found');
  assertOwner(actor, existing);
  const answer = requireText(input.answer, 8000, 'answer_required', 'An answer is required.');
  const visibility = input.visibility === 'all' ? 'all' : 'private';
  const now = utcIso(nowDate);
  const changed = await db.prepare(`
    UPDATE sourcing_questions
    SET answer = ?, answered_by_user_id = ?, answered_at = ?, visibility = ?
    WHERE id = ? AND event_id = ? AND answer IS NULL
  `).run(answer, actor.id, now, visibility, questionId, existing.id);
  if (!changed.changes) fail('Question was not found.', 404, 'question_not_found');
  await writeCompliance(db, actor, 'SOURCING_QUESTION_ANSWERED', 'sourcing_event', existing.id, {
    question_id: Number(questionId),
    visibility
  });
  return { id: Number(questionId), answer, visibility, answered_at: now };
}

export async function listQuestions(db, eventId, now = new Date(), actor = null) {
  await closeDueEvents(db, now, { eventId });
  const event = await loadEventRow(db, eventId);
  if (!event) fail('RFQ was not found.', 404, 'event_not_found');
  await assertEventVisible(db, actor, event);
  return db.prepare(`
    SELECT q.id, q.invitation_id, q.question, q.asked_at, q.answer, q.answered_at, q.visibility,
           s.code AS supplier_code
    FROM sourcing_questions q
    LEFT JOIN sourcing_invitations i ON i.id = q.invitation_id
    LEFT JOIN suppliers s ON s.id = i.supplier_id
    WHERE q.event_id = ?
    ORDER BY q.id ASC
  `).all(event.id);
}

export async function buyerComparison(db, actor, id, now = new Date()) {
  await closeDueEvents(db, now, { eventId: id });
  const event = await loadEventRow(db, id);
  if (!event) fail('RFQ was not found.', 404, 'event_not_found');
  await assertEventVisible(db, actor, event);
  return loadBuyerComparison(db, event, actor, now);
}

export async function buyerBidFile(db, actor, eventId, fileId, now = new Date()) {
  await closeDueEvents(db, now, { eventId });
  const event = await loadEventRow(db, eventId);
  if (!event) fail('RFQ was not found.', 404, 'file_not_found');
  await assertEventVisible(db, actor, event);
  return readBuyerBidFile(db, event, actor, fileId, now);
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
