import { toQty } from './money.js';
import { nextDocumentNumber } from './docNumbers.js';

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
export function createGoodsReceipt(db, payload) {
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

  const po = db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(po_id);
  if (!po) {
    throw new GoodsReceiptError('Purchase Order not found', 404);
  }

  const allowOver = isExplicitTrue(allow_over_receipt);

  const createGRTransaction = db.transaction(() => {
    const overages = [];

    for (const item of items) {
      const qty = toQty(item.quantity_received);
      if (qty <= 0) continue;

      const poItem = db.prepare(
        `SELECT * FROM po_items WHERE id = ? AND po_id = ?`
      ).get(item.po_item_id, po_id);
      if (!poItem) {
        throw new GoodsReceiptError(
          `PO line ${item.po_item_id} was not found on this purchase order.`
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
    const grnNumber = nextDocumentNumber(db, 'grn', currentYear);

    const insertGR = db.prepare(`
      INSERT INTO goods_receipts (grn_number, po_id, received_by, receipt_date, carrier_tracking, delivery_note_number, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const grResult = insertGR.run(
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
        insertGRItem.run(grId, item.po_item_id, qty, item.condition || 'good', item.comments || null);
        updatePOItem.run(qty, item.po_item_id);
        totalReceivedInThisGRN += qty;
      }
    }

    const allPOItems = db.prepare(`SELECT quantity, quantity_received FROM po_items WHERE po_id = ?`).all(po_id);
    const isFullyReceived = allPOItems.every((i) => i.quantity_received >= i.quantity);
    const isPartiallyReceived = allPOItems.some((i) => i.quantity_received > 0);

    const newPOStatus = isFullyReceived ? 'received' : (isPartiallyReceived ? 'partially_received' : po.status);
    db.prepare(`UPDATE purchase_orders SET status = ? WHERE id = ?`).run(newPOStatus, po_id);

    const actor = actor_name || 'Procurement Officer';
    db.prepare(`
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
      db.prepare(`
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

  return createGRTransaction();
}
