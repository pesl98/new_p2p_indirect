/**
 * Formal PO change orders / revisions.
 *
 * Apply-on-confirm: create + apply in one transaction (status `applied`).
 * Amend existing lines only — new catalog lines are out of scope.
 * Money is integer cents. Quantities are whole units.
 *
 * Fail-closed:
 *   - PO must be issued / acknowledged / partially_received / received
 *   - reason + actor_name required
 *   - empty change set (no qty, price, or delivery-notes delta)
 *   - new qty below received (goods), accepted (services), or invoiced
 *   - net increase above CHANGE_ORDER_INCREASE_CONFIRM_CENTS without confirm_increase
 *
 * Budget: when the PO is linked to a PR/department, committed_amount moves by
 * the PO-total delta (increase commits more; decrease releases, floored at 0).
 * actual_spent is never touched.
 */

import { nextDocumentNumber } from './docNumbers.js';
import {
  asCents,
  CHANGE_ORDER_INCREASE_CONFIRM_CENTS,
  formatCents,
  lineTotalCents,
  requireIntegerCents,
  toQty
} from './money.js';
import { isServiceLine } from './lineType.js';
import { refreshPoFulfillmentStatus } from './poFulfillment.js';

export { CHANGE_ORDER_INCREASE_CONFIRM_CENTS };

export const CHANGE_ORDER_AUDIT_ACTION = 'CHANGE_ORDER_APPLIED';

export const AMENDABLE_PO_STATUSES = Object.freeze([
  'issued',
  'acknowledged',
  'partially_received',
  'received'
]);

const FISCAL_YEAR = 2026;

export class ChangeOrderError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ChangeOrderError';
    this.statusCode = statusCode;
  }
}

function isExplicitTrue(value) {
  return value === true || value === 1 || value === 'true' || value === '1';
}

function requireText(value, field) {
  const text = value == null ? '' : String(value).trim();
  if (!text) {
    throw new ChangeOrderError(`${field} is required.`);
  }
  return text;
}

function optionalText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

/** Whole-unit quantity parse. Rejects floats, booleans, and missing values. */
export function requireWholeQty(value, field = 'quantity') {
  const err = (message) => new ChangeOrderError(message);
  if (value === undefined || value === null || value === '') {
    throw err(`${field} is required and must be a whole-unit quantity.`);
  }
  if (typeof value === 'boolean') {
    throw err(`${field} must be a whole-unit quantity.`);
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw err(`${field} must be a whole-unit quantity.`);
    }
    return value;
  }
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) {
    throw err(`${field} must be a whole-unit quantity.`);
  }
  return Number(text);
}

/** Floor a line cannot be reduced below: fulfillment qty and invoiced qty. */
export function lineQtyFloor(item) {
  const fulfilled = isServiceLine(item)
    ? toQty(item.quantity_accepted)
    : toQty(item.quantity_received);
  return Math.max(fulfilled, toQty(item.quantity_invoiced));
}

export function floorLabel(item) {
  const received = toQty(item.quantity_received);
  const accepted = toQty(item.quantity_accepted);
  const invoiced = toQty(item.quantity_invoiced);
  if (isServiceLine(item)) {
    return `accepted ${accepted}, invoiced ${invoiced}`;
  }
  return `received ${received}, invoiced ${invoiced}`;
}

function mappingForItem(lines, itemId) {
  if (!Array.isArray(lines)) return null;
  return lines.find((line) => Number(line?.po_item_id) === Number(itemId)) || null;
}

function poLineTotal(item) {
  return lineTotalCents(item.quantity, item.unit_price);
}

async function loadPurchaseOrder(db, poId) {
  return await db.prepare(`
    SELECT
      po.*,
      s.name as supplier_name,
      s.code as supplier_code,
      s.status as supplier_status,
      pr.pr_number,
      pr.department_id
    FROM purchase_orders po
    JOIN suppliers s ON po.supplier_id = s.id
    LEFT JOIN purchase_requisitions pr ON po.requisition_id = pr.id
    WHERE po.id = ?
  `).get(poId);
}

