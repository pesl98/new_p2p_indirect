import { lineTotalCents, requireIntegerCents } from './money.js';
import { isServiceLine } from './lineType.js';
import { nextDocumentNumber } from './docNumbers.js';
import { refreshPoFulfillmentStatus } from './poFulfillment.js';

export const DEFAULT_LOCATION_LABEL = 'Buyer site';

export class ConsignmentError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ConsignmentError';
    this.statusCode = statusCode;
  }
}

function requirePositiveQty(value, field) {
  if (value === undefined || value === null || value === '' || typeof value === 'boolean') {
    throw new ConsignmentError(`${field} is required and must be a whole number greater than 0.`);
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) {
      throw new ConsignmentError(`${field} must be a whole number greater than 0.`);
    }
    return value;
  }
  const text = String(value).trim();
  if (!/^[1-9]\d*$/.test(text)) {
    throw new ConsignmentError(`${field} must be a whole number greater than 0.`);
  }
  return Number(text);
}

function requireUserId(value, field) {
  if (typeof value === 'boolean' || value === undefined || value === null || value === '') {
    throw new ConsignmentError(`${field} is required.`);
  }
  const id = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(id) || id <= 0) {
    throw new ConsignmentError(`${field} is required.`);
  }
  return id;
}

function normalizeLocation(value) {
  const text = value == null ? '' : String(value).trim();
  if (!text) return DEFAULT_LOCATION_LABEL;
  if (text.length > 120) {
    throw new ConsignmentError('location_label must be 120 characters or fewer.');
  }
  return text;
}

