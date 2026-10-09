import express from 'express';
import { insertApprovalChain } from '../approvalPolicy.js';
import { createRequisition } from '../requisitionsService.js';
import { annotateResolvedSuppliers } from '../purchaseOrdersService.js';
import { assertActiveCatalogItem, assertActiveSupplierForBuyer } from '../masterData.js';
import {
  assignContractToRequisition,
  nestSourceContract,
  SOURCE_CONTRACT_JOIN_SQL,
  SOURCE_CONTRACT_SELECT_SQL,
  updateDraftContractLink
} from '../contractAssignment.js';
import {
  assertSelfOrAdmin,
  resolveActorDepartment,
  sessionActor,
  withSessionActor
} from '../requestActor.js';
import { sourcingEnabled } from '../sourcingConfig.js';
import { findOpenSourcingEvent } from '../sourcingService.js';

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
        ${SOURCE_CONTRACT_SELECT_SQL},
        (SELECT COUNT(*) FROM requisition_items WHERE requisition_id = pr.id) as item_count,
        (SELECT COUNT(*) FROM approval_requests WHERE requisition_id = pr.id AND status = 'pending') as pending_approvals_count
      FROM purchase_requisitions pr
      JOIN users u ON pr.requester_id = u.id
      JOIN departments d ON pr.department_id = d.id
      ${SOURCE_CONTRACT_JOIN_SQL}
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
    res.json(prs.map((row) => nestSourceContract(row)));
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
        d.code as department_code,
        ${SOURCE_CONTRACT_SELECT_SQL}
      FROM purchase_requisitions pr
      JOIN users u ON pr.requester_id = u.id
      JOIN departments d ON pr.department_id = d.id
      ${SOURCE_CONTRACT_JOIN_SQL}
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

    const body = {
      ...nestSourceContract(pr),
      items: annotateResolvedSuppliers(items),
      approvals,
      logs,
      purchase_orders: purchaseOrders,
      purchase_order: purchaseOrders[0] || null
    };
    if (sourcingEnabled()) {
      const openEvent = await findOpenSourcingEvent(db, id);
      if (openEvent) {
        body.sourcing_event = {
          id: openEvent.id,
          event_number: openEvent.event_number,
          status: openEvent.status
        };
      }
    }
    res.json(body);
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
    const actor = sessionActor(req);
    const body = withSessionActor(req, req.body, {
      ids: ['requester_id'],
      names: ['actor_name']
    });
    const {
      requester_id,
      justification,
      needed_by_date,
      priority,
      items,
      submitImmediately,
      source_contract_id,
      skip_contract_match,
      actor_name,
      today
    } = body;
    const department_id = resolveActorDepartment(actor, body.department_id);

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'Requisition must have at least one line item.' });
    }

    for (const item of items) {
      await assertActiveCatalogItem(db, item.catalog_item_id);
      await assertActiveSupplierForBuyer(
        db,
        item.estimated_supplier_id || 1,
        'estimated_supplier_id'
      );
    }

    const created = await createRequisition(db, {
      requester_id,
      department_id,
      justification,
      needed_by_date,
      priority,
      items,
      submitImmediately,
      source_contract_id,
      skip_contract_match,
      actor_name,
      today
    });
    res.status(201).json({
      id: created.prId,
      message: 'Requisition created successfully',
      source_contract_id: created.assignment?.source_contract_id ?? null,
      contract_use_status: created.assignment?.contract_use_status || 'none'
    });
  } catch (error) {
    const status = httpErrorStatus(error);
    if (status >= 500) console.error('Error creating requisition:', error);
    res.status(status).json({ error: error.message });
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
    assertSelfOrAdmin(sessionActor(req), pr.requester_id, 'Only the requisition requester can submit this draft.');

    const body = withSessionActor(req, req.body || {}, { names: ['actor_name'] });
    const { source_contract_id, skip_contract_match, actor_name, today } = body;

    const assignment = await db.transaction(async () => {
      await db.prepare(`UPDATE purchase_requisitions SET status = 'pending_approval', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
      await insertApprovalChain(db, id, pr.total_amount, pr.department_id);
      await db.prepare(`
        INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
        VALUES ('requisition', ?, 'SUBMITTED', ?, 'Submitted for approval routing')
      `).run(id, actor_name);

      const alreadyLinked = pr.source_contract_id && pr.contract_use_status
        && pr.contract_use_status !== 'none'
        && pr.contract_use_status !== 'skipped';
      if (alreadyLinked && source_contract_id == null && !skip_contract_match) {
        return {
          source_contract_id: pr.source_contract_id,
          contract_use_status: pr.contract_use_status
        };
      }
      // Explicit ad-hoc (create skip or draft clear) must survive submit without rematch.
      if (pr.contract_use_status === 'skipped' && source_contract_id == null && !skip_contract_match) {
        return {
          source_contract_id: null,
          contract_use_status: 'skipped'
        };
      }
      return assignContractToRequisition(db, id, {
        source_contract_id,
        skip_contract_match,
        actor_name,
        today
      });
    });

    res.json({
      message: 'Requisition submitted for approval',
      source_contract_id: assignment?.source_contract_id ?? pr.source_contract_id ?? null,
      contract_use_status: assignment?.contract_use_status || pr.contract_use_status || 'none'
    });
  } catch (error) {
    res.status(httpErrorStatus(error)).json({ error: error.message });
  }
});

// Draft override: set, replace, or clear the proposed contract before submit.
router.patch('/:id/contract', async (req, res) => {
  try {
    const existing = await req.db.prepare(`SELECT * FROM purchase_requisitions WHERE id = ?`).get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Requisition not found' });
    assertSelfOrAdmin(sessionActor(req), existing.requester_id, 'Only the requisition requester can change this draft.');
    const body = withSessionActor(req, req.body || {}, { names: ['actor_name'] });
    const { source_contract_id, actor_name, today } = body;
    const result = await updateDraftContractLink(req.db, req.params.id, {
      source_contract_id,
      actor_name,
      today
    });
    res.json({ message: 'Contract link updated', ...result });
  } catch (error) {
    res.status(httpErrorStatus(error)).json({ error: error.message });
  }
});

export default router;
