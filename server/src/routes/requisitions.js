import express from 'express';
import { insertApprovalChain } from '../approvalPolicy.js';
import { asCents, formatCents, lineTotalCents, toQty } from '../money.js';
import { nextDocumentNumber } from '../docNumbers.js';
import { normalizeLineType } from '../lineType.js';
import { annotateResolvedSuppliers } from '../purchaseOrdersService.js';

const router = express.Router();

// List all purchase requisitions
router.get('/', async (req, res) => {
  try {
    const db = req.db;
    const { status, department_id, requester_id } = req.query;
    let query = `
      SELECT 
        pr.*,
        u.name as requester_name,
        u.email as requester_email,
        d.name as department_name,
        d.code as department_code,
        (SELECT COUNT(*) FROM requisition_items WHERE requisition_id = pr.id) as item_count,
        (SELECT COUNT(*) FROM approval_requests WHERE requisition_id = pr.id AND status = 'pending') as pending_approvals_count
      FROM purchase_requisitions pr
      JOIN users u ON pr.requester_id = u.id
      JOIN departments d ON pr.department_id = d.id
      WHERE 1=1
    `;
    const params = [];

    if (status && status !== 'all') {
      query += ` AND pr.status = ?`;
      params.push(status);
    }
    if (department_id) {
      query += ` AND pr.department_id = ?`;
      params.push(department_id);
    }
    if (requester_id) {
      query += ` AND pr.requester_id = ?`;
      params.push(requester_id);
    }

    query += ` ORDER BY pr.id DESC`;
    const prs = await db.prepare(query).all(...params);
    res.json(prs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get PR details with items and approval requests
router.get('/:id', async (req, res) => {
  try {
    const db = req.db;
    const { id } = req.params;
    const pr = await db.prepare(`
      SELECT 
        pr.*,
        u.name as requester_name,
        u.email as requester_email,
        u.title as requester_title,
        d.name as department_name,
        d.code as department_code
      FROM purchase_requisitions pr
      JOIN users u ON pr.requester_id = u.id
      JOIN departments d ON pr.department_id = d.id
      WHERE pr.id = ?
    `).get(id);

    if (!pr) {
      return res.status(404).json({ error: 'Requisition not found' });
    }

    const items = await db.prepare(`
      SELECT
        ri.*,
        s.name as estimated_supplier_name,
        ci.sku as catalog_sku,
        ci.preferred_supplier_id as catalog_preferred_supplier_id,
        ps.name as catalog_preferred_supplier_name
      FROM requisition_items ri
      LEFT JOIN suppliers s ON ri.estimated_supplier_id = s.id
      LEFT JOIN catalog_items ci ON ri.catalog_item_id = ci.id
      LEFT JOIN suppliers ps ON ci.preferred_supplier_id = ps.id
      WHERE ri.requisition_id = ?
    `).all(id);

    const approvals = await db.prepare(`
      SELECT ar.*, u.name as approver_name, u.role as approver_role, u.title as approver_title
      FROM approval_requests ar
      JOIN users u ON ar.approver_id = u.id
      WHERE ar.requisition_id = ?
      ORDER BY ar.step_order ASC
    `).all(id);

    const logs = await db.prepare(`
      SELECT * FROM audit_logs
      WHERE entity_type = 'requisition' AND entity_id = ?
      ORDER BY created_at DESC
    `).all(id);

    const purchaseOrders = await db.prepare(`
      SELECT
        po.id, po.po_number, po.status, po.total_amount, po.supplier_id, po.created_at,
        s.name as supplier_name, s.code as supplier_code
      FROM purchase_orders po
      JOIN suppliers s ON po.supplier_id = s.id
      WHERE po.requisition_id = ?
      ORDER BY po.id ASC
    `).all(id);

    res.json({
      ...pr,
      items: annotateResolvedSuppliers(items),
      approvals,
      logs,
      purchase_orders: purchaseOrders,
      purchase_order: purchaseOrders[0] || null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function httpErrorStatus(error) {
  return error.statusCode || 500;
}

// Create new purchase requisition
router.post('/', async (req, res) => {
  try {
    const db = req.db;
    const { requester_id, department_id, justification, needed_by_date, priority, items, submitImmediately } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'Requisition must have at least one line item.' });
    }

    const calculatedTotal = items.reduce(
      (acc, item) => acc + lineTotalCents(item.quantity, item.unit_price),
      0
    );

    const newPrId = await db.transaction(async () => {
      const currentYear = new Date().getFullYear();
      const prNumber = await nextDocumentNumber(db, 'pr', currentYear);

      const status = submitImmediately ? 'pending_approval' : 'draft';

      const insertPR = db.prepare(`
        INSERT INTO purchase_requisitions (pr_number, requester_id, department_id, status, total_amount, justification, needed_by_date, priority)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const prResult = await insertPR.run(
        prNumber,
        requester_id || 1,
        department_id || 1,
        status,
        calculatedTotal,
        justification || 'General operational procurement requirement',
        needed_by_date || new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0],
        priority || 'Medium'
      );

      // Turso /v2/pipeline may omit last_insert_rowid; the row is still visible
      // in this transaction. Never persist child lines against id 0.
      let prId = Number(prResult.lastInsertRowid);
      if (!prId) {
        const created = await db.prepare(
          `SELECT id FROM purchase_requisitions WHERE pr_number = ?`
        ).get(prNumber);
        prId = Number(created?.id || 0);
      }
      if (!prId) {
        const err = new Error('Failed to allocate requisition id after insert');
        err.statusCode = 500;
        throw err;
      }

      // Insert line items
      const insertItem = db.prepare(`
        INSERT INTO requisition_items (requisition_id, catalog_item_id, item_description, category, quantity, unit_price, total_price, estimated_supplier_id, line_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const item of items) {
        const qty = toQty(item.quantity);
        const unitPrice = asCents(item.unit_price);
        const category = item.category || 'Office Supplies';
        await insertItem.run(
          prId,
          item.catalog_item_id || null,
          item.item_description,
          category,
          qty,
          unitPrice,
          lineTotalCents(qty, unitPrice),
          item.estimated_supplier_id || 1,
          normalizeLineType(item.line_type, category)
        );
      }

      // Log creation
      await db.prepare(`
        INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
        VALUES ('requisition', ?, 'CREATED', 'System', ?)
      `).run(prId, `Requisition ${prNumber} created with ${items.length} item(s) for $${formatCents(calculatedTotal)}`);

      if (submitImmediately) {
        await insertApprovalChain(db, prId, calculatedTotal, department_id || 1);
        await db.prepare(`
          INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
          VALUES ('requisition', ?, 'SUBMITTED', 'System', 'Submitted for multi-tier approval routing')
        `).run(prId);
      }

      return prId;
    });
    res.status(201).json({ id: newPrId, message: 'Requisition created successfully' });
  } catch (error) {
    console.error('Error creating requisition:', error);
    res.status(httpErrorStatus(error)).json({ error: error.message });
  }
});

// Submit a draft requisition for approval
router.post('/:id/submit', async (req, res) => {
  try {
    const db = req.db;
    const { id } = req.params;
    const pr = await db.prepare(`SELECT * FROM purchase_requisitions WHERE id = ?`).get(id);
    if (!pr) return res.status(404).json({ error: 'Requisition not found' });
    if (pr.status !== 'draft') return res.status(400).json({ error: 'Only draft requisitions can be submitted' });

    await db.transaction(async () => {
      await db.prepare(`UPDATE purchase_requisitions SET status = 'pending_approval', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
      await insertApprovalChain(db, id, pr.total_amount, pr.department_id);
      await db.prepare(`
        INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
        VALUES ('requisition', ?, 'SUBMITTED', 'Requester', 'Submitted for approval routing')
      `).run(id);
    });

    res.json({ message: 'Requisition submitted for approval' });
  } catch (error) {
    res.status(httpErrorStatus(error)).json({ error: error.message });
  }
});

export default router;
