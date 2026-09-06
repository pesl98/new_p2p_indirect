import { lineTotalCents, toQty } from './money.js';
import { nextDocumentNumber } from './docNumbers.js';
import { isServiceLine } from './lineType.js';
import { refreshPoFulfillmentStatus } from './poFulfillment.js';

export class ServiceEntrySheetError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ServiceEntrySheetError';
    this.statusCode = statusCode;
  }
}

function isExplicitTrue(value) {
  return value === true || value === 1 || value === 'true' || value === '1';
}

async function loadSesOrThrow(db, sesId) {
  const ses = await db.prepare(`SELECT * FROM service_entry_sheets WHERE id = ?`).get(sesId);
  if (!ses) {
    throw new ServiceEntrySheetError('Service entry sheet not found', 404);
  }
  return ses;
}

async function collectOverAcceptances(db, poId, items) {
  const overages = [];
  const validItems = [];

  for (const item of items) {
    const qty = toQty(item.quantity_accepted);
    if (qty <= 0) continue;

    const poItem = await db.prepare(
      `SELECT * FROM po_items WHERE id = ? AND po_id = ?`
    ).get(item.po_item_id, poId);
    if (!poItem) {
      throw new ServiceEntrySheetError(
        `PO line ${item.po_item_id} was not found on this purchase order.`
      );
    }
    if (!isServiceLine(poItem)) {
      throw new ServiceEntrySheetError(
        `PO line ${poItem.id} (${poItem.item_description}) is a goods line. Record a GRN, not a service entry sheet.`
      );
    }

    const ordered = toQty(poItem.quantity);
    const already = toQty(poItem.quantity_accepted);
    const cumulative = already + qty;
    if (cumulative > ordered) {
      overages.push({
        po_item_id: poItem.id,
        description: poItem.item_description,
        ordered,
        already,
        accepting: qty,
        cumulative
      });
    }

    validItems.push({
      po_item_id: poItem.id,
      quantity_accepted: qty,
      amount_cents: lineTotalCents(qty, poItem.unit_price),
      comments: item.comments || null,
      description: poItem.item_description
    });
  }

  return { overages, validItems };
}

/**
 * Create an SES against an open PO. Only service lines are allowed.
 * Status is draft unless `submitImmediately` is true.
 * Quantity is not applied to the PO until accept.
 */
export async function createServiceEntrySheet(db, payload) {
  const {
    po_id,
    created_by,
    service_period_start,
    service_period_end,
    notes,
    items,
    submitImmediately,
    actor_name
  } = payload;

  if (!items || items.length === 0) {
    throw new ServiceEntrySheetError('Service entry sheet must include at least one accepted line.');
  }

  const po = await db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(po_id);
  if (!po) {
    throw new ServiceEntrySheetError('Purchase Order not found', 404);
  }
  if (po.status === 'cancelled' || po.status === 'closed') {
    throw new ServiceEntrySheetError(`Cannot create an SES against a ${po.status} purchase order.`);
  }

  return db.transaction(async () => {
    const { validItems } = await collectOverAcceptances(db, po_id, items);
    if (validItems.length === 0) {
      throw new ServiceEntrySheetError('Service entry sheet must include at least one accepted quantity greater than 0.');
    }

    const currentYear = new Date().getFullYear();
    const sesNumber = await nextDocumentNumber(db, 'ses', currentYear);
    const status = isExplicitTrue(submitImmediately) ? 'submitted' : 'draft';

    const insertSes = db.prepare(`
      INSERT INTO service_entry_sheets (
        ses_number, po_id, created_by, status, service_period_start, service_period_end, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = await insertSes.run(
      sesNumber,
      po_id,
      created_by || 1,
      status,
      service_period_start || null,
      service_period_end || null,
      notes || null
    );
    const sesId = result.lastInsertRowid;

    const insertItem = db.prepare(`
      INSERT INTO service_entry_sheet_items (ses_id, po_item_id, quantity_accepted, amount_cents, comments)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const item of validItems) {
      await insertItem.run(sesId, item.po_item_id, item.quantity_accepted, item.amount_cents, item.comments);
    }

    const actor = actor_name || 'Requester';
    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('service_entry_sheet', ?, 'CREATED', ?, ?)
    `).run(
      sesId,
      actor,
      `Created ${sesNumber} for PO ${po.po_number} (${validItems.length} service line(s), status ${status})`
    );

    if (status === 'submitted') {
      await db.prepare(`
        INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
        VALUES ('service_entry_sheet', ?, 'SUBMITTED', ?, ?)
      `).run(sesId, actor, `Submitted ${sesNumber} for acceptance`);
    }

    return { sesId, sesNumber, status };
  });
}

export async function submitServiceEntrySheet(db, sesId, { actor_name } = {}) {
  return db.transaction(async () => {
    const ses = await loadSesOrThrow(db, sesId);
    if (ses.status !== 'draft') {
      throw new ServiceEntrySheetError(`Only draft service entry sheets can be submitted (current status: ${ses.status}).`);
    }

    await db.prepare(`UPDATE service_entry_sheets SET status = 'submitted' WHERE id = ?`).run(sesId);
    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('service_entry_sheet', ?, 'SUBMITTED', ?, ?)
    `).run(sesId, actor_name || 'Requester', `Submitted ${ses.ses_number} for acceptance`);

    return { sesId, sesNumber: ses.ses_number, status: 'submitted' };
  });
}

