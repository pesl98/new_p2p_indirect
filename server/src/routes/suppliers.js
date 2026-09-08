import express from 'express';
import {
  MasterDataError,
  isUniqueConstraint,
  loadSupplier,
  normalizeSupplierStatus,
  parsePositiveId,
  preferredCatalogWarning,
  uniqueConflictMessage
} from '../masterData.js';

const router = express.Router();

function sendError(res, error) {
  const status = error.statusCode || (error instanceof MasterDataError ? error.statusCode : 500);
  if (status >= 500) console.error(error);
  res.status(status).json({ error: error.message });
}

async function loadSupplierDetail(db, id) {
  return db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM purchase_orders WHERE supplier_id = s.id) as total_pos,
      (SELECT COALESCE(SUM(total_amount), 0) FROM purchase_orders WHERE supplier_id = s.id) as total_spend
    FROM suppliers s
    WHERE s.id = ?
  `).get(id);
}

// List suppliers. Default is all (admin / vendors view).
// Pickers pass ?status=active. Inactive / under_review stay visible in admin.
router.get('/', async (req, res) => {
  try {
    const db = req.db;
    const status = req.query.status ? String(req.query.status).trim().toLowerCase() : '';
    let query = `
      SELECT s.*,
        (SELECT COUNT(*) FROM purchase_orders WHERE supplier_id = s.id) as total_pos,
        (SELECT COALESCE(SUM(total_amount), 0) FROM purchase_orders WHERE supplier_id = s.id) as total_spend
      FROM suppliers s
      WHERE 1=1
    `;
    const params = [];

    if (status && status !== 'all') {
      const normalized = normalizeSupplierStatus(status);
      query += ` AND s.status = ?`;
      params.push(normalized);
    }

    query += `
      ORDER BY CASE s.status
        WHEN 'active' THEN 0
        WHEN 'under_review' THEN 1
        ELSE 2
      END, s.name ASC
    `;
    const suppliers = await db.prepare(query).all(...params);
    res.json(suppliers);
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const db = req.db;
    const id = parsePositiveId(req.params.id);
    const supplier = await loadSupplierDetail(db, id);
    if (!supplier) {
      throw new MasterDataError('Supplier not found', 404);
    }
    res.json(supplier);
  } catch (error) {
    sendError(res, error);
  }
});

// Create supplier — code is unique; status defaults to active.
router.post('/', async (req, res) => {
  try {
    const db = req.db;
    const { name, code, contact_person, email, phone, address, payment_terms, status } = req.body;
    if (!name || !String(name).trim()) {
      throw new MasterDataError('Supplier name is required', 400);
    }
    if (!code || !String(code).trim()) {
      throw new MasterDataError('Supplier code is required', 400);
    }
    const resolvedStatus = normalizeSupplierStatus(status) || 'active';
    const stmt = await db.prepare(`
      INSERT INTO suppliers (name, code, contact_person, email, phone, address, payment_terms, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let result;
    try {
      result = await stmt.run(
        String(name).trim(),
        String(code).trim(),
        contact_person || null,
        email || null,
        phone || null,
        address || null,
        payment_terms || 'Net 30',
        resolvedStatus
      );
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new MasterDataError(uniqueConflictMessage(error, 'Supplier code already exists'), 409);
      }
      throw error;
    }
    let createdId = Number(result.lastInsertRowid);
    if (!createdId) {
      const lookup = await db.prepare(`SELECT id FROM suppliers WHERE code = ?`).get(String(code).trim());
      createdId = Number(lookup?.id || 0);
    }
    const created = await loadSupplierDetail(db, createdId);
    res.status(201).json(created);
  } catch (error) {
    sendError(res, error);
  }
});

async function applySupplierPatch(db, id, body) {
  const current = await loadSupplier(db, id);
  if (body.code != null && String(body.code).trim() !== current.code) {
    throw new MasterDataError('Supplier code is immutable', 400);
  }

  const next = {
    name: body.name != null ? String(body.name).trim() : current.name,
    contact_person: body.contact_person !== undefined ? (body.contact_person || null) : current.contact_person,
    email: body.email !== undefined ? (body.email || null) : current.email,
    phone: body.phone !== undefined ? (body.phone || null) : current.phone,
    address: body.address !== undefined ? (body.address || null) : current.address,
    payment_terms: body.payment_terms !== undefined ? (body.payment_terms || 'Net 30') : current.payment_terms,
    status: body.status !== undefined
      ? (normalizeSupplierStatus(body.status) || current.status)
      : current.status
  };

  if (!next.name) {
    throw new MasterDataError('Supplier name is required', 400);
  }

  await db.prepare(`
    UPDATE suppliers
    SET name = ?, contact_person = ?, email = ?, phone = ?, address = ?, payment_terms = ?, status = ?
    WHERE id = ?
  `).run(
    next.name,
    next.contact_person,
    next.email,
    next.phone,
    next.address,
    next.payment_terms,
    next.status,
    id
  );

  const updated = await loadSupplierDetail(db, id);
  const warnings = [];
  if (current.status === 'active' && next.status !== 'active') {
    const warning = await preferredCatalogWarning(db, id);
    if (warning) warnings.push(warning);
  }
  return { ...updated, warnings };
}

// Update fields and/or status. Code is immutable. Soft-deactivate only.
router.patch('/:id', async (req, res) => {
  try {
    const db = req.db;
    const id = parsePositiveId(req.params.id);
    const updated = await applySupplierPatch(db, id, req.body || {});
    res.json(updated);
  } catch (error) {
    sendError(res, error);
  }
});

router.patch('/:id/status', async (req, res) => {
  try {
    const db = req.db;
    const id = parsePositiveId(req.params.id);
    const status = normalizeSupplierStatus(req.body?.status);
    if (!status) {
      throw new MasterDataError('status is required', 400);
    }
    const updated = await applySupplierPatch(db, id, { status });
    res.json(updated);
  } catch (error) {
    sendError(res, error);
  }
});

// Hard delete is not allowed — deactivate instead.
router.delete('/:id', (_req, res) => {
  res.set('Allow', 'GET, POST, PATCH');
  res.status(405).json({
    error: 'Hard delete is not allowed. Deactivate the supplier instead (PATCH status=inactive).'
  });
});

export default router;