function optionalNotes(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function todayIso() {
  return new Date().toISOString().split('T')[0];
}

async function loadUser(db, userId, field) {
  const user = await db.prepare(`SELECT id, name, status FROM users WHERE id = ?`).get(userId);
  if (!user) throw new ConsignmentError(`${field} user was not found.`, 404);
  return user;
}

async function loadActiveSupplier(db, supplierId) {
  const id = requireUserId(supplierId, 'supplier_id');
  const supplier = await db.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(id);
  if (!supplier) throw new ConsignmentError('Supplier not found.', 404);
  if (supplier.status !== 'active') {
    throw new ConsignmentError(`Supplier ${supplier.name} is not active.`);
  }
  return supplier;
}

async function loadGoodsCatalogItem(db, catalogItemId) {
  const id = requireUserId(catalogItemId, 'catalog_item_id');
  const item = await db.prepare(`SELECT * FROM catalog_items WHERE id = ?`).get(id);
  if (!item) throw new ConsignmentError('Catalog item not found.', 404);
  if (item.status !== 'active') {
    throw new ConsignmentError(`Catalog item ${item.sku} is not active.`);
  }
  if (isServiceLine(item)) {
    throw new ConsignmentError(
      `${item.name} is a service. Consignment stock is for supplier-owned goods only.`
    );
  }
  return item;
}

/**
 * On-hand consignment, recent movements, and owned GRN receipts side by side.
 * Owned stock is cumulative goods-receipt quantity (company-owned). It is not
 * reduced by consignment issues and consignment on-hand is not included in it.
 */
export async function getConsignmentOverview(db) {
  const balances = await db.prepare(`
    SELECT
      b.*,
      s.name as supplier_name,
      s.code as supplier_code,
      c.sku,
      c.name as item_name,
      c.unit,
      c.category
    FROM consignment_balances b
    JOIN suppliers s ON b.supplier_id = s.id
    JOIN catalog_items c ON b.catalog_item_id = c.id
    ORDER BY s.name, c.name, b.location_label
  `).all();

  const receipts = await db.prepare(`
    SELECT
      r.*,
      s.name as supplier_name,
      s.code as supplier_code,
      c.sku,
      c.name as item_name,
      c.unit,
      u.name as received_by_name
    FROM consignment_receipts r
    JOIN suppliers s ON r.supplier_id = s.id
    JOIN catalog_items c ON r.catalog_item_id = c.id
    JOIN users u ON r.received_by = u.id
    ORDER BY r.id DESC
  `).all();

  const issues = await db.prepare(`
    SELECT
      i.*,
      s.name as supplier_name,
      s.code as supplier_code,
      c.sku,
      c.name as item_name,
      c.unit,
      u.name as issued_by_name,
      po.po_number,
      po.status as po_status
    FROM consignment_issues i
    JOIN suppliers s ON i.supplier_id = s.id
    JOIN catalog_items c ON i.catalog_item_id = c.id
    JOIN users u ON i.issued_by = u.id
    JOIN purchase_orders po ON i.po_id = po.id
    ORDER BY i.id DESC
  `).all();

  const ownedStock = await db.prepare(`
    SELECT
      ri.catalog_item_id as catalog_item_id,
      ci.sku as sku,
      COALESCE(ci.name, poi.item_description) as item_name,
      SUM(gri.quantity_received) as quantity_received
    FROM goods_receipt_items gri
    JOIN goods_receipts gr ON gri.goods_receipt_id = gr.id
    JOIN po_items poi ON gri.po_item_id = poi.id
    JOIN purchase_orders po ON gr.po_id = po.id
    LEFT JOIN requisition_items ri ON poi.requisition_item_id = ri.id
    LEFT JOIN catalog_items ci ON ri.catalog_item_id = ci.id
    WHERE COALESCE(po.order_source, 'standard') != 'consignment'
      AND COALESCE(poi.receipt_basis, 'grn') != 'consignment'
    GROUP BY COALESCE(ci.sku, poi.item_description), COALESCE(ci.name, poi.item_description)
    ORDER BY item_name
  `).all();

  return { balances, receipts, issues, owned_stock: ownedStock };
}

/**
 * Record supplier-owned stock at the buyer site.
 * Increases consignment on-hand only. Does not create a PO, GRN, or invoice.
 */
export async function receiveConsignment(db, payload) {
  const supplier = await loadActiveSupplier(db, payload.supplier_id);
  const item = await loadGoodsCatalogItem(db, payload.catalog_item_id);
  const quantity = requirePositiveQty(payload.quantity, 'quantity');
  const locationLabel = normalizeLocation(payload.location_label);
  const receivedBy = requireUserId(payload.received_by, 'received_by');
  const user = await loadUser(db, receivedBy, 'received_by');
  const notes = optionalNotes(payload.notes);
  const receiptDate = payload.receipt_date
    ? String(payload.receipt_date).trim()
    : todayIso();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receiptDate)) {
    throw new ConsignmentError('receipt_date must be YYYY-MM-DD.');
  }

  let unitPrice;
  if (payload.unit_price === undefined || payload.unit_price === null || payload.unit_price === '') {
    unitPrice = null;
  } else {
    unitPrice = requireIntegerCents(payload.unit_price, 'unit_price');
    if (unitPrice < 0) throw new ConsignmentError('unit_price must be zero or a positive number of cents.');
  }

  return db.transaction(async () => {
    let balance = await db.prepare(`
      SELECT * FROM consignment_balances
      WHERE supplier_id = ? AND catalog_item_id = ? AND location_label = ?
    `).get(supplier.id, item.id, locationLabel);

    const price = unitPrice == null ? (balance ? balance.unit_price : item.unit_price) : unitPrice;

    if (!balance) {
      const inserted = await db.prepare(`
        INSERT INTO consignment_balances (
          supplier_id, catalog_item_id, location_label, quantity_on_hand, unit_price, notes, status
        ) VALUES (?, ?, ?, 0, ?, ?, 'active')
      `).run(supplier.id, item.id, locationLabel, price, notes);
      balance = await db.prepare(`SELECT * FROM consignment_balances WHERE id = ?`).get(inserted.lastInsertRowid);
    } else if (balance.status !== 'active') {
      throw new ConsignmentError(`Consignment balance for ${item.sku} at ${locationLabel} is inactive.`);
    } else if (unitPrice != null && unitPrice !== balance.unit_price) {
      await db.prepare(`
        UPDATE consignment_balances
        SET unit_price = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(unitPrice, balance.id);
      balance.unit_price = unitPrice;
    }

    await db.prepare(`
      UPDATE consignment_balances
      SET quantity_on_hand = quantity_on_hand + ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(quantity, balance.id);

    const year = Number(receiptDate.slice(0, 4)) || new Date().getFullYear();
    const receiptNumber = await nextDocumentNumber(db, 'csn', year);
    const receipt = await db.prepare(`
      INSERT INTO consignment_receipts (
        receipt_number, balance_id, supplier_id, catalog_item_id, location_label,
        quantity, unit_price, received_by, receipt_date, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receiptNumber,
      balance.id,
      supplier.id,
      item.id,
      locationLabel,
      quantity,
      price,
      user.id,
      receiptDate,
      notes
    );

    const actor = optionalNotes(payload.actor_name) || user.name;
    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('consignment_receipt', ?, 'RECEIVED', ?, ?)
    `).run(
      receipt.lastInsertRowid,
      actor,
      `Recorded ${receiptNumber}: ${quantity} ${item.sku} from ${supplier.name} at ${locationLabel}. Supplier-owned; no GRN.`
    );

    const updated = await db.prepare(`SELECT quantity_on_hand, unit_price FROM consignment_balances WHERE id = ?`).get(balance.id);
    return {
      receiptId: receipt.lastInsertRowid,
      receiptNumber,
      balanceId: balance.id,
      quantityOnHand: updated.quantity_on_hand,
      unitPrice: updated.unit_price,
      message: `Consignment receipt ${receiptNumber} recorded. On hand is now ${updated.quantity_on_hand}. This is supplier-owned stock, not a goods receipt.`
    };
  });
}

/**
 * Consume supplier-owned stock into company use.
 * Decrements on-hand and creates a consignment PO (receipt_basis consignment,
 * quantity_consumed set, quantity_received left at 0). Does not post a GRN.
 * AP bills that PO with the existing invoice match.
 */
export async function issueConsignment(db, payload) {
  const quantity = requirePositiveQty(payload.quantity, 'quantity');
  const issuedBy = requireUserId(payload.issued_by, 'issued_by');
  const user = await loadUser(db, issuedBy, 'issued_by');
  const notes = optionalNotes(payload.notes);
  const issueDate = payload.issue_date ? String(payload.issue_date).trim() : todayIso();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) {
    throw new ConsignmentError('issue_date must be YYYY-MM-DD.');
  }

  let balanceId = payload.balance_id;
  if (balanceId === undefined || balanceId === null || balanceId === '') {
    throw new ConsignmentError('balance_id is required.');
  }
  balanceId = requireUserId(balanceId, 'balance_id');

  return db.transaction(async () => {
    const balance = await db.prepare(`
      SELECT b.*, s.name as supplier_name, s.payment_terms, s.status as supplier_status,
             c.sku, c.name as item_name, c.category, c.unit, c.line_type, c.status as item_status
      FROM consignment_balances b
      JOIN suppliers s ON b.supplier_id = s.id
      JOIN catalog_items c ON b.catalog_item_id = c.id
      WHERE b.id = ?
    `).get(balanceId);

    if (!balance) throw new ConsignmentError('Consignment balance not found.', 404);
    if (balance.status !== 'active') {
      throw new ConsignmentError('This consignment balance is inactive.');
    }
    if (balance.supplier_status !== 'active') {
      throw new ConsignmentError(`Supplier ${balance.supplier_name} is not active.`);
    }
    if (balance.quantity_on_hand < quantity) {
      throw new ConsignmentError(
        `Not enough consignment on hand for ${balance.sku} at ${balance.location_label}: ${balance.quantity_on_hand} available, ${quantity} requested.`
      );
    }

    const decremented = await db.prepare(`
      UPDATE consignment_balances
      SET quantity_on_hand = quantity_on_hand - ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND quantity_on_hand >= ?
    `).run(quantity, balance.id, quantity);
    if (!decremented.changes) {
      throw new ConsignmentError(
        `Not enough consignment on hand for ${balance.sku} at ${balance.location_label}.`
      );
    }

    const year = Number(issueDate.slice(0, 4)) || new Date().getFullYear();
    const poNumber = await nextDocumentNumber(db, 'po', year);
    const issueNumber = await nextDocumentNumber(db, 'csi', year);
    const unitPrice = balance.unit_price;
    const amountCents = lineTotalCents(quantity, unitPrice);
    const poNotes = [
      `Consignment draw-down ${issueNumber}. Supplier-owned stock issued into company use.`,
      'No goods receipt was posted.',
      notes
    ].filter(Boolean).join(' ');

    const po = await db.prepare(`
      INSERT INTO purchase_orders (
        po_number, requisition_id, supplier_id, created_by, status, total_amount,
        issue_date, expected_delivery_date, payment_terms, shipping_address, notes, order_source
      ) VALUES (?, NULL, ?, ?, 'issued', ?, ?, ?, ?, ?, ?, 'consignment')
    `).run(
      poNumber,
      balance.supplier_id,
      user.id,
      amountCents,
      issueDate,
      issueDate,
      balance.payment_terms || 'Net 30',
      balance.location_label,
      poNotes
    );

    const poItem = await db.prepare(`
      INSERT INTO po_items (
        po_id, requisition_item_id, item_description, category, quantity, unit_price, total_price,
        quantity_received, quantity_accepted, quantity_consumed, quantity_invoiced,
        line_type, receipt_basis
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, 0, 0, ?, 0, 'goods', 'consignment')
    `).run(
      po.lastInsertRowid,
      balance.item_name,
      balance.category,
      quantity,
      unitPrice,
      amountCents,
      quantity
    );

    const issue = await db.prepare(`
      INSERT INTO consignment_issues (
        issue_number, balance_id, supplier_id, catalog_item_id, location_label,
        quantity, unit_price, amount_cents, po_id, po_item_id, issued_by, issue_date, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      issueNumber,
      balance.id,
      balance.supplier_id,
      balance.catalog_item_id,
      balance.location_label,
      quantity,
      unitPrice,
      amountCents,
      po.lastInsertRowid,
      poItem.lastInsertRowid,
      user.id,
      issueDate,
      notes
    );

    const poStatus = await refreshPoFulfillmentStatus(db, po.lastInsertRowid);
    const actor = optionalNotes(payload.actor_name) || user.name;
    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('consignment_issue', ?, 'ISSUED', ?, ?)
    `).run(
      issue.lastInsertRowid,
      actor,
      `Issued ${issueNumber}: ${quantity} ${balance.sku} from ${balance.location_label} onto ${poNumber}. No GRN.`
    );
    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('purchase_order', ?, 'ISSUED', ?, ?)
    `).run(
      po.lastInsertRowid,
      actor,
      `${poNumber} opened for consignment draw-down ${issueNumber} (${quantity} × ${balance.item_name}).`
    );

    const updated = await db.prepare(`SELECT quantity_on_hand FROM consignment_balances WHERE id = ?`).get(balance.id);
    return {
      issueId: issue.lastInsertRowid,
      issueNumber,
      poId: po.lastInsertRowid,
      poNumber,
      poItemId: poItem.lastInsertRowid,
      poStatus,
      quantityOnHand: updated.quantity_on_hand,
      amountCents,
      unitPrice,
      message: `Issued ${quantity} from consignment (${issueNumber}). Payable ${poNumber} is ready for the supplier invoice. No goods receipt was posted.`
    };
  });
}
