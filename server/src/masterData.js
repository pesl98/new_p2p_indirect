/**
 * Shared helpers for supplier / catalog master-data maintenance.
 * Soft-deactivate only — never CASCADE-delete historical PR/PO/invoice lines.
 */

export const SUPPLIER_STATUSES = ['active', 'inactive', 'under_review'];
export const CATALOG_STATUSES = ['active', 'inactive'];

export class MasterDataError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'MasterDataError';
    this.statusCode = statusCode;
  }
}

export function isUniqueConstraint(error) {
  return error?.code === 'SQLITE_CONSTRAINT_UNIQUE'
    || (error?.code === 'SQLITE_CONSTRAINT' && /UNIQUE/i.test(error.message || ''))
    || /UNIQUE constraint failed/i.test(error.message || '');
}

export function parsePositiveId(value, label = 'id') {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new MasterDataError(`Invalid ${label}`, 400);
  }
  return Math.trunc(n);
}

export function normalizeSupplierStatus(value) {
  if (value == null || value === '') return null;
  const status = String(value).trim().toLowerCase();
  if (!SUPPLIER_STATUSES.includes(status)) {
    throw new MasterDataError(
      `Invalid supplier status "${value}". Must be one of: ${SUPPLIER_STATUSES.join(', ')}.`,
      400
    );
  }
  return status;
}

export function normalizeCatalogStatus(value) {
  if (value == null || value === '') return null;
  const status = String(value).trim().toLowerCase();
  if (!CATALOG_STATUSES.includes(status)) {
    throw new MasterDataError(
      `Invalid catalog status "${value}". Must be one of: ${CATALOG_STATUSES.join(', ')}.`,
      400
    );
  }
  return status;
}

export async function loadSupplier(db, id) {
  const supplier = await db.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(id);
  if (!supplier) {
    throw new MasterDataError('Supplier not found', 404);
  }
  return supplier;
}

export async function loadCatalogItem(db, id) {
  const item = await db.prepare(`SELECT * FROM catalog_items WHERE id = ?`).get(id);
  if (!item) {
    throw new MasterDataError('Catalog item not found', 404);
  }
  return item;
}

/**
 * Inactive / under_review suppliers may stay preferred on existing catalog
 * rows, but cannot be newly assigned (create, or change-to on edit).
 */
export async function assertAssignableSupplier(db, supplierId, options = {}) {
  if (supplierId == null || supplierId === '') return null;
  const id = parsePositiveId(supplierId, 'preferred_supplier_id');
  const supplier = await db.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(id);
  if (!supplier) {
    throw new MasterDataError('Preferred supplier not found', 404);
  }
  const keepingExisting = options.existingPreferredId != null
    && Number(options.existingPreferredId) === id;
  if (supplier.status !== 'active' && !keepingExisting) {
    throw new MasterDataError(
      `Supplier ${supplier.code || id} is ${supplier.status} and cannot be newly assigned as a preferred vendor.`,
      400
    );
  }
  return supplier;
}

export async function assertActiveSupplierForBuyer(db, supplierId, label = 'supplier') {
  if (supplierId == null || supplierId === '') return null;
  const id = parsePositiveId(supplierId, label);
  const supplier = await db.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(id);
  if (!supplier) {
    throw new MasterDataError(`${label} not found`, 404);
  }
  if (supplier.status !== 'active') {
    throw new MasterDataError(
      `Supplier ${supplier.code || id} is ${supplier.status} and cannot be newly chosen. Select an active supplier.`,
      400
    );
  }
  return supplier;
}

export async function assertActiveCatalogItem(db, catalogItemId) {
  if (catalogItemId == null || catalogItemId === '') return null;
  const id = parsePositiveId(catalogItemId, 'catalog_item_id');
  const item = await db.prepare(`SELECT * FROM catalog_items WHERE id = ?`).get(id);
  if (!item) {
    throw new MasterDataError('Catalog item not found', 404);
  }
  if (item.status && item.status !== 'active') {
    throw new MasterDataError(
      `Catalog item ${item.sku || id} is inactive and cannot be added to a new requisition.`,
      400
    );
  }
  return item;
}

export async function preferredCatalogWarning(db, supplierId) {
  const row = await db.prepare(`
    SELECT COUNT(*) AS n
    FROM catalog_items
    WHERE preferred_supplier_id = ?
      AND COALESCE(status, 'active') = 'active'
  `).get(supplierId);
  const count = Number(row?.n || 0);
  if (count === 0) return null;
  return `Supplier remains preferred on ${count} active catalog item(s). Historical PR/PO/invoice lines are unchanged. Inactive suppliers cannot be newly assigned.`;
}

export function uniqueConflictMessage(error, fallback) {
  const msg = error?.message || '';
  if (/suppliers\.code/i.test(msg) || /UNIQUE constraint failed: suppliers\.code/i.test(msg)) {
    return 'Supplier code already exists';
  }
  if (/catalog_items\.sku/i.test(msg) || /UNIQUE constraint failed: catalog_items\.sku/i.test(msg)) {
    return 'Catalog SKU already exists';
  }
  return fallback;
}
