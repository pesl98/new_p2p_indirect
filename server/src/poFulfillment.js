import { toQty } from './money.js';
import { isConsignmentLine, isServiceLine } from './lineType.js';

/**
 * Goods: GRN quantity_received.
 * Services: SES quantity_accepted.
 * Consignment draw-down: quantity_consumed (no GRN).
 */
export function lineFulfilledQty(item) {
  if (isServiceLine(item)) return toQty(item.quantity_accepted);
  if (isConsignmentLine(item)) return toQty(item.quantity_consumed);
  return toQty(item.quantity_received);
}

/**
 * Recompute PO status from line fulfillment.
 * Goods lines use GRN qty; service lines use accepted SES qty.
 * Consignment lines use quantity_consumed.
 * Closed / cancelled POs are left unchanged.
 */
export async function refreshPoFulfillmentStatus(db, poId) {
  const po = await db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(poId);
  if (!po || po.status === 'closed' || po.status === 'cancelled') {
    return po?.status || null;
  }

  const items = await db.prepare(`SELECT * FROM po_items WHERE po_id = ?`).all(poId);
  if (items.length === 0) return po.status;

  const isFullyReceived = items.every((item) => lineFulfilledQty(item) >= toQty(item.quantity));
  const isPartiallyReceived = items.some((item) => lineFulfilledQty(item) > 0);
  const newStatus = isFullyReceived ? 'received' : (isPartiallyReceived ? 'partially_received' : po.status);
  await db.prepare(`UPDATE purchase_orders SET status = ? WHERE id = ?`).run(newStatus, poId);
  return newStatus;
}
