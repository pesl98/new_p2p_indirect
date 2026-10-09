/**
 * Requisition writes shared by the HTTP route and the sourcing award.
 * createRequisition is the route's transaction, unchanged in behaviour.
 * insertAwardRequisition runs inside the caller's transaction: one multi-row
 * line insert, so 50 awarded lines stay inside the statement budget.
 */

import { insertApprovalChain } from './approvalPolicy.js';
import { assignContractToRequisition } from './contractAssignment.js';
import { nextDocumentNumber } from './docNumbers.js';
import { normalizeLineType, resolveServiceBasis } from './lineType.js';
import { asCents, formatMoney, lineTotalCents, toQty } from './money.js';

const SQL_VARIABLE_BUDGET = 900;

async function allocatedId(db, result, table, column, value) {
  let id = Number(result.lastInsertRowid);
  if (!id) {
    const created = await db.prepare(
      `SELECT id FROM ${table} WHERE ${column} = ?`
    ).get(value);
    id = Number(created?.id || 0);
  }
  if (!id) {
    const error = new Error('Failed to allocate requisition id after insert');
    error.statusCode = 500;
    throw error;
  }
  return id;
}

async function insertItemRows(db, columns, rows) {
  if (!rows.length) return;
  const chunkSize = Math.max(1, Math.floor(SQL_VARIABLE_BUDGET / columns.length));
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const tuples = chunk.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
    await db.prepare(
      `INSERT INTO requisition_items (${columns.join(', ')}) VALUES ${tuples}`
    ).run(...chunk.flat());
  }
}

export async function createRequisition(db, input) {
  const {
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
  } = input;
  const calculatedTotal = items.reduce(
    (acc, item) => acc + lineTotalCents(item.quantity, item.unit_price),
    0
  );
  return db.transaction(async () => {
    const currentYear = new Date().getFullYear();
    const prNumber = await nextDocumentNumber(db, 'pr', currentYear);
    const status = submitImmediately ? 'pending_approval' : 'draft';
    const prResult = await db.prepare(`
      INSERT INTO purchase_requisitions (pr_number, requester_id, department_id, status, total_amount, justification, needed_by_date, priority, source_contract_id, contract_use_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'none')
    `).run(
      prNumber,
      requester_id,
      department_id,
      status,
      calculatedTotal,
      justification || 'General operational procurement requirement',
      needed_by_date || new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0],
      priority || 'Medium'
    );
    const prId = await allocatedId(db, prResult, 'purchase_requisitions', 'pr_number', prNumber);
    const insertItem = db.prepare(`
      INSERT INTO requisition_items (requisition_id, catalog_item_id, item_description, category, quantity, unit_price, total_price, estimated_supplier_id, line_type, service_basis)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of items) {
      const qty = toQty(item.quantity);
      const unitPrice = asCents(item.unit_price);
      const category = item.category || 'Office Supplies';
      const lineType = normalizeLineType(item.line_type, category);
      await insertItem.run(
        prId,
        item.catalog_item_id || null,
        item.item_description,
        category,
        qty,
        unitPrice,
        lineTotalCents(qty, unitPrice),
        item.estimated_supplier_id || 1,
        lineType,
        resolveServiceBasis(item.service_basis, lineType)
      );
    }
    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('requisition', ?, 'CREATED', ?, ?)
    `).run(prId, actor_name, `Requisition ${prNumber} created with ${items.length} item(s) for ${formatMoney(calculatedTotal)}`);
    const assignment = await assignContractToRequisition(db, prId, {
      source_contract_id,
      skip_contract_match,
      actor_name,
      today
    });
    if (submitImmediately) {
      await insertApprovalChain(db, prId, calculatedTotal, department_id);
      await db.prepare(`
        INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
        VALUES ('requisition', ?, 'SUBMITTED', ?, 'Submitted for multi-tier approval routing')
      `).run(prId, actor_name);
    }
    return { prId, assignment, prNumber, total: calculatedTotal };
  });
}

/**
 * Award requisition. Caller is already inside immediateTransaction.
 * contract_use_status is skipped so submit-time matching cannot attach a contract.
 */
export async function insertAwardRequisition(db, {
  requesterId,
  departmentId,
  justification,
  items,
  actorName,
  excludeUserIds = [],
  neededBy = null,
  steps: prebuiltSteps = null
}) {
  const total = items.reduce((sum, item) => sum + Number(item.total_price), 0);
  const year = new Date().getFullYear();
  const prNumber = await nextDocumentNumber(db, 'pr', year);
  const needed = neededBy || new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0];
  const prResult = await db.prepare(`
    INSERT INTO purchase_requisitions (
      pr_number, requester_id, department_id, status, total_amount, justification,
      needed_by_date, priority, source_contract_id, contract_use_status
    ) VALUES (?, ?, ?, 'pending_approval', ?, ?, ?, 'Medium', NULL, 'skipped')
  `).run(prNumber, requesterId, departmentId, total, justification, needed);
  const prId = await allocatedId(db, prResult, 'purchase_requisitions', 'pr_number', prNumber);
  const columns = [
    'requisition_id', 'catalog_item_id', 'item_description', 'category', 'quantity',
    'unit_price', 'total_price', 'estimated_supplier_id', 'line_type', 'service_basis'
  ];
  await insertItemRows(db, columns, items.map((item) => [
    prId,
    item.catalog_item_id || null,
    item.item_description,
    item.category,
    item.quantity,
    item.unit_price,
    item.total_price,
    item.estimated_supplier_id,
    item.line_type,
    item.service_basis
  ]));
  const steps = Array.isArray(prebuiltSteps) && prebuiltSteps.length
    ? prebuiltSteps
    : await insertApprovalChain(db, prId, total, departmentId, { excludeUserIds });
  if (Array.isArray(prebuiltSteps) && prebuiltSteps.length) {
    const tuples = steps.map(() => '(?, ?, ?, ?)').join(', ');
    await db.prepare(`
      INSERT INTO approval_requests (requisition_id, approver_id, step_order, status)
      VALUES ${tuples}
    `).run(...steps.flatMap((step) => [
      prId,
      step.approver_id,
      step.step_order,
      Number(step.step_order) === 1 ? 'pending' : 'waiting'
    ]));
  }
  await db.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
    VALUES ('requisition', ?, 'CREATED', ?, ?)
  `).run(
    prId,
    actorName,
    `Requisition ${prNumber} created with ${items.length} item(s) for ${formatMoney(total)}`
  );
  await db.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
    VALUES ('requisition', ?, 'SUBMITTED', ?, 'Submitted for multi-tier approval routing')
  `).run(prId, actorName);
  return { prId, prNumber, total, steps };
}