/**
 * Accept a submitted SES. Increments po_items.quantity_accepted.
 * Over-acceptance is blocked unless `allow_over_acceptance` is true (audited).
 */
export async function acceptServiceEntrySheet(db, sesId, payload = {}) {
  const { decided_by, actor_name, decision_comments, allow_over_acceptance } = payload;
  const allowOver = isExplicitTrue(allow_over_acceptance);

  return db.transaction(async () => {
    const ses = await loadSesOrThrow(db, sesId);
    if (ses.status !== 'submitted') {
      throw new ServiceEntrySheetError(`Only submitted service entry sheets can be accepted (current status: ${ses.status}).`);
    }

    const po = await db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(ses.po_id);
    const items = await db.prepare(`SELECT * FROM service_entry_sheet_items WHERE ses_id = ?`).all(sesId);
    const { overages, validItems } = await collectOverAcceptances(db, ses.po_id, items);

    if (overages.length > 0 && !allowOver) {
      const detail = overages
        .map((o) => `${o.description || `line ${o.po_item_id}`}: ${o.cumulative} accepted vs ${o.ordered} ordered`)
        .join('; ');
      throw new ServiceEntrySheetError(
        `Over-acceptance is not allowed without allow_over_acceptance: true. ${detail}`
      );
    }

    const updatePOItem = db.prepare(`
      UPDATE po_items
      SET quantity_accepted = quantity_accepted + ?
      WHERE id = ?
    `);
    let totalAccepted = 0;
    for (const item of validItems) {
      await updatePOItem.run(item.quantity_accepted, item.po_item_id);
      totalAccepted += item.quantity_accepted;
    }

    await db.prepare(`
      UPDATE service_entry_sheets
      SET status = 'accepted', decided_by = ?, decided_at = CURRENT_TIMESTAMP, decision_comments = ?
      WHERE id = ?
    `).run(decided_by || null, decision_comments || null, sesId);

    const newPOStatus = await refreshPoFulfillmentStatus(db, ses.po_id);
    const actor = actor_name || 'Procurement Officer';

    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('service_entry_sheet', ?, 'ACCEPTED', ?, ?)
    `).run(
      sesId,
      actor,
      `Accepted ${ses.ses_number} for PO ${po?.po_number || ses.po_id} (${totalAccepted} units)`
    );

    if (overages.length > 0 && allowOver) {
      const overageDetail = overages
        .map((o) => `${o.description || `line ${o.po_item_id}`}: cumulative ${o.cumulative} vs ordered ${o.ordered}`)
        .join('; ');
      await db.prepare(`
        INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
        VALUES ('service_entry_sheet', ?, 'OVER_ACCEPTANCE_OVERRIDE', ?, ?)
      `).run(
        sesId,
        actor,
        `Explicit over-acceptance override on ${ses.ses_number} for PO ${po?.po_number || ses.po_id}. ${overageDetail}`
      );
    }

    return {
      sesId,
      sesNumber: ses.ses_number,
      status: 'accepted',
      newPOStatus,
      overAcceptance: overages.length > 0
    };
  });
}

export async function rejectServiceEntrySheet(db, sesId, payload = {}) {
  const { decided_by, actor_name, decision_comments } = payload;

  return db.transaction(async () => {
    const ses = await loadSesOrThrow(db, sesId);
    if (ses.status !== 'submitted') {
      throw new ServiceEntrySheetError(`Only submitted service entry sheets can be rejected (current status: ${ses.status}).`);
    }

    await db.prepare(`
      UPDATE service_entry_sheets
      SET status = 'rejected', decided_by = ?, decided_at = CURRENT_TIMESTAMP, decision_comments = ?
      WHERE id = ?
    `).run(decided_by || null, decision_comments || null, sesId);

    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('service_entry_sheet', ?, 'REJECTED', ?, ?)
    `).run(
      sesId,
      actor_name || 'Procurement Officer',
      `Rejected ${ses.ses_number}${decision_comments ? `: ${decision_comments}` : ''}`
    );

    return { sesId, sesNumber: ses.ses_number, status: 'rejected' };
  });
}
