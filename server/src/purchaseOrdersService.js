import { nextDocumentNumber } from './docNumbers.js';
import { formatCents, asCents } from './money.js';
import { normalizeLineType } from './lineType.js';

export class PurchaseOrderError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'PurchaseOrderError';
    this.statusCode = statusCode;
  }
}

function toPositiveInt(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

function mappingForItem(mappings, itemId) {
  if (!mappings) return null;
  if (Array.isArray(mappings)) {
    const row = mappings.find((m) => Number(m.requisition_item_id) === Number(itemId));
    return row?.supplier_id;
  }
  return mappings[itemId] ?? mappings[String(itemId)];
}

/**
 * Resolve a PR line's supplier.
 * Order: convert-time mapping → estimated_supplier_id → catalog preferred_supplier_id.
 * Returns null when none are set — callers must fail closed rather than invent a vendor.
 */
export function resolveRequisitionItemSupplier(item, options = {}) {
  const mapped = toPositiveInt(
    options.mappingSupplierId ?? mappingForItem(options.supplier_mappings, item.id)
  );
  if (mapped) return mapped;

  const estimated = toPositiveInt(item.estimated_supplier_id);
  if (estimated) return estimated;

  const catalogPreferred = toPositiveInt(
    options.catalogPreferredId
      ?? item.catalog_preferred_supplier_id
      ?? item.preferred_supplier_id
  );
  if (catalogPreferred) return catalogPreferred;

  return null;
}

export function groupItemsBySupplier(items, options = {}) {
  const groups = new Map();
  const unresolved = [];

  for (const item of items) {
    const supplierId = resolveRequisitionItemSupplier(item, {
      supplier_mappings: options.supplier_mappings,
      catalogPreferredId: item.catalog_preferred_supplier_id
    });
    if (!supplierId) {
      unresolved.push(item);
      continue;
    }
    if (!groups.has(supplierId)) {
      groups.set(supplierId, []);
    }
    groups.get(supplierId).push(item);
  }

  return { groups, unresolved };
}

async function loadRequisitionItems(db, requisitionId) {
  return await db.prepare(`
    SELECT
      ri.*,
      ci.preferred_supplier_id AS catalog_preferred_supplier_id
    FROM requisition_items ri
    LEFT JOIN catalog_items ci ON ri.catalog_item_id = ci.id
    WHERE ri.requisition_id = ?
    ORDER BY ri.id ASC
  `).all(requisitionId);
}

async function loadSupplier(db, supplierId) {
  return await db.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(supplierId);
}

async function actorNameFor(db, createdBy) {
  if (!createdBy) return 'Procurement Officer';
  const user = await db.prepare(`SELECT name FROM users WHERE id = ?`).get(createdBy);
  return user?.name || 'Procurement Officer';
}

/**
 * Convert an approved requisition into one issued PO per resolved supplier.
 * Single-supplier PRs still create exactly one PO. Missing suppliers fail closed (400).
 * PR is marked converted_to_po only after every split PO is written, in one transaction.
 */
export async function convertRequisitionToPurchaseOrders(db, payload) {
  const {
    requisition_id,
    created_by,
    shipping_address,
    notes,
    payment_terms,
    supplier_mappings
  } = payload;

  const pr = await db.prepare(`SELECT * FROM purchase_requisitions WHERE id = ?`).get(requisition_id);
  if (!pr) {
    throw new PurchaseOrderError('Requisition not found', 404);
  }
  if (pr.status !== 'approved') {
    throw new PurchaseOrderError('Requisition must be in "approved" state to generate a Purchase Order.');
  }

  const prItems = await loadRequisitionItems(db, requisition_id);
  if (prItems.length === 0) {
    throw new PurchaseOrderError('Requisition has no items.');
  }

  const { groups, unresolved } = groupItemsBySupplier(prItems, { supplier_mappings });
  if (unresolved.length > 0) {
    const labels = unresolved.map((item) => item.item_description || `line ${item.id}`).join(', ');
    throw new PurchaseOrderError(
      `Cannot convert requisition: ${unresolved.length} line(s) have no resolvable supplier (${labels}). Set estimated_supplier_id, a catalog preferred supplier, or an explicit convert-time mapping.`
    );
  }

  const supplierIds = [...groups.keys()];
  for (const supplierId of supplierIds) {
    if (!(await loadSupplier(db, supplierId))) {
      throw new PurchaseOrderError(`Supplier ${supplierId} was resolved on a line but does not exist.`);
    }
  }

  const createdBy = created_by || 3;
  const actorName = await actorNameFor(db, createdBy);
  const issueDate = new Date().toISOString().split('T')[0];
  const deliveryDate = pr.needed_by_date || new Date(Date.now() + 10 * 86400000).toISOString().split('T')[0];
  const shipTo = shipping_address || 'Acme HQ - Receiving Bay 2, 450 Tech Blvd, Austin, TX 78701';
  const split = supplierIds.length > 1;

  return db.transaction(async () => {
    const currentYear = new Date().getFullYear();
    const created = [];

    const insertPO = db.prepare(`
      INSERT INTO purchase_orders (
        po_number, requisition_id, supplier_id, created_by, status, total_amount,
        issue_date, expected_delivery_date, payment_terms, shipping_address, notes
      )
      VALUES (?, ?, ?, ?, 'issued', ?, ?, ?, ?, ?, ?)
    `);

    const insertPOItem = db.prepare(`
      INSERT INTO po_items (
        po_id, requisition_item_id, item_description, category, quantity,
        unit_price, total_price, quantity_received, quantity_accepted, quantity_invoiced, line_type
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)
    `);

    for (const supplierId of supplierIds) {
      const items = groups.get(supplierId);
      const supplier = await loadSupplier(db, supplierId);
      const poTotal = items.reduce((sum, item) => sum + asCents(item.total_price), 0);
      const poNumber = await nextDocumentNumber(db, 'po', currentYear);
      const defaultNote = split
        ? `Generated from approved requisition ${pr.pr_number} (split ${created.length + 1} of ${supplierIds.length} — ${supplier.name})`
        : `Generated automatically from approved requisition ${pr.pr_number}`;
      const poNotes = notes
        ? (split ? `${notes} [split ${created.length + 1} of ${supplierIds.length} — ${supplier.name}]` : notes)
        : defaultNote;

      const poResult = await insertPO.run(
        poNumber,
        requisition_id,
        supplierId,
        createdBy,
        poTotal,
        issueDate,
        deliveryDate,
        payment_terms || supplier.payment_terms || 'Net 30',
        shipTo,
        poNotes
      );

      const poId = Number(poResult.lastInsertRowid);

      for (const item of items) {
        await insertPOItem.run(
          poId,
          item.id,
          item.item_description,
          item.category,
          item.quantity,
          item.unit_price,
          item.total_price,
          normalizeLineType(item.line_type, item.category)
        );
      }

      await db.prepare(`
        INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
        VALUES ('purchase_order', ?, 'ISSUED', ?, ?)
      `).run(
        poId,
        actorName,
        `PO ${poNumber} issued from PR ${pr.pr_number} to ${supplier.name}`
      );

      created.push({
        poId,
        poNumber,
        supplier_id: supplierId,
        supplier_name: supplier.name,
        supplier_code: supplier.code,
        total_amount: poTotal,
        item_count: items.length
      });
    }

    await db.prepare(`
      UPDATE purchase_requisitions
      SET status = 'converted_to_po', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(requisition_id);

    const poSummary = created
      .map((po) => `${po.poNumber} (${po.supplier_name}, ${formatCents(po.total_amount)})`)
      .join('; ');
    const convertAction = split ? 'SPLIT_CONVERTED_TO_PO' : 'CONVERTED_TO_PO';
    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('requisition', ?, ?, ?, ?)
    `).run(
      requisition_id,
      convertAction,
      actorName,
      split
        ? `Split converted to ${created.length} purchase orders: ${poSummary}`
        : `Converted to Purchase Order ${created[0].poNumber}`
    );

    return created;
  });
}