async function loadChangeOrderItems(db, changeOrderId) {
  return await db.prepare(`
    SELECT
      coi.*,
      pi.item_description,
      pi.line_type,
      pi.category
    FROM po_change_order_items coi
    JOIN po_items pi ON coi.po_item_id = pi.id
    WHERE coi.change_order_id = ?
    ORDER BY coi.id ASC
  `).all(changeOrderId);
}

export async function listPurchaseOrderChangeOrders(db, poId) {
  const po = await loadPurchaseOrder(db, poId);
  if (!po) {
    throw new ChangeOrderError('Purchase Order not found', 404);
  }

  const rows = await db.prepare(`
    SELECT * FROM po_change_orders
    WHERE po_id = ?
    ORDER BY revision ASC, id ASC
  `).all(poId);

  const changeOrders = [];
  for (const row of rows) {
    changeOrders.push({
      ...row,
      items: await loadChangeOrderItems(db, row.id)
    });
  }

  return {
    po_id: po.id,
    po_number: po.po_number,
    revision: toQty(po.revision),
    change_order_count: toQty(po.change_order_count),
    total_amount: asCents(po.total_amount),
    change_orders: changeOrders
  };
}

function resolveLineDelta(item, requested) {
  const oldQuantity = toQty(item.quantity);
  const oldUnitPrice = asCents(item.unit_price);
  const hasQty = requested && requested.quantity !== undefined && requested.quantity !== null && requested.quantity !== '';
  const hasPrice = requested && requested.unit_price !== undefined && requested.unit_price !== null && requested.unit_price !== '';

  let newQuantity = oldQuantity;
  if (hasQty) {
    newQuantity = requireWholeQty(requested.quantity, 'quantity');
    if (newQuantity < 0) {
      throw new ChangeOrderError('quantity cannot be negative.');
    }
  }

  let newUnitPrice = oldUnitPrice;
  if (hasPrice) {
    try {
      newUnitPrice = requireIntegerCents(requested.unit_price, 'unit_price');
    } catch (error) {
      throw new ChangeOrderError(error.message, error.statusCode || 400);
    }
    if (newUnitPrice < 0) {
      throw new ChangeOrderError('unit_price cannot be negative.');
    }
  }

  const floor = lineQtyFloor(item);
  if (newQuantity < floor) {
    throw new ChangeOrderError(
      `Cannot reduce "${item.item_description}" to ${newQuantity}: already ${floorLabel(item)}. ` +
      `Ordered quantity cannot drop below ${floor}.`
    );
  }

  const changed = newQuantity !== oldQuantity || newUnitPrice !== oldUnitPrice;
  return {
    po_item_id: item.id,
    item_description: item.item_description,
    line_type: item.line_type,
    old_quantity: oldQuantity,
    new_quantity: newQuantity,
    old_unit_price: oldUnitPrice,
    new_unit_price: newUnitPrice,
    old_total_cents: lineTotalCents(oldQuantity, oldUnitPrice),
    new_total_cents: lineTotalCents(newQuantity, newUnitPrice),
    notes: optionalText(requested?.notes),
    changed
  };
}

/**
 * Create and apply a change order in one transaction.
 */
