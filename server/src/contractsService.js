import { nextDocumentNumber } from './docNumbers.js';
import { asCents, formatCents, lineTotalCents, toQty } from './money.js';
import { normalizeLineType } from './lineType.js';
import { insertApprovalChain } from './approvalPolicy.js';

export class ContractError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ContractError';
    this.statusCode = statusCode;
  }
}

/**
 * Computes dynamic status and countdown days for a contract:
 * - expired if today > end_date
 * - expiring_soon if within notice_period_days of end_date
 * - active otherwise (unless explicitly cancelled)
 */
export function computeContractStatus(contract, todayStr = new Date().toISOString().split('T')[0]) {
  if (contract.status === 'cancelled') return 'cancelled';
  const today = new Date(todayStr);
  const end = new Date(contract.end_date);
  const diffDays = Math.ceil((end - today) / (1000 * 60 * 60 * 24));

  if (diffDays < 0) return 'expired';
  if (diffDays <= (contract.notice_period_days || 30)) return 'expiring_soon';
  return 'active';
}

export async function listContracts(db, { category, status, search } = {}) {
  let query = `
    SELECT 
      c.*,
      s.name as supplier_name,
      s.code as supplier_code,
      d.name as department_name,
      d.code as department_code,
      (SELECT COUNT(*) FROM contract_items WHERE contract_id = c.id) as item_count
    FROM contracts c
    JOIN suppliers s ON c.supplier_id = s.id
    JOIN departments d ON c.department_id = d.id
    WHERE 1=1
  `;
  const params = [];

  if (category && category !== 'All') {
    query += ` AND c.category = ?`;
    params.push(category);
  }

  if (search) {
    query += ` AND (c.contract_number LIKE ? OR c.title LIKE ? OR s.name LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  query += ` ORDER BY c.end_date ASC`;
  const contracts = await db.prepare(query).all(...params);

  const todayStr = new Date().toISOString().split('T')[0];
  const today = new Date(todayStr);

  const enriched = contracts.map((c) => {
    const end = new Date(c.end_date);
    const daysUntilExpiry = Math.ceil((end - today) / (1000 * 60 * 60 * 24));
    const dynamicStatus = computeContractStatus(c, todayStr);
    return {
      ...c,
      status: dynamicStatus,
      days_until_expiry: daysUntilExpiry,
      notice_deadline: new Date(end.getTime() - ((c.notice_period_days || 30) * 86400000)).toISOString().split('T')[0]
    };
  });

  if (status && status !== 'all') {
    return enriched.filter((c) => c.status === status);
  }

  return enriched;
}

export async function getContractDetail(db, id) {
  const contract = await db.prepare(`
    SELECT 
      c.*,
      s.name as supplier_name,
      s.code as supplier_code,
      s.contact_person as supplier_contact,
      s.email as supplier_email,
      d.name as department_name,
      d.code as department_code
    FROM contracts c
    JOIN suppliers s ON c.supplier_id = s.id
    JOIN departments d ON c.department_id = d.id
    WHERE c.id = ?
  `).get(id);

  if (!contract) {
    throw new ContractError('Contract not found', 404);
  }

  const items = await db.prepare(`
    SELECT ci.*, cat.sku as catalog_sku
    FROM contract_items ci
    LEFT JOIN catalog_items cat ON ci.catalog_item_id = cat.id
    WHERE ci.contract_id = ?
    ORDER BY ci.id ASC
  `).all(id);

  const todayStr = new Date().toISOString().split('T')[0];
  const today = new Date(todayStr);
  const end = new Date(contract.end_date);
  const daysUntilExpiry = Math.ceil((end - today) / (1000 * 60 * 60 * 24));
  const dynamicStatus = computeContractStatus(contract, todayStr);

  return {
    ...contract,
    status: dynamicStatus,
    days_until_expiry: daysUntilExpiry,
    notice_deadline: new Date(end.getTime() - ((contract.notice_period_days || 30) * 86400000)).toISOString().split('T')[0],
    items
  };
}

export async function createContract(db, {
  supplier_id,
  department_id,
  title,
  category,
  start_date,
  end_date,
  notice_period_days = 30,
  annual_value_cents,
  auto_renew = 1,
  terms,
  items = []
}) {
  if (!supplier_id) throw new ContractError('supplier_id is required');
  if (!department_id) throw new ContractError('department_id is required');
  if (!title) throw new ContractError('Contract title is required');
  if (!start_date || !end_date) throw new ContractError('start_date and end_date are required');

  return await db.transaction(async () => {
    const currentYear = new Date().getFullYear();
    const contractNumber = await nextDocumentNumber(db, 'cnt', currentYear);

    const calculatedAnnualValue = items.length > 0
      ? items.reduce((sum, item) => sum + lineTotalCents(toQty(item.quantity), asCents(item.unit_price)), 0)
      : asCents(annual_value_cents || 0);

    const insertContract = db.prepare(`
      INSERT INTO contracts (
        contract_number, supplier_id, department_id, title, category,
        start_date, end_date, notice_period_days, annual_value_cents, auto_renew, status, terms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
    `);

    const result = await insertContract.run(
      contractNumber,
      supplier_id,
      department_id,
      title,
      category || 'Software & Cloud',
      start_date,
      end_date,
      notice_period_days,
      calculatedAnnualValue,
      auto_renew ? 1 : 0,
      terms || null
    );

    let contractId = Number(result.lastInsertRowid);
    if (!contractId) {
      const row = await db.prepare(`SELECT id FROM contracts WHERE contract_number = ?`).get(contractNumber);
      contractId = Number(row?.id || 0);
    }

    if (items.length > 0) {
      const insertItem = db.prepare(`
        INSERT INTO contract_items (
          contract_id, catalog_item_id, description, quantity, unit_price, total_price, line_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const item of items) {
        const qty = toQty(item.quantity);
        const unitPrice = asCents(item.unit_price);
        await insertItem.run(
          contractId,
          item.catalog_item_id || null,
          item.description,
          qty,
          unitPrice,
          lineTotalCents(qty, unitPrice),
          normalizeLineType(item.line_type, category)
        );
      }
    }

    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('contract', ?, 'CREATED', 'Contract Manager', ?)
    `).run(contractId, `Contract ${contractNumber} (${title}) created with ACV $${formatCents(calculatedAnnualValue)}`);

    return await getContractDetail(db, contractId);
  })();
}

/**
 * 1-Click Renewal Requisition Generator:
 * Turns an expiring or active recurring contract into an approval-routed Purchase Requisition!
 */
export async function createRenewalRequisition(db, contractId, { requester_id = 1, needed_by_date, notes } = {}) {
  return await db.transaction(async () => {
    const contract = await getContractDetail(db, contractId);
    const currentYear = new Date().getFullYear();
    const prNumber = await nextDocumentNumber(db, 'pr', currentYear);

    const prNeededDate = needed_by_date || contract.end_date || new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0];
    const justification = notes
      ? `Contract Renewal for ${contract.title} (${contract.contract_number}): ${notes}`
      : `Annual Contract Renewal for ${contract.title} (${contract.contract_number}). Renewal notice window: ${contract.notice_period_days} days.`;

    const insertPR = db.prepare(`
      INSERT INTO purchase_requisitions (
        pr_number, requester_id, department_id, status, total_amount, justification, needed_by_date, priority
      ) VALUES (?, ?, ?, 'pending_approval', ?, ?, ?, 'High')
    `);

    const prResult = await insertPR.run(
      prNumber,
      requester_id,
      contract.department_id,
      contract.annual_value_cents,
      justification,
      prNeededDate
    );

    let prId = Number(prResult.lastInsertRowid);
    if (!prId) {
      const row = await db.prepare(`SELECT id FROM purchase_requisitions WHERE pr_number = ?`).get(prNumber);
      prId = Number(row?.id || 0);
    }

    const insertItem = db.prepare(`
      INSERT INTO requisition_items (
        requisition_id, catalog_item_id, item_description, category, quantity, unit_price, total_price, estimated_supplier_id, line_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    if (contract.items && contract.items.length > 0) {
      for (const item of contract.items) {
        await insertItem.run(
          prId,
          item.catalog_item_id || null,
          item.description,
          contract.category,
          item.quantity,
          item.unit_price,
          item.total_price,
          contract.supplier_id,
          item.line_type || 'service'
        );
      }
    } else {
      await insertItem.run(
        prId,
        null,
        `Annual Renewal - ${contract.title}`,
        contract.category,
        1,
        contract.annual_value_cents,
        contract.annual_value_cents,
        contract.supplier_id,
        'service'
      );
    }

    await insertApprovalChain(db, prId, contract.annual_value_cents, contract.department_id);

    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('requisition', ?, 'RENEWAL_GENERATED', 'Contract Manager', ?)
    `).run(prId, `Generated renewal requisition ${prNumber} from contract ${contract.contract_number} for $${formatCents(contract.annual_value_cents)}`);

    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('contract', ?, 'RENEWAL_PR_CREATED', 'System', ?)
    `).run(contractId, `Renewal requisition ${prNumber} created and routed for approvals`);

    return {
      pr_id: prId,
      pr_number: prNumber,
      contract_id: contract.id,
      contract_number: contract.contract_number,
      total_amount_cents: contract.annual_value_cents,
      message: `Renewal Requisition ${prNumber} created successfully.`
    };
  })();
}

