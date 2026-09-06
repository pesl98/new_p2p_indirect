import { toQty } from './money.js';
import { nextDocumentNumber } from './docNumbers.js';
import { isServiceLine } from './lineType.js';
import { refreshPoFulfillmentStatus } from './poFulfillment.js';

export class GoodsReceiptError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'GoodsReceiptError';
    this.statusCode = statusCode;
  }
}

function isExplicitTrue(value) {
  return value === true || value === 1 || value === 'true' || value === '1';
}

/**
 * Record a goods receipt against a PO.
 * Cumulative received qty may not exceed ordered qty unless `allow_over_receipt` is true.
 * Over-receipt is an audited exception path, not the default.
 */
export async function createGoodsReceipt(db, payload) {
  const {
    po_id,
    received_by,
    receipt_date,
    carrier_tracking,
    delivery_note_number,
    notes,
    items,
    allow_over_receipt,
    actor_name
  } = payload;

  if (!items || items.length === 0) {
    throw new GoodsReceiptError('Receipt must include at least one received item.');
  }

  const po = await db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(po_id);
  if (!po) {
    throw new GoodsReceiptError('Purchase Order not found', 404);
  }

  const allowOver = isExplicitTrue(allow_over_receipt);

  return db.transaction(async () => {
    const overages = [];

    for (const item of items) {
      const qty = toQty(item.quantity_received);
      if (qty <= 0) continue;

      const poItem = await db.prepare(
        `SELECT * FROM po_items WHERE id = ? AND po_id = ?`
      ).get(item.po_item_id, po_id);
      if (!poItem) {
        throw new GoodsReceiptError(
          `PO line ${item.po_item_id} was not found on this purchase order.`
        );
      }
      if (isServiceLine(poItem)) {
        throw new GoodsReceiptError(
          `PO line ${poItem.id} (${poItem.item_description}) is a service line. Accept it on a Service Entry Sheet, not a GRN.`
        );
      }

      const ordered = toQty(poItem.quantity);
      const already = toQty(poItem.quantity_received);
      const cumulative = already + qty;
      if (cumulative > ordered) {
        overages.push({
          po_item_id: poItem.id,
          description: poItem.item_description,
          ordered,
          already,
          receiving: qty,
          cumulative
        });
      }
    }

    if (overages.length > 0 && !allowOver) {
      const detail = overages
        .map((o) => `${o.description || `line ${o.po_item_id}`}: ${o.cumulative} received vs ${o.ordered} ordered`)
        .join('; ');
      throw new GoodsReceiptError(
        `Over-receipt is not allowed without allow_over_receipt: true. ${detail}`
      );
    }

    const currentYear = new Date().getFullYear();
    const grnNumber = await nextDocumentNumber(db, 'grn', currentYear);

    const insertGR = db.prepare(`
      INSERT INTO goods_receipts (grn_number, po_id, received_by, receipt_date, carrier_tracking, delivery_note_number, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const grResult = await insertGR.run(
      grnNumber,
      po_id,
      received_by || 3,
      receipt_date || new Date().toISOString().split('T')[0],
      carrier_tracking || null,
      delivery_note_number || null,
      notes || null
    );

    const grId = grResult.lastInsertRowid;

    const insertGRItem = db.prepare(`
      INSERT INTO goods_receipt_items (goods_receipt_id, po_item_id, quantity_received, condition, comments)
      VALUES (?, ?, ?, ?, ?)
    `);

    const updatePOItem = db.prepare(`
      UPDATE po_items
      SET quantity_received = quantity_received + ?
      WHERE id = ?
    `);

    let totalReceivedInThisGRN = 0;
    for (const item of items) {
      const qty = toQty(item.quantity_received);
      if (qty > 0) {
        await insertGRItem.run(grId, item.po_item_id, qty, item.condition || 'good', item.comments || null);
        await updatePOItem.run(qty, item.po_item_id);
        totalReceivedInThisGRN += qty;
      }
    }

    const newPOStatus = await refreshPoFulfillmentStatus(db, po_id);

    const actor = actor_name || 'Procurement Officer';
    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('goods_receipt', ?, 'RECEIVED', ?, ?)
    `).run(
      grId,
      actor,
      `Created receipt ${grnNumber} for PO ${po.po_number} (${totalReceivedInThisGRN} units)`
    );

    if (overages.length > 0 && allowOver) {
      const overageDetail = overages
        .map((o) => `${o.description || `line ${o.po_item_id}`}: cumulative ${o.cumulative} vs ordered ${o.ordered}`)
        .join('; ');
      await db.prepare(`
        INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
        VALUES ('goods_receipt', ?, 'OVER_RECEIPT_OVERRIDE', ?, ?)
      `).run(
        grId,
        actor,
        `Explicit over-receipt override on ${grnNumber} for PO ${po.po_number}. ${overageDetail}`
      );
    }

    return { grId, grnNumber, newPOStatus, overReceipt: overages.length > 0 };
  });
}
