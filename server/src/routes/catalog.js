import express from 'express';
import { asCents } from '../money.js';
import { normalizeLineType } from '../lineType.js';
import {
  MasterDataError,
  assertAssignableSupplier,
  isUniqueConstraint,
  loadCatalogItem,
  normalizeCatalogStatus,
  parsePositiveId,
  uniqueConflictMessage
} from '../masterData.js';

const router = express.Router();

function sendError(res, error) {
  const status = error.statusCode || (error instanceof MasterDataError ? error.statusCode : 500);
  if (status >= 500) console.error(error);
  res.status(status).json({ error: error.message });
}

async function loadCatalogDetail(db, id) {
  return db.prepare(`
    SELECT c.*, s.name as preferred_supplier_name, s.payment_terms, s.status as preferred_supplier_status
    FROM catalog_items c
    LEFT JOIN suppliers s ON c.preferred_supplier_id = s.id
    WHERE c.id = ?
  `).get(id);
}

function catalogStatusFilter(req) {
  const includeInactive = req.query.include_inactive === '1'
    || req.query.include_inactive === 'true';
  if (includeInactive) return 'all';
  if (req.query.status == null || req.query.status === '') return 'active';
  return String(req.query.status).trim().toLowerCase();
}

// List catalog items. Default status=active so requisition browse hides inactive.
// Vendors/Catalog admin passes status=all (or include_inactive=1).
router.get('/', async (req, res) => {
  try {
    const db = req.db;
    const { category, search } = req.query;
    const statusFilter = catalogStatusFilter(req);

    let query = `
      SELECT c.*, s.name as preferred_supplier_name, s.payment_terms, s.status as preferred_supplier_status
      FROM catalog_items c
      LEFT JOIN suppliers s ON c.preferred_supplier_id = s.id
      WHERE 1=1
    `;
    const params = [];

    if (statusFilter && statusFilter !== 'all') {
      const normalized = normalizeCatalogStatus(statusFilter);
      query += ` AND COALESCE(c.status, 'active') = ?`;
      params.push(normalized);
    }

    if (category && category !== 'All') {
      query += ` AND c.category = ?`;
      params.push(category);
    }

    if (search) {
      query += ` AND (c.name LIKE ? OR c.description LIKE ? OR c.sku LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    query += ` ORDER BY CASE COALESCE(c.status, 'active') WHEN 'active' THEN 0 ELSE 1 END, c.category ASC, c.name ASC`;
    const items = await db.prepare(query).all(...params);
    res.json(items);
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const db = req.db;
    const id = parsePositiveId(req.params.id);
    const item = await loadCatalogDetail(db, id);
    if (!item) {
      throw new MasterDataError('Catalog item not found', 404);
    }
    res.json(item);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/', async (req, res) => {
  try {
    const db = req.db;
    const {
      sku, name, description, category, unit, unit_price,
      preferred_supplier_id, lead_time_days, image_url, line_type, status
    } = req.body;
    if (!sku || !String(sku).trim()) {
      throw new MasterDataError('SKU is required', 400);
    }
    if (!name || !String(name).trim()) {
      throw new MasterDataError('Item name is required', 400);
    }
    if (!category) {
      throw new MasterDataError('Category is required', 400);
    }
    const resolvedType = normalizeLineType(line_type, category);
    const resolvedStatus = normalizeCatalogStatus(status) || 'active';
    const preferred = preferred_supplier_id ? await assertAssignableSupplier(db, preferred_supplier_id) : null;

    const stmt = await db.prepare(`
      INSERT INTO catalog_items (
        sku, name, description, category, unit, unit_price,
        preferred_supplier_id, lead_time_days, image_url, line_type, status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let result;
    try {
      result = await stmt.run(
        String(sku).trim(),
        String(name).trim(),
        description || null,
        category,
        unit || 'each',
        asCents(unit_price),
        preferred?.id || preferred_supplier_id || null,
        lead_time_days || 3,
        image_url || '📦',
        resolvedType,
        resolvedStatus
      );
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new MasterDataError(uniqueConflictMessage(error, 'Catalog SKU already exists'), 409);
      }
      throw error;
    }
    let createdId = Number(result.lastInsertRowid);
    if (!createdId) {
      const lookup = await db.prepare(`SELECT id FROM catalog_items WHERE sku = ?`).get(String(sku).trim());
      createdId = Number(lookup?.id || 0);
    }
    const created = await loadCatalogDetail(db, createdId);
    res.status(201).json(created);
  } catch (error) {
    sendError(res, error);
  }
});

async function applyCatalogPatch(db, id, body) {
  const current = await loadCatalogItem(db, id);
  const nextSku = body.sku !== undefined ? String(body.sku).trim() : current.sku;
  const nextName = body.name !== undefined ? String(body.name).trim() : current.name;
  const nextCategory = body.category !== undefined ? body.category : current.category;
  if (!nextSku) throw new MasterDataError('SKU is required', 400);
  if (!nextName) throw new MasterDataError('Item name is required', 400);
  if (!nextCategory) throw new MasterDataError('Category is required', 400);

  const preferredId = body.preferred_supplier_id !== undefined
    ? body.preferred_supplier_id
    : current.preferred_supplier_id;
  const preferred = preferredId
    ? await assertAssignableSupplier(db, preferredId, {
      existingPreferredId: current.preferred_supplier_id
    })
    : null;

  const next = {
    sku: nextSku,
    name: nextName,
    description: body.description !== undefined ? (body.description || null) : current.description,
    category: nextCategory,
    unit: body.unit !== undefined ? (body.unit || 'each') : current.unit,
    unit_price: body.unit_price !== undefined ? asCents(body.unit_price) : current.unit_price,
    preferred_supplier_id: preferred?.id ?? (preferredId || null),
    lead_time_days: body.lead_time_days !== undefined
      ? Number(body.lead_time_days)
      : current.lead_time_days,
    image_url: body.image_url !== undefined ? (body.image_url || '📦') : current.image_url,
    line_type: body.line_type !== undefined
      ? normalizeLineType(body.line_type, nextCategory)
      : current.line_type,
    status: body.status !== undefined
      ? (normalizeCatalogStatus(body.status) || current.status || 'active')
      : (current.status || 'active')
  };

  try {
    await db.prepare(`
      UPDATE catalog_items
      SET sku = ?, name = ?, description = ?, category = ?, unit = ?, unit_price = ?,
          preferred_supplier_id = ?, lead_time_days = ?, image_url = ?, line_type = ?, status = ?
      WHERE id = ?
    `).run(
      next.sku,
      next.name,
      next.description,
      next.category,
      next.unit,
      next.unit_price,
      next.preferred_supplier_id,
      next.lead_time_days,
      next.image_url,
      next.line_type,
      next.status,
      id
    );
  } catch (error) {
    if (isUniqueConstraint(error)) {
      throw new MasterDataError(uniqueConflictMessage(error, 'Catalog SKU already exists'), 409);
    }
    throw error;
  }

  return loadCatalogDetail(db, id);
}

router.patch('/:id', async (req, res) => {
  try {
    const db = req.db;
    const id = parsePositiveId(req.params.id);
    const updated = await applyCatalogPatch(db, id, req.body || {});
    res.json(updated);
  } catch (error) {
    sendError(res, error);
  }
});

router.patch('/:id/status', async (req, res) => {
  try {
    const db = req.db;
    const id = parsePositiveId(req.params.id);
    const status = normalizeCatalogStatus(req.body?.status);
    if (!status) {
      throw new MasterDataError('status is required', 400);
    }
    const updated = await applyCatalogPatch(db, id, { status });
    res.json(updated);
  } catch (error) {
    sendError(res, error);
  }
});

router.delete('/:id', (_req, res) => {
  res.set('Allow', 'GET, POST, PATCH');
  res.status(405).json({
    error: 'Hard delete is not allowed. Deactivate the catalog item instead (PATCH status=inactive).'
  });
});

export default router;
