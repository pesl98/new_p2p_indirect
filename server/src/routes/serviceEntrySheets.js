import express from 'express';
import db from '../db.js';
import {
  acceptServiceEntrySheet,
  createServiceEntrySheet,
  rejectServiceEntrySheet,
  submitServiceEntrySheet
} from '../serviceEntrySheetsService.js';

const router = express.Router();

function httpError(res, error) {
  const status = error.statusCode || 500;
  if (status >= 500) console.error(error);
  return res.status(status).json({ error: error.message });
}

router.get('/', (req, res) => {
  try {
    const { po_id, status } = req.query;
    let query = `
      SELECT
        ses.*,
        po.po_number,
        s.name as supplier_name,
        creator.name as created_by_name,
        decider.name as decided_by_name,
        (SELECT COUNT(*) FROM service_entry_sheet_items WHERE ses_id = ses.id) as items_count,
        (SELECT COALESCE(SUM(quantity_accepted), 0) FROM service_entry_sheet_items WHERE ses_id = ses.id) as total_qty_accepted,
        (SELECT COALESCE(SUM(amount_cents), 0) FROM service_entry_sheet_items WHERE ses_id = ses.id) as total_amount_cents
      FROM service_entry_sheets ses
      JOIN purchase_orders po ON ses.po_id = po.id
      JOIN suppliers s ON po.supplier_id = s.id
      JOIN users creator ON ses.created_by = creator.id
      LEFT JOIN users decider ON ses.decided_by = decider.id
      WHERE 1=1
    `;
    const params = [];

    if (po_id) {
      query += ` AND ses.po_id = ?`;
      params.push(po_id);
    }
    if (status && status !== 'all') {
      query += ` AND ses.status = ?`;
      params.push(status);
    }

    query += ` ORDER BY ses.id DESC`;
    res.json(db.prepare(query).all(...params));
  } catch (error) {
    httpError(res, error);
  }
});

router.get('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const ses = db.prepare(`
      SELECT
        ses.*,
        po.po_number,
        po.total_amount as po_total_amount,
        s.name as supplier_name,
        creator.name as created_by_name,
        decider.name as decided_by_name
      FROM service_entry_sheets ses
      JOIN purchase_orders po ON ses.po_id = po.id
      JOIN suppliers s ON po.supplier_id = s.id
      JOIN users creator ON ses.created_by = creator.id
      LEFT JOIN users decider ON ses.decided_by = decider.id
      WHERE ses.id = ?
    `).get(id);

    if (!ses) return res.status(404).json({ error: 'Service entry sheet not found' });

    const items = db.prepare(`
      SELECT
        si.*,
        poi.item_description,
        poi.quantity as ordered_quantity,
        poi.unit_price,
        poi.quantity_accepted as po_quantity_accepted,
        poi.line_type
      FROM service_entry_sheet_items si
      JOIN po_items poi ON si.po_item_id = poi.id
      WHERE si.ses_id = ?
    `).all(id);

    res.json({ ...ses, items });
  } catch (error) {
    httpError(res, error);
  }
});

router.post('/', (req, res) => {
  try {
    const result = createServiceEntrySheet(db, req.body);
    res.status(201).json({
      sesId: result.sesId,
      sesNumber: result.sesNumber,
      status: result.status,
      message: 'Service entry sheet created successfully'
    });
  } catch (error) {
    httpError(res, error);
  }
});

router.post('/:id/submit', (req, res) => {
  try {
    const result = submitServiceEntrySheet(db, req.params.id, req.body);
    res.json({
      sesId: result.sesId,
      sesNumber: result.sesNumber,
      status: result.status,
      message: 'Service entry sheet submitted for acceptance'
    });
  } catch (error) {
    httpError(res, error);
  }
});

router.post('/:id/accept', (req, res) => {
  try {
    const result = acceptServiceEntrySheet(db, req.params.id, req.body);
    res.json({
      sesId: result.sesId,
      sesNumber: result.sesNumber,
      status: result.status,
      poStatus: result.newPOStatus,
      overAcceptance: result.overAcceptance,
      message: 'Service entry sheet accepted'
    });
  } catch (error) {
    httpError(res, error);
  }
});

router.post('/:id/reject', (req, res) => {
  try {
    const result = rejectServiceEntrySheet(db, req.params.id, req.body);
    res.json({
      sesId: result.sesId,
      sesNumber: result.sesNumber,
      status: result.status,
      message: 'Service entry sheet rejected'
    });
  } catch (error) {
    httpError(res, error);
  }
});

export default router;
