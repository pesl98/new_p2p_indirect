/**
 * Chronological P2P document trail derived from existing FKs + audit_logs.
 * Does not invent events. Money fields stay integer cents. Timestamps are ISO-8601.
 */

import { formatCents } from './money.js';

const AP_AUDIT_ACTIONS = new Set(['APPROVED_FOR_PAYMENT', 'APPROVED_PAYMENT', 'PAID']);

const EXCEPTION_AUDIT_ACTIONS = {
  EXCEPTION_ACCEPT_VARIANCE: 'Exception accepted',
  EXCEPTION_REJECT_INVOICE: 'Exception rejected',
  EXCEPTION_RETURN_TO_BUYER: 'Returned to buyer',
  EXCEPTION_SHORT_PAY: 'Invoice short-paid'
};

const KIND_ORDER = {
  requisition: 1,
  approval: 2,
  purchase_order: 3,
  goods_receipt: 4,
  service_entry_sheet: 5,
  invoice: 6,
  exception: 7,
  ap_event: 8
};

export class DocumentTrailError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'DocumentTrailError';
    this.statusCode = statusCode;
  }
}

/** Convert SQLite DATETIME / date-only values to ISO-8601 (treated as UTC). */
export function toIsoTimestamp(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `${raw}T00:00:00.000Z`;
  }
  const sqliteDateTime = raw.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/);
  if (sqliteDateTime) {
    return new Date(`${sqliteDateTime[1]}T${sqliteDateTime[2]}Z`).toISOString();
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

function tabForKind(kind) {
  switch (kind) {
    case 'requisition':
    case 'approval':
      return 'requisitions';
    case 'purchase_order':
      return 'purchase_orders';
    case 'goods_receipt':
      return 'goods_receipt';
    case 'service_entry_sheet':
      return 'service_entry';
    case 'invoice':
    case 'exception':
    case 'ap_event':
      return 'invoices';
    default:
      return null;
  }
}

function isoRowTime(row, ...keys) {
  for (const key of keys) {
    if (row[key]) return toIsoTimestamp(row[key]);
  }
  return null;
}

function sortTimeline(events) {
  return [...events].sort((a, b) => {
    const atA = a.at || '';
    const atB = b.at || '';
    if (atA !== atB) return atA.localeCompare(atB);
    const kindA = KIND_ORDER[a.kind] || 99;
    const kindB = KIND_ORDER[b.kind] || 99;
    if (kindA !== kindB) return kindA - kindB;
    return (a.entity_id || 0) - (b.entity_id || 0);
  });
}

function mapRequisition(row) {
  if (!row) return null;
  return {
    id: row.id,
    pr_number: row.pr_number,
    status: row.status,
    total_amount: row.total_amount,
    justification: row.justification,
    priority: row.priority,
    needed_by_date: row.needed_by_date,
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
    requester_id: row.requester_id,
    requester_name: row.requester_name,
    department_id: row.department_id,
    department_name: row.department_name,
    department_code: row.department_code
  };
}

async function loadRequisition(db, id) {
  return await db.prepare(`
    SELECT
      pr.*,
      u.name as requester_name,
      d.name as department_name,
      d.code as department_code
    FROM purchase_requisitions pr
    JOIN users u ON pr.requester_id = u.id
    JOIN departments d ON pr.department_id = d.id
    WHERE pr.id = ?
  `).get(id);
}

async function loadPurchaseOrder(db, id) {
  return await db.prepare(`
    SELECT
      po.*,
      s.name as supplier_name,
      s.code as supplier_code,
      u.name as created_by_name,
      pr.pr_number
    FROM purchase_orders po
    JOIN suppliers s ON po.supplier_id = s.id
    JOIN users u ON po.created_by = u.id
    LEFT JOIN purchase_requisitions pr ON po.requisition_id = pr.id
    WHERE po.id = ?
  `).get(id);
}

async function loadApprovals(db, requisitionId) {
  const rows = await db.prepare(`
    SELECT
      ar.id,
      ar.requisition_id,
      ar.approver_id,
      ar.step_order,
      ar.status,
      ar.comments,
      ar.decided_at,
      ar.created_at,
      u.name as approver_name,
      u.role as approver_role,
      u.title as approver_title
    FROM approval_requests ar
    JOIN users u ON ar.approver_id = u.id
    WHERE ar.requisition_id = ?
    ORDER BY ar.step_order ASC, ar.id ASC
  `).all(requisitionId);
  return rows.map((row) => ({
    id: row.id,
    requisition_id: row.requisition_id,
    approver_id: row.approver_id,
    step_order: row.step_order,
    status: row.status,
    comments: row.comments,
    decided_at: toIsoTimestamp(row.decided_at),
    created_at: toIsoTimestamp(row.created_at),
    approver_name: row.approver_name,
    approver_role: row.approver_role,
    approver_title: row.approver_title
  }));
}

async function loadApEvents(db, invoiceId) {
  const rows = await db.prepare(`
    SELECT id, entity_type, entity_id, action, actor_name, details, created_at
    FROM audit_logs
    WHERE entity_type = 'invoice' AND entity_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(invoiceId);
  return rows
    .filter((row) => AP_AUDIT_ACTIONS.has(row.action))
    .map((row) => ({
      id: row.id,
      invoice_id: invoiceId,
      action: row.action,
      actor_name: row.actor_name,
      details: row.details,
      created_at: toIsoTimestamp(row.created_at)
    }));
}

async function loadExceptionEvents(db, invoiceId) {
  const rows = await db.prepare(`
    SELECT id, entity_type, entity_id, action, actor_name, details, created_at
    FROM audit_logs
    WHERE entity_type = 'invoice' AND entity_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(invoiceId);
  return rows
    .filter((row) => Object.prototype.hasOwnProperty.call(EXCEPTION_AUDIT_ACTIONS, row.action))
    .map((row) => ({
      id: row.id,
      invoice_id: invoiceId,
      action: row.action,
      title: EXCEPTION_AUDIT_ACTIONS[row.action],
      actor_name: row.actor_name,
      details: row.details,
      created_at: toIsoTimestamp(row.created_at)
    }));
}

async function loadInvoiceRows(db, poId) {
  const rows = await db.prepare(`
    SELECT
      inv.id,
      inv.invoice_number,
      inv.po_id,
      inv.supplier_id,
      inv.invoice_date,
      inv.due_date,
      inv.subtotal,
      inv.tax_amount,
      inv.total_amount,
      inv.payable_total_cents,
      inv.status,
      inv.match_status,
      inv.payment_reference,
      inv.notes,
      inv.created_at,
      s.name as supplier_name
    FROM invoices inv
    JOIN suppliers s ON inv.supplier_id = s.id
    WHERE inv.po_id = ?
    ORDER BY inv.id ASC
  `).all(poId);
  return Promise.all(rows.map(async (row) => ({
    id: row.id,
    invoice_number: row.invoice_number,
    po_id: row.po_id,
    supplier_id: row.supplier_id,
    supplier_name: row.supplier_name,
    invoice_date: row.invoice_date,
    due_date: row.due_date,
    subtotal: row.subtotal,
    tax_amount: row.tax_amount,
    total_amount: row.total_amount,
    payable_total_cents: row.payable_total_cents ?? null,
    status: row.status,
    match_status: row.match_status,
    payment_reference: row.payment_reference,
    notes: row.notes,
    created_at: toIsoTimestamp(row.created_at),
    ap_events: await loadApEvents(db, row.id),
    exception_events: await loadExceptionEvents(db, row.id)
  })));
}

async function loadGoodsReceipts(db, poId) {
  const rows = await db.prepare(`
    SELECT
      gr.id,
      gr.grn_number,
      gr.po_id,
      gr.received_by,
      gr.receipt_date,
      gr.carrier_tracking,
      gr.delivery_note_number,
      gr.notes,
      gr.created_at,
      u.name as received_by_name
    FROM goods_receipts gr
    JOIN users u ON gr.received_by = u.id
    WHERE gr.po_id = ?
    ORDER BY gr.id ASC
  `).all(poId);
  return rows.map((row) => ({
    id: row.id,
    grn_number: row.grn_number,
    po_id: row.po_id,
    received_by: row.received_by,
    received_by_name: row.received_by_name,
    receipt_date: row.receipt_date,
    carrier_tracking: row.carrier_tracking,
    delivery_note_number: row.delivery_note_number,
    notes: row.notes,
    created_at: toIsoTimestamp(row.created_at)
  }));
}

async function loadServiceEntrySheets(db, poId) {
  const rows = await db.prepare(`
    SELECT
      ses.id,
      ses.ses_number,
      ses.po_id,
      ses.created_by,
      ses.status,
      ses.service_period_start,
      ses.service_period_end,
      ses.notes,
      ses.decided_by,
      ses.decided_at,
      ses.decision_comments,
      ses.created_at,
      cu.name as created_by_name,
      du.name as decided_by_name
    FROM service_entry_sheets ses
    JOIN users cu ON ses.created_by = cu.id
    LEFT JOIN users du ON ses.decided_by = du.id
    WHERE ses.po_id = ?
    ORDER BY ses.id ASC
  `).all(poId);
  return rows.map((row) => ({
    id: row.id,
    ses_number: row.ses_number,
    po_id: row.po_id,
    created_by: row.created_by,
    created_by_name: row.created_by_name,
    status: row.status,
    service_period_start: row.service_period_start,
    service_period_end: row.service_period_end,
    notes: row.notes,
    decided_by: row.decided_by,
    decided_by_name: row.decided_by_name,
    decided_at: toIsoTimestamp(row.decided_at),
    decision_comments: row.decision_comments,
    created_at: toIsoTimestamp(row.created_at)
  }));
}

async function loadPoLineSummary(db, poId) {
  return await db.prepare(`
    SELECT
      COUNT(*) as line_count,
      SUM(CASE WHEN line_type = 'goods' THEN 1 ELSE 0 END) as goods_line_count,
      SUM(CASE WHEN line_type = 'service' THEN 1 ELSE 0 END) as service_line_count
    FROM po_items
    WHERE po_id = ?
  `).get(poId);
}

async function loadPurchaseOrderBranches(db, poRows) {
  return Promise.all(poRows.map(async (po) => {
    const lines = await loadPoLineSummary(db, po.id);
    const goodsReceipts = await loadGoodsReceipts(db, po.id);
    const serviceEntrySheets = await loadServiceEntrySheets(db, po.id);
    const invoices = await loadInvoiceRows(db, po.id);
    return {
      id: po.id,
      po_number: po.po_number,
      requisition_id: po.requisition_id,
      status: po.status,
      total_amount: po.total_amount,
      issue_date: po.issue_date,
      expected_delivery_date: po.expected_delivery_date,
      payment_terms: po.payment_terms,
      created_at: toIsoTimestamp(po.created_at),
      supplier_id: po.supplier_id,
      supplier_name: po.supplier_name,
      supplier_code: po.supplier_code,
      created_by: po.created_by,
      created_by_name: po.created_by_name,
      goods_line_count: lines?.goods_line_count || 0,
      service_line_count: lines?.service_line_count || 0,
      goods_receipts: goodsReceipts,
      service_entry_sheets: serviceEntrySheets,
      invoices,
      receiving: {
        goods: goodsReceipts.length > 0 ? 'recorded' : ((lines?.goods_line_count || 0) > 0 ? 'not_started' : 'not_applicable'),
        services: serviceEntrySheets.length > 0 ? 'recorded' : ((lines?.service_line_count || 0) > 0 ? 'not_started' : 'not_applicable')
      }
    };
  }));
}

function stageStatus({ complete, current, notApplicable = false }) {
  if (notApplicable) return 'not_applicable';
  if (complete) return 'complete';
  if (current) return 'current';
  return 'not_started';
}

function buildStages({ requisition, approvals, purchaseOrders }) {
  const hasPr = Boolean(requisition);
  const approvalDecided = approvals.filter((step) => ['approved', 'rejected', 'skipped'].includes(step.status));
  const approvalPending = approvals.some((step) => step.status === 'pending');
  const hasPos = purchaseOrders.length > 0;
  const hasReceiving = purchaseOrders.some(
    (po) => po.goods_receipts.length > 0 || po.service_entry_sheets.length > 0
  );
  const invoices = purchaseOrders.flatMap((po) => po.invoices);
  const hasInvoice = invoices.length > 0;
  const hasAp = invoices.some(
    (inv) => inv.status === 'approved_for_payment' || inv.status === 'paid' || inv.ap_events.length > 0
  );
  const invoiceAwaitingAp = hasInvoice && !hasAp;

  return [
    {
      key: 'requisition',
      label: 'Requisition',
      status: stageStatus({ complete: hasPr, current: false, notApplicable: !hasPr && hasPos })
    },
    {
      key: 'approvals',
      label: 'Approvals',
      status: stageStatus({
        complete: approvals.length > 0 && approvalDecided.length === approvals.length,
        current: approvalPending,
        notApplicable: !hasPr
      })
    },
    {
      key: 'purchase_orders',
      label: 'Purchase order',
      status: stageStatus({ complete: hasPos, current: requisition?.status === 'approved' })
    },
    {
      key: 'receiving',
      label: 'GRN / SES',
      status: stageStatus({ complete: hasReceiving, current: false })
    },
    {
      key: 'invoice',
      label: 'Invoice',
      status: stageStatus({ complete: hasInvoice, current: false })
    },
    {
      key: 'ap',
      label: 'AP payment',
      status: stageStatus({ complete: hasAp, current: invoiceAwaitingAp })
    }
  ];
}

function timelineEvent(partial) {
  const event = {
    tab: tabForKind(partial.kind),
    source: partial.source || 'document',
    po_id: partial.po_id ?? null,
    po_number: partial.po_number ?? null,
    supplier_name: partial.supplier_name ?? null,
    amount_cents: partial.amount_cents ?? null,
    actor_name: partial.actor_name ?? null,
    details: partial.details ?? null,
    match_status: partial.match_status ?? null,
    ...partial
  };
  if (event.focus_id == null) {
    event.focus_id = event.entity_id ?? null;
  }
  return event;
}

function buildTimeline({ requisition, approvals, purchaseOrders }) {
  const events = [];

  if (requisition) {
    events.push(timelineEvent({
      id: `requisition:${requisition.id}`,
      kind: 'requisition',
      entity_type: 'requisition',
      entity_id: requisition.id,
      number: requisition.pr_number,
      title: 'Requisition',
      status: requisition.status,
      at: requisition.created_at,
      actor_name: requisition.requester_name,
      details: requisition.justification,
      amount_cents: requisition.total_amount
    }));
  }

  for (const step of approvals) {
    events.push(timelineEvent({
      id: `approval:${step.id}`,
      kind: 'approval',
      entity_type: 'approval_request',
      entity_id: step.id,
      number: `Step ${step.step_order}`,
      title: `Approval step ${step.step_order}`,
      status: step.status,
      at: step.decided_at || step.created_at,
      actor_name: step.approver_name,
      details: step.comments,
      amount_cents: requisition?.total_amount ?? null,
      focus_id: requisition?.id ?? step.id
    }));
  }

  for (const po of purchaseOrders) {
    events.push(timelineEvent({
      id: `purchase_order:${po.id}`,
      kind: 'purchase_order',
      entity_type: 'purchase_order',
      entity_id: po.id,
      number: po.po_number,
      title: 'Purchase order',
      status: po.status,
      at: po.created_at || toIsoTimestamp(po.issue_date),
      actor_name: po.created_by_name,
      details: po.supplier_name,
      amount_cents: po.total_amount,
      po_id: po.id,
      po_number: po.po_number,
      supplier_name: po.supplier_name
    }));

    for (const grn of po.goods_receipts) {
      events.push(timelineEvent({
        id: `goods_receipt:${grn.id}`,
        kind: 'goods_receipt',
        entity_type: 'goods_receipt',
        entity_id: grn.id,
        number: grn.grn_number,
        title: 'Goods receipt',
        status: 'received',
        at: toIsoTimestamp(grn.receipt_date) || grn.created_at,
        actor_name: grn.received_by_name,
        details: grn.notes,
        po_id: po.id,
        po_number: po.po_number,
        supplier_name: po.supplier_name
      }));
    }

    for (const ses of po.service_entry_sheets) {
      events.push(timelineEvent({
        id: `service_entry_sheet:${ses.id}`,
        kind: 'service_entry_sheet',
        entity_type: 'service_entry_sheet',
        entity_id: ses.id,
        number: ses.ses_number,
        title: 'Service entry sheet',
        status: ses.status,
        at: ses.decided_at || ses.created_at,
        actor_name: ses.decided_by_name || ses.created_by_name,
        details: ses.decision_comments || ses.notes,
        po_id: po.id,
        po_number: po.po_number,
        supplier_name: po.supplier_name
      }));
    }

    for (const invoice of po.invoices) {
      events.push(timelineEvent({
        id: `invoice:${invoice.id}`,
        kind: 'invoice',
        entity_type: 'invoice',
        entity_id: invoice.id,
        number: invoice.invoice_number,
        title: 'Vendor invoice',
        status: invoice.status,
        at: invoice.created_at || toIsoTimestamp(invoice.invoice_date),
        details: invoice.payable_total_cents != null
          ? [invoice.notes, `Billed $${formatCents(invoice.total_amount)} → Pay $${formatCents(invoice.payable_total_cents)}`].filter(Boolean).join(' ')
          : invoice.notes,
        amount_cents: invoice.total_amount,
        payable_total_cents: invoice.payable_total_cents ?? null,
        match_status: invoice.match_status,
        po_id: po.id,
        po_number: po.po_number,
        supplier_name: invoice.supplier_name
      }));

      for (const exception of invoice.exception_events || []) {
        events.push(timelineEvent({
          id: `exception:${exception.id}`,
          kind: 'exception',
          entity_type: 'invoice',
          entity_id: invoice.id,
          number: invoice.invoice_number,
          title: exception.title,
          status: exception.action === 'EXCEPTION_REJECT_INVOICE' ? 'rejected' : invoice.status,
          at: exception.created_at,
          actor_name: exception.actor_name,
          details: exception.details,
          amount_cents: exception.action === 'EXCEPTION_SHORT_PAY' && invoice.payable_total_cents != null
            ? invoice.payable_total_cents
            : invoice.total_amount,
          payable_total_cents: invoice.payable_total_cents ?? null,
          match_status: invoice.match_status,
          po_id: po.id,
          po_number: po.po_number,
          supplier_name: invoice.supplier_name,
          source: 'audit',
          tab: 'exception_workbench'
        }));
      }

      for (const ap of invoice.ap_events) {
        events.push(timelineEvent({
          id: `ap_event:${ap.id}`,
          kind: 'ap_event',
          entity_type: 'invoice',
          entity_id: invoice.id,
          number: invoice.invoice_number,
          title: ap.action === 'PAID' ? 'Marked paid' : 'AP approved for payment',
          status: ap.action === 'PAID' ? 'paid' : 'approved_for_payment',
          at: ap.created_at,
          actor_name: ap.actor_name,
          details: ap.details,
          amount_cents: invoice.payable_total_cents != null ? invoice.payable_total_cents : invoice.total_amount,
          payable_total_cents: invoice.payable_total_cents ?? null,
          match_status: invoice.match_status,
          po_id: po.id,
          po_number: po.po_number,
          supplier_name: invoice.supplier_name,
          source: 'audit'
        }));
      }
    }
  }

  return sortTimeline(events);
}

function buildTrailPayload({ startingPoint, requisition, approvals, purchaseOrders }) {
  return {
    starting_point: startingPoint,
    requisition: mapRequisition(requisition),
    approvals,
    purchase_orders: purchaseOrders,
    split: purchaseOrders.length > 1,
    stages: buildStages({ requisition, approvals, purchaseOrders }),
    timeline: buildTimeline({
      requisition: mapRequisition(requisition),
      approvals,
      purchaseOrders
    })
  };
}

export async function searchDocumentTrails(db, q = '') {
  const term = String(q || '').trim();
  const like = `%${term}%`;

  const requisitions = await db.prepare(`
    SELECT
      pr.id,
      pr.pr_number,
      pr.status,
      pr.total_amount,
      pr.created_at,
      u.name as requester_name,
      d.name as department_name
    FROM purchase_requisitions pr
    JOIN users u ON pr.requester_id = u.id
    JOIN departments d ON pr.department_id = d.id
    WHERE ? = ''
       OR pr.pr_number LIKE ?
       OR pr.justification LIKE ?
       OR u.name LIKE ?
    ORDER BY pr.id DESC
    LIMIT 20
  `).all(term, like, like, like);
  const requisitionHits = requisitions.map((row) => ({
    ...row,
    created_at: toIsoTimestamp(row.created_at)
  }));

  const purchaseOrders = await db.prepare(`
    SELECT
      po.id,
      po.po_number,
      po.status,
      po.total_amount,
      po.requisition_id,
      po.created_at,
      s.name as supplier_name,
      pr.pr_number
    FROM purchase_orders po
    JOIN suppliers s ON po.supplier_id = s.id
    LEFT JOIN purchase_requisitions pr ON po.requisition_id = pr.id
    WHERE ? = ''
       OR po.po_number LIKE ?
       OR s.name LIKE ?
       OR pr.pr_number LIKE ?
    ORDER BY po.id DESC
    LIMIT 20
  `).all(term, like, like, like);
  const purchaseOrderHits = purchaseOrders.map((row) => ({
    ...row,
    created_at: toIsoTimestamp(row.created_at)
  }));

  const invoices = term
    ? await db.prepare(`
        SELECT
          inv.id,
          inv.invoice_number,
          inv.status,
          inv.match_status,
          inv.total_amount,
          inv.po_id,
          po.po_number,
          po.requisition_id,
          pr.pr_number
        FROM invoices inv
        JOIN purchase_orders po ON inv.po_id = po.id
        LEFT JOIN purchase_requisitions pr ON po.requisition_id = pr.id
        WHERE inv.invoice_number LIKE ?
        ORDER BY inv.id DESC
        LIMIT 10
      `).all(like)
    : [];

  return { requisitions: requisitionHits, purchase_orders: purchaseOrderHits, invoices };
}

async function resolveStartingDocument(db, query = {}) {
  const requisitionId = query.requisition_id != null && query.requisition_id !== ''
    ? Number(query.requisition_id)
    : null;
  const poId = query.po_id != null && query.po_id !== ''
    ? Number(query.po_id)
    : null;
  const prNumber = query.pr_number ? String(query.pr_number).trim() : '';
  const poNumber = query.po_number ? String(query.po_number).trim() : '';
  const q = query.q ? String(query.q).trim() : '';

  if (requisitionId) {
    const pr = await loadRequisition(db, requisitionId);
    if (!pr) throw new DocumentTrailError('Requisition not found', 404);
    return { requisition: pr, purchaseOrder: null };
  }

  if (prNumber) {
    const pr = await db.prepare(`
      SELECT id FROM purchase_requisitions WHERE pr_number = ? COLLATE NOCASE
    `).get(prNumber);
    if (!pr) throw new DocumentTrailError('Requisition not found', 404);
    return { requisition: await loadRequisition(db, pr.id), purchaseOrder: null };
  }

  if (poId) {
    const po = await loadPurchaseOrder(db, poId);
    if (!po) throw new DocumentTrailError('Purchase order not found', 404);
    const pr = po.requisition_id ? await loadRequisition(db, po.requisition_id) : null;
    return { requisition: pr, purchaseOrder: po };
  }

  if (poNumber) {
    const po = await db.prepare(`
      SELECT id FROM purchase_orders WHERE po_number = ? COLLATE NOCASE
    `).get(poNumber);
    if (!po) throw new DocumentTrailError('Purchase order not found', 404);
    const full = await loadPurchaseOrder(db, po.id);
    const pr = full.requisition_id ? await loadRequisition(db, full.requisition_id) : null;
    return { requisition: pr, purchaseOrder: full };
  }

  if (q) {
    const prExact = await db.prepare(`
      SELECT id FROM purchase_requisitions WHERE pr_number = ? COLLATE NOCASE
    `).get(q);
    if (prExact) {
      return { requisition: await loadRequisition(db, prExact.id), purchaseOrder: null };
    }

    const poExact = await db.prepare(`
      SELECT id FROM purchase_orders WHERE po_number = ? COLLATE NOCASE
    `).get(q);
    if (poExact) {
      const full = await loadPurchaseOrder(db, poExact.id);
      const pr = full.requisition_id ? await loadRequisition(db, full.requisition_id) : null;
      return { requisition: pr, purchaseOrder: full };
    }

    const invoiceExact = await db.prepare(`
      SELECT po_id FROM invoices WHERE invoice_number = ? COLLATE NOCASE
    `).all(q);
    if (invoiceExact.length === 1) {
      const full = await loadPurchaseOrder(db, invoiceExact[0].po_id);
      const pr = full.requisition_id ? await loadRequisition(db, full.requisition_id) : null;
      return { requisition: pr, purchaseOrder: full };
    }

    throw new DocumentTrailError('No document trail found for that search', 404);
  }

  throw new DocumentTrailError(
    'Provide requisition_id, pr_number, po_id, po_number, or q',
    400
  );
}

export async function getDocumentTrail(db, query = {}) {
  const { requisition, purchaseOrder } = await resolveStartingDocument(db, query);

  if (requisition) {
    const approvals = await loadApprovals(db, requisition.id);
    const poRows = await db.prepare(`
      SELECT
        po.*,
        s.name as supplier_name,
        s.code as supplier_code,
        u.name as created_by_name
      FROM purchase_orders po
      JOIN suppliers s ON po.supplier_id = s.id
      JOIN users u ON po.created_by = u.id
      WHERE po.requisition_id = ?
      ORDER BY po.id ASC
    `).all(requisition.id);
    const purchaseOrders = await loadPurchaseOrderBranches(db, poRows);
    return buildTrailPayload({
      startingPoint: {
        type: 'requisition',
        id: requisition.id,
        number: requisition.pr_number
      },
      requisition,
      approvals,
      purchaseOrders
    });
  }

  const purchaseOrders = await loadPurchaseOrderBranches(db, [purchaseOrder]);
  return buildTrailPayload({
    startingPoint: {
      type: 'purchase_order',
      id: purchaseOrder.id,
      number: purchaseOrder.po_number
    },
    requisition: null,
    approvals: [],
    purchaseOrders
  });
}
