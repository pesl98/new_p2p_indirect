/**
 * Payable opened by a measured consumption event.
 *
 * Parallel to a discrete consignment issue: one PO line, quantity_consumed set,
 * quantity_received left at 0, no goods receipt. Discrete consignment keeps
 * order_source = 'consignment' and whole-unit quantity. These payables stay
 * order_source = 'standard' (that CHECK is only standard | consignment) and
 * are identified by settlement_kind plus quantity_scale = 1000.
 */

import { nextDocumentNumber } from './docNumbers.js';
import { refreshPoFulfillmentStatus } from './poFulfillment.js';
import { MEASURED_SCALE, MeasuredFlowError } from './measuredQty.js';

export function requireUserId(value, field) {
  if (typeof value === 'boolean' || value === undefined || value === null || value === '') {
    throw new MeasuredFlowError(`${field} is required.`);
  }
  const id = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(id) || id <= 0) {
    throw new MeasuredFlowError(`${field} is required.`);
  }
  return id;
}

export function optionalNotes(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

export function todayIso() {
  return new Date().toISOString().split('T')[0];
}

export function requireIsoDate(value, field) {
  const text = value == null || value === '' ? '' : String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new MeasuredFlowError(`${field} must be YYYY-MM-DD.`);
  }
  return text;
}

export function requireText(value, field, max = 120) {
  const text = value == null ? '' : String(value).trim();
  if (!text) throw new MeasuredFlowError(`${field} is required.`);
  if (text.length > max) {
    throw new MeasuredFlowError(`${field} must be ${max} characters or fewer.`);
  }
  return text;
}

export async function loadUser(db, userId, field) {
  const user = await db.prepare(`SELECT id, name, status FROM users WHERE id = ?`).get(userId);
  if (!user) throw new MeasuredFlowError(`${field} user was not found.`, 404);
  return user;
}

export async function loadActiveSupplier(db, supplierId) {
  const id = requireUserId(supplierId, 'supplier_id');
  const supplier = await db.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(id);
  if (!supplier) throw new MeasuredFlowError('Supplier not found.', 404);
  if (supplier.status !== 'active') {
    throw new MeasuredFlowError(`Supplier ${supplier.name} is not active.`);
  }
  return supplier;
}

/**
 * Insert the draw-down style PO. Caller owns the transaction.
 * Quantity columns are milli-units. receipt_basis stays `grn` because that
 * CHECK is only grn | consignment; match ignores it when settlement_kind is set.
 */
export async function insertMeasuredPayable(db, {
  settlementKind,
  supplier,
  user,
  issueDate,
  locationLabel,
  notes,
  description,
  category = 'Facilities & MRO',
  quantityMilli,
  unitPrice,
  unitOfMeasure,
  amountCents,
  actor,
  poAuditDetail
}) {
  const year = Number(String(issueDate).slice(0, 4)) || new Date().getFullYear();
  const poNumber = await nextDocumentNumber(db, 'po', year);
  const poNotes = [notes, 'No goods receipt was posted.'].filter(Boolean).join(' ');

  const po = await db.prepare(`
    INSERT INTO purchase_orders (
      po_number, requisition_id, supplier_id, created_by, status, total_amount,
      issue_date, expected_delivery_date, payment_terms, shipping_address, notes,
      order_source, settlement_kind
    ) VALUES (?, NULL, ?, ?, 'issued', ?, ?, ?, ?, ?, ?, 'standard', ?)
  `).run(
    poNumber,
    supplier.id,
    user.id,
    amountCents,
    issueDate,
    issueDate,
    supplier.payment_terms || 'Net 30',
    locationLabel,
    poNotes,
    settlementKind
  );

  const poItem = await db.prepare(`
    INSERT INTO po_items (
      po_id, requisition_item_id, item_description, category, quantity, unit_price, total_price,
      quantity_received, quantity_accepted, quantity_consumed, quantity_invoiced,
      line_type, receipt_basis, quantity_scale, unit_of_measure, settlement_kind
    ) VALUES (?, NULL, ?, ?, ?, ?, ?, 0, 0, ?, 0, 'goods', 'grn', ?, ?, ?)
  `).run(
    po.lastInsertRowid,
    description,
    category,
    quantityMilli,
    unitPrice,
    amountCents,
    quantityMilli,
    MEASURED_SCALE,
    unitOfMeasure,
    settlementKind
  );

  const poStatus = await refreshPoFulfillmentStatus(db, po.lastInsertRowid);
  const detail = typeof poAuditDetail === 'function' ? poAuditDetail(poNumber) : poAuditDetail;
  await db.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
    VALUES ('purchase_order', ?, 'ISSUED', ?, ?)
  `).run(po.lastInsertRowid, actor, detail);

  return {
    poId: po.lastInsertRowid,
    poItemId: poItem.lastInsertRowid,
    poNumber,
    poStatus,
    amountCents
  };
}
