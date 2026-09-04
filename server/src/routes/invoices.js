import express from 'express';
import db from '../db.js';

const router = express.Router();

// List all invoices
router.get('/', (req, res) => {
  try {
    const { status, po_id, supplier_id } = req.query;
    let query = `
      SELECT 
        inv.*,
        po.po_number,
        po.total_amount as po_total_amount,
        s.name as supplier_name,
        s.code as supplier_code,
        (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = inv.id) as items_count,
        (SELECT COUNT(*) FROM match_results WHERE invoice_id = inv.id AND status = 'fail') as fail_variances_count
      FROM invoices inv
      JOIN purchase_orders po ON inv.po_id = po.id
      JOIN suppliers s ON inv.supplier_id = s.id
      WHERE 1=1
    `;
    const params = [];

    if (status && status !== 'all') {
      query += ` AND inv.status = ?`;
      params.push(status);
    }
    if (po_id) {
      query += ` AND inv.po_id = ?`;
      params.push(po_id);
    }
    if (supplier_id) {
      query += ` AND inv.supplier_id = ?`;
      params.push(supplier_id);
    }

    query += ` ORDER BY inv.id DESC`;
    const invoices = db.prepare(query).all(...params);
    res.json(invoices);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get invoice detail with full 3-way match audit results
router.get('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const invoice = db.prepare(`
      SELECT 
        inv.*,
        po.po_number,
        po.total_amount as po_total_amount,
        po.issue_date as po_issue_date,
        po.status as po_status,
        s.name as supplier_name,
        s.code as supplier_code,
        s.payment_terms as supplier_terms,
        d.id as department_id,
        d.name as department_name,
        pr.pr_number
      FROM invoices inv
      JOIN purchase_orders po ON inv.po_id = po.id
      JOIN suppliers s ON inv.supplier_id = s.id
      LEFT JOIN purchase_requisitions pr ON po.requisition_id = pr.id
      LEFT JOIN departments d ON pr.department_id = d.id
      WHERE inv.id = ?
    `).get(id);

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    // Line items with corresponding PO details
    const items = db.prepare(`
      SELECT 
        ii.*,
        poi.quantity as po_quantity,
        poi.unit_price as po_unit_price,
        poi.total_price as po_total_price,
        poi.quantity_received as po_quantity_received,
        poi.item_description as po_description
      FROM invoice_items ii
      JOIN po_items poi ON ii.po_item_id = poi.id
      WHERE ii.invoice_id = ?
    `).all(id);

    // 3-Way match audit results
    const matchResults = db.prepare(`
      SELECT mr.*, poi.item_description
      FROM match_results mr
      LEFT JOIN po_items poi ON mr.po_item_id = poi.id
      WHERE mr.invoice_id = ?
    `).all(id);

    // Associated GRNs for this PO
    const receipts = db.prepare(`
      SELECT gr.*, u.name as received_by_name
      FROM goods_receipts gr
      JOIN users u ON gr.received_by = u.id
      WHERE gr.po_id = ?
      ORDER BY gr.receipt_date DESC
    `).all(invoice.po_id);

    res.json({
      ...invoice,
      items,
      match_results: matchResults,
      receipts
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Run 3-Way Matching Engine for an invoice
function run3WayMatch(invoiceId, poId, invoiceItems) {
  const matchEntries = [];
  let hasPriceVariance = false;
  let hasQuantityVariance = false;

  for (const item of invoiceItems) {
    const poItem = db.prepare(`SELECT * FROM po_items WHERE id = ?`).get(item.po_item_id);
    if (!poItem) continue;

    const invoicedQty = Number(item.quantity_invoiced);
    const invoicedPrice = Number(item.unit_price);
    const poPrice = Number(poItem.unit_price);
    const poReceivedQty = Number(poItem.quantity_received);
    const poOrderedQty = Number(poItem.quantity);

    const priceDiff = invoicedPrice - poPrice;
    const qtyUnreceived = Math.max(0, invoicedQty - poReceivedQty);

    let status = 'pass';
    const messages = [];

    // 1. Quantity matching against physical goods receipts
    if (invoicedQty > poReceivedQty) {
      status = 'fail';
      hasQuantityVariance = true;
      messages.push(`Quantity variance: Invoiced for ${invoicedQty}, but only ${poReceivedQty} physically received on GRN.`);
    } else if (invoicedQty < poOrderedQty) {
      messages.push(`Partial billing: ${invoicedQty} of ${poOrderedQty} units billed.`);
    }

    // 2. Unit price matching against authorized PO contract price
    if (Math.abs(priceDiff) > 0.01) {
      const pctDiff = ((priceDiff / poPrice) * 100).toFixed(2);
      if (Math.abs(pctDiff) <= 1.0) {
        if (status !== 'fail') status = 'warning';
        messages.push(`Minor price deviation within tolerance: $${invoicedPrice.toFixed(2)} vs PO $${poPrice.toFixed(2)} (${pctDiff}%).`);
      } else {
        status = 'fail';
        hasPriceVariance = true;
        messages.push(`Price discrepancy: Billed at $${invoicedPrice.toFixed(2)} vs authorized PO price $${poPrice.toFixed(2)} (${pctDiff > 0 ? '+' : ''}${pctDiff}%).`);
      }
    }

    if (messages.length === 0) {
      messages.push(`Exact match: ${invoicedQty} units at $${invoicedPrice.toFixed(2)} matches PO & physical receipts.`);
    }

    matchEntries.push({
      po_item_id: poItem.id,
      ordered_qty: poOrderedQty,
      received_qty: poReceivedQty,
      invoiced_qty: invoicedQty,
      po_unit_price: poPrice,
      invoice_unit_price: invoicedPrice,
      qty_variance: qtyUnreceived,
      price_variance: priceDiff,
      status,
      message: messages.join(' ')
    });
  }

  // Determine overall status
  let overallMatchStatus = 'perfect_match';
  let invoiceStatus = 'matched';

  if (hasQuantityVariance && hasPriceVariance) {
    overallMatchStatus = 'total_variance';
    invoiceStatus = 'variance_flagged';
  } else if (hasQuantityVariance) {
    overallMatchStatus = 'quantity_variance';
    invoiceStatus = 'variance_flagged';
  } else if (hasPriceVariance) {
    overallMatchStatus = 'price_variance';
    invoiceStatus = 'variance_flagged';
  }

  // Insert match results into DB
  const insertMatch = db.prepare(`
    INSERT INTO match_results (invoice_id, po_id, po_item_id, ordered_qty, received_qty, invoiced_qty, po_unit_price, invoice_unit_price, qty_variance, price_variance, status, message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const m of matchEntries) {
    insertMatch.run(
      invoiceId,
      poId,
      m.po_item_id,
      m.ordered_qty,
      m.received_qty,
      m.invoiced_qty,
      m.po_unit_price,
      m.invoice_unit_price,
      m.qty_variance,
      m.price_variance,
      m.status,
      m.message
    );
  }

  // Update invoice
  db.prepare(`
    UPDATE invoices
    SET status = ?, match_status = ?
    WHERE id = ?
  `).run(invoiceStatus, overallMatchStatus, invoiceId);

  return { overallMatchStatus, invoiceStatus };
}

// Create vendor invoice and execute automated 3-Way Match
router.post('/', (req, res) => {
  try {
    const { invoice_number, po_id, supplier_id, invoice_date, due_date, tax_amount, items, notes } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'Invoice must contain at least one line item.' });
    }

    const po = db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(po_id);
    if (!po) return res.status(404).json({ error: 'Purchase Order not found.' });

    const calculatedSubtotal = items.reduce((acc, item) => acc + (Number(item.quantity_invoiced) * Number(item.unit_price)), 0);
    const tax = Number(tax_amount) || 0;
    const totalAmount = calculatedSubtotal + tax;

    const invoiceTransaction = db.transaction(() => {
      const insertInvoice = db.prepare(`
        INSERT INTO invoices (invoice_number, po_id, supplier_id, invoice_date, due_date, subtotal, tax_amount, total_amount, status, match_status, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_match', 'pending', ?)
      `);
      const invResult = insertInvoice.run(
        invoice_number,
        po_id,
        supplier_id || po.supplier_id,
        invoice_date || new Date().toISOString().split('T')[0],
        due_date || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
        calculatedSubtotal,
        tax,
        totalAmount,
        notes || null
      );

      const invoiceId = invResult.lastInsertRowid;

      const insertItem = db.prepare(`
        INSERT INTO invoice_items (invoice_id, po_item_id, description, quantity_invoiced, unit_price, total_price)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const item of items) {
        const itemTotal = Number(item.quantity_invoiced) * Number(item.unit_price);
        insertItem.run(invoiceId, item.po_item_id, item.description, Number(item.quantity_invoiced), Number(item.unit_price), itemTotal);

        // Update po_item invoiced qty
        db.prepare(`UPDATE po_items SET quantity_invoiced = quantity_invoiced + ? WHERE id = ?`).run(Number(item.quantity_invoiced), item.po_item_id);
      }

      // Execute 3-Way Match Engine immediately!
      const matchOutcome = run3WayMatch(invoiceId, po_id, items);

      // Audit log
      db.prepare(`
        INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
        VALUES ('invoice', ?, '3_WAY_MATCHED', 'System 3-Way Matcher', ?)
      `).run(invoiceId, `Invoice ${invoice_number} processed for $${totalAmount.toFixed(2)}. Result: ${matchOutcome.overallMatchStatus}`);

      return { invoiceId, matchOutcome };
    });

    const result = invoiceTransaction();
    res.status(201).json({
      invoiceId: result.invoiceId,
      matchStatus: result.matchOutcome.overallMatchStatus,
      status: result.matchOutcome.invoiceStatus,
      message: 'Invoice created and 3-way matched successfully.'
    });
  } catch (error) {
    console.error('Error creating invoice:', error);
    res.status(500).json({ error: error.message });
  }
});

// Approve invoice for payment (Finance / Accounts Payable)
router.post('/:id/approve-payment', (req, res) => {
  try {
    const { id } = req.params;
    const { approver_name, override_reason } = req.body;

    const invoice = db.prepare(`
      SELECT inv.*, po.requisition_id, pr.department_id
      FROM invoices inv
      JOIN purchase_orders po ON inv.po_id = po.id
      LEFT JOIN purchase_requisitions pr ON po.requisition_id = pr.id
      WHERE inv.id = ?
    `).get(id);

    if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });

    const approveTransaction = db.transaction(() => {
      // Mark invoice approved for payment
      db.prepare(`
        UPDATE invoices
        SET status = 'approved_for_payment', notes = COALESCE(?, notes)
        WHERE id = ?
      `).run(override_reason ? `Approved with override: ${override_reason}` : invoice.notes, id);

      // Update Department Budget: relieve committed amount, increase actual spent!
      if (invoice.department_id) {
        db.prepare(`
          UPDATE budgets
          SET committed_amount = MAX(0, committed_amount - ?),
              actual_spent = actual_spent + ?
          WHERE department_id = ? AND fiscal_year = 2026
        `).run(invoice.total_amount, invoice.total_amount, invoice.department_id);
      }

      // Audit log
      db.prepare(`
        INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
        VALUES ('invoice', ?, 'APPROVED_FOR_PAYMENT', ?, ?)
      `).run(id, approver_name || 'Finance Specialist', `Approved invoice ${invoice.invoice_number} for $${invoice.total_amount.toFixed(2)} payment`);
    });

    approveTransaction();
    res.json({ message: 'Invoice approved for payment successfully.' });
  } catch (error) {
    console.error('Error approving invoice:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mark invoice as Paid
router.post('/:id/mark-paid', (req, res) => {
  try {
    const { id } = req.params;
    const { payment_reference, payer_name } = req.body;
    const ref = payment_reference || `ACH-${Date.now().toString().slice(-6)}`;

    db.prepare(`
      UPDATE invoices
      SET status = 'paid', payment_reference = ?
      WHERE id = ?
    `).run(ref, id);

    db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('invoice', ?, 'PAID', ?, ?)
    `).run(id, payer_name || 'Finance Lead', `Marked as paid with reference ${ref}`);

    res.json({ message: 'Invoice marked as paid.', payment_reference: ref });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