export async function applyPurchaseOrderChangeOrder(db, poId, payload = {}) {
  const reason = requireText(payload.reason, 'reason');
  const actorName = requireText(payload.actor_name, 'actor_name');
  const headerNotes = optionalText(payload.notes);
  const deliveryNotes = payload.delivery_notes !== undefined
    ? (payload.delivery_notes == null ? null : String(payload.delivery_notes).trim())
    : undefined;
  const requestedLines = Array.isArray(payload.lines) ? payload.lines : [];

  const po = await loadPurchaseOrder(db, poId);
  if (!po) {
    throw new ChangeOrderError('Purchase Order not found', 404);
  }
  if (!AMENDABLE_PO_STATUSES.includes(po.status)) {
    throw new ChangeOrderError(
      `Purchase order ${po.po_number} is ${po.status} and cannot be amended. ` +
      `Change orders apply to issued, acknowledged, partially received, or received POs.`
    );
  }

  const items = await db.prepare(`
    SELECT * FROM po_items WHERE po_id = ? ORDER BY id ASC
  `).all(poId);
  if (items.length === 0) {
    throw new ChangeOrderError('Purchase order has no line items.');
  }

  const knownIds = new Set(items.map((item) => Number(item.id)));
  for (const line of requestedLines) {
    const lineId = Number(line?.po_item_id);
    if (!Number.isInteger(lineId) || lineId <= 0) {
      throw new ChangeOrderError('Each line requires a valid po_item_id.');
    }
    if (!knownIds.has(lineId)) {
      throw new ChangeOrderError(
        `po_item_id ${lineId} is not a line on purchase order ${po.po_number}. ` +
        `Adding new catalog lines to an existing PO is out of scope.`
      );
    }
  }

  const deltas = [];
  for (const item of items) {
    const requested = mappingForItem(requestedLines, item.id);
    if (!requested) continue;
    const delta = resolveLineDelta(item, requested);
    if (delta.changed || delta.notes) {
      deltas.push(delta);
    }
  }

  const materialLineChanges = deltas.filter((delta) => delta.changed);
  const deliveryChanged = deliveryNotes !== undefined && deliveryNotes !== (po.notes || '');
  if (materialLineChanges.length === 0 && !deliveryChanged) {
    throw new ChangeOrderError(
      'Change set is empty. Provide at least one line quantity or unit_price change, or a delivery_notes update.'
    );
  }

  const beforeTotal = asCents(po.total_amount);
  const afterItems = items.map((item) => {
    const delta = deltas.find((row) => row.po_item_id === item.id && row.changed);
    if (!delta) return item;
    return {
      ...item,
      quantity: delta.new_quantity,
      unit_price: delta.new_unit_price,
      total_price: delta.new_total_cents
    };
  });
  const afterTotal = afterItems.reduce((sum, item) => sum + poLineTotal(item), 0);
  const deltaCents = afterTotal - beforeTotal;

  if (deltaCents > CHANGE_ORDER_INCREASE_CONFIRM_CENTS && !isExplicitTrue(payload.confirm_increase)) {
    throw new ChangeOrderError(
      `Net PO increase of $${formatCents(deltaCents)} exceeds the ` +
      `$${formatCents(CHANGE_ORDER_INCREASE_CONFIRM_CENTS)} confirm threshold ` +
      `(CHANGE_ORDER_INCREASE_CONFIRM_CENTS / APPROVAL_TIER2_CENTS). ` +
      `Resubmit with confirm_increase: true.`
    );
  }

  return db.transaction(async () => {
    const currentYear = new Date().getFullYear();
    const coNumber = await nextDocumentNumber(db, 'co', currentYear);
    const lastRevision = await db.prepare(`
      SELECT COALESCE(MAX(revision), 0) AS max_rev
      FROM po_change_orders
      WHERE po_id = ?
    `).get(poId);
    const revision = Number(lastRevision?.max_rev || 0) + 1;
    const appliedAt = new Date().toISOString();

    const insertCo = await db.prepare(`
      INSERT INTO po_change_orders (
        po_id, co_number, revision, status, reason, actor_name, notes,
        before_total_cents, after_total_cents, applied_at
      ) VALUES (?, ?, ?, 'applied', ?, ?, ?, ?, ?, ?)
    `).run(
      po.id,
      coNumber,
      revision,
      reason,
      actorName,
      headerNotes,
      beforeTotal,
      afterTotal,
      appliedAt
    );
    let changeOrderId = Number(insertCo.lastInsertRowid);
    if (!changeOrderId) {
      const lookup = await db.prepare(`SELECT id FROM po_change_orders WHERE co_number = ?`).get(coNumber);
      changeOrderId = Number(lookup?.id || 0);
    }

    const insertItem = db.prepare(`
      INSERT INTO po_change_order_items (
        change_order_id, po_item_id, old_quantity, new_quantity,
        old_unit_price, new_unit_price, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const delta of deltas) {
      await insertItem.run(
        changeOrderId,
        delta.po_item_id,
        delta.old_quantity,
        delta.new_quantity,
        delta.old_unit_price,
        delta.new_unit_price,
        delta.notes
      );
    }

    const updateLine = db.prepare(`
      UPDATE po_items
      SET quantity = ?, unit_price = ?, total_price = ?
      WHERE id = ?
    `);
    for (const delta of materialLineChanges) {
      await updateLine.run(
        delta.new_quantity,
        delta.new_unit_price,
        delta.new_total_cents,
        delta.po_item_id
      );
    }

    if (deliveryChanged) {
      await db.prepare(`
        UPDATE purchase_orders
        SET total_amount = ?, notes = ?, revision = ?, change_order_count = change_order_count + 1
        WHERE id = ?
      `).run(afterTotal, deliveryNotes || null, revision, po.id);
    } else {
      await db.prepare(`
        UPDATE purchase_orders
        SET total_amount = ?, revision = ?, change_order_count = change_order_count + 1
        WHERE id = ?
      `).run(afterTotal, revision, po.id);
    }

    let budgetDeltaApplied = 0;
    if (po.department_id && deltaCents !== 0) {
      if (deltaCents > 0) {
        await db.prepare(`
          UPDATE budgets
          SET committed_amount = committed_amount + ?
          WHERE department_id = ? AND fiscal_year = ?
        `).run(deltaCents, po.department_id, FISCAL_YEAR);
        budgetDeltaApplied = deltaCents;
      } else {
        await db.prepare(`
          UPDATE budgets
          SET committed_amount = MAX(0, committed_amount - ?)
          WHERE department_id = ? AND fiscal_year = ?
        `).run(Math.abs(deltaCents), po.department_id, FISCAL_YEAR);
        budgetDeltaApplied = deltaCents;
      }
    }

    const lineSummary = materialLineChanges
      .map((delta) => {
        const bits = [];
        if (delta.old_quantity !== delta.new_quantity) {
          bits.push(`qty ${delta.old_quantity}→${delta.new_quantity}`);
        }
        if (delta.old_unit_price !== delta.new_unit_price) {
          bits.push(`unit $${formatCents(delta.old_unit_price)}→$${formatCents(delta.new_unit_price)}`);
        }
        return `${delta.item_description} (${bits.join(', ')})`;
      })
      .join('; ');
    const deliveryNote = deliveryChanged ? ' Delivery notes updated.' : '';
    const budgetNote = po.department_id && deltaCents !== 0
      ? ` Budget committed ${deltaCents > 0 ? 'increased' : 'released'} by $${formatCents(Math.abs(deltaCents))}.`
      : '';
    const details = [
      `${coNumber} (rev ${revision}) applied to ${po.po_number}:`,
      `$${formatCents(beforeTotal)} → $${formatCents(afterTotal)}`,
      `(delta ${deltaCents >= 0 ? '+' : ''}$${formatCents(deltaCents)}).`,
      `Reason: ${reason}.`,
      lineSummary ? `Lines: ${lineSummary}.` : '',
      deliveryNote,
      budgetNote
    ].filter(Boolean).join(' ');

    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('purchase_order', ?, ?, ?, ?)
    `).run(po.id, CHANGE_ORDER_AUDIT_ACTION, actorName, details);

    await refreshPoFulfillmentStatus(db, po.id);

    const updated = await loadPurchaseOrder(db, po.id);
    const itemsAfter = await db.prepare(`
      SELECT * FROM po_items WHERE po_id = ? ORDER BY id ASC
    `).all(po.id);

    return {
      change_order: {
        id: changeOrderId,
        po_id: po.id,
        co_number: coNumber,
        revision,
        status: 'applied',
        reason,
        actor_name: actorName,
        notes: headerNotes,
        before_total_cents: beforeTotal,
        after_total_cents: afterTotal,
        delta_cents: deltaCents,
        applied_at: appliedAt,
        items: deltas
      },
      purchase_order: {
        ...updated,
        items: itemsAfter
      },
      budget_delta_cents: budgetDeltaApplied
    };
  });
}
