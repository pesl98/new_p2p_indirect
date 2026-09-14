import { nextDocumentNumber } from './docNumbers.js';
import { formatCents, lineTotalCents, requireIntegerCents, toQty } from './money.js';
import { normalizeLineType } from './lineType.js';
import { insertApprovalChain } from './approvalPolicy.js';

export class ContractError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ContractError';
    this.statusCode = statusCode;
  }
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const RENEWABLE_STATUSES = new Set(['active', 'expiring_soon']);
const OPEN_RENEWAL_PR_STATUSES = new Set(['draft', 'pending_approval', 'approved']);
const CONTRACT_CATEGORIES = new Set([
  'Software & Cloud',
  'Consulting & Professional Services',
  'Facilities & MRO',
  'Office Supplies',
  'Marketing & Events',
  'Travel & Subscriptions',
  'IT Hardware'
]);

function utcTodayYmd(todayStr) {
  if (todayStr) {
    if (!YMD.test(todayStr)) {
      throw new ContractError('today must be YYYY-MM-DD');
    }
    return todayStr;
  }
  return new Date().toISOString().slice(0, 10);
}

function utcParts(ymd) {
  const [year, month, day] = ymd.split('-').map(Number);
  return { year, month, day };
}

/** Inclusive whole UTC calendar days from `fromYmd` to `toYmd`. */
export function utcCalendarDaysUntil(toYmd, fromYmd) {
  const to = utcParts(toYmd);
  const from = utcParts(fromYmd);
  const toUtc = Date.UTC(to.year, to.month - 1, to.day);
  const fromUtc = Date.UTC(from.year, from.month - 1, from.day);
  return Math.round((toUtc - fromUtc) / 86400000);
}

export function utcYmdPlusDays(ymd, days) {
  const { year, month, day } = utcParts(ymd);
  return new Date(Date.UTC(year, month - 1, day + Number(days))).toISOString().slice(0, 10);
}

function requireYmd(value, field) {
  if (!value || !YMD.test(String(value))) {
    throw new ContractError(`${field} must be YYYY-MM-DD`);
  }
  return String(value);
}

function requirePositiveId(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ContractError(`${field} is required`);
  }
  return n;
}

function centsField(value, field) {
  try {
    const cents = requireIntegerCents(value, field);
    if (cents < 0) {
      throw new ContractError(`${field} must be a non-negative integer number of cents`);
    }
    return cents;
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw new ContractError(error.message, error.statusCode || 400);
  }
}

export function computeContractStatus(contract, todayStr = utcTodayYmd()) {
  if (contract.status === 'cancelled') return 'cancelled';
  const today = utcTodayYmd(todayStr);
  const endDate = requireYmd(contract.end_date, 'end_date');
  const diffDays = utcCalendarDaysUntil(endDate, today);
  const notice = Number(contract.notice_period_days);
  const noticeDays = Number.isFinite(notice) && notice >= 0 ? notice : 30;

  if (diffDays < 0) return 'expired';
  if (diffDays <= noticeDays) return 'expiring_soon';
  return 'active';
}

function enrichContract(contract, todayStr) {
  const today = utcTodayYmd(todayStr);
  const endDate = requireYmd(contract.end_date, 'end_date');
  const notice = Number(contract.notice_period_days);
  const noticeDays = Number.isFinite(notice) && notice >= 0 ? notice : 30;
  const daysUntilExpiry = utcCalendarDaysUntil(endDate, today);
  return {
    ...contract,
    status: computeContractStatus(contract, today),
    days_until_expiry: daysUntilExpiry,
    notice_deadline: utcYmdPlusDays(endDate, -noticeDays)
  };
}

async function requireSupplier(db, supplierId) {
  const supplier = await db.prepare(`SELECT id, name, status FROM suppliers WHERE id = ?`).get(supplierId);
  if (!supplier) throw new ContractError('supplier_id does not match a supplier', 400);
  return supplier;
}

async function requireDepartment(db, departmentId) {
  const department = await db.prepare(`SELECT id, name, code FROM departments WHERE id = ?`).get(departmentId);
  if (!department) throw new ContractError('department_id does not match a department', 400);
  return department;
}

async function resolveActorName(db, { actor_name, requester_id } = {}) {
  const named = typeof actor_name === 'string' ? actor_name.trim() : '';
  if (named) return named;
  if (requester_id) {
    const user = await db.prepare(`SELECT id, name FROM users WHERE id = ?`).get(requester_id);
    if (user?.name) return user.name;
  }
  throw new ContractError('actor_name or a valid requester_id is required for audit');
}

function parseContractItems(items, category) {
  if (items == null) return [];
  if (!Array.isArray(items)) throw new ContractError('items must be an array');
  return items.map((item, index) => {
    const description = String(item?.description || '').trim();
    if (!description) {
      throw new ContractError(`items[${index}].description is required`);
    }
    const qty = toQty(item.quantity);
    if (qty <= 0) {
      throw new ContractError(`items[${index}].quantity must be a positive whole number`);
    }
    const unitPrice = centsField(item.unit_price, `items[${index}].unit_price`);
    return {
      catalog_item_id: item.catalog_item_id || null,
      description,
      quantity: qty,
      unit_price: unitPrice,
      total_price: lineTotalCents(qty, unitPrice),
      line_type: normalizeLineType(item.line_type, category)
    };
  });
}

export async function listContracts(db, { category, status, search, today } = {}) {
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
  const todayStr = utcTodayYmd(today);

  const enriched = contracts.map((c) => enrichContract(c, todayStr));

  if (status && status !== 'all') {
    return enriched.filter((c) => c.status === status);
  }

  return enriched;
}

export async function getContractDetail(db, id, { today } = {}) {
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

  return {
    ...enrichContract(contract, today),
    items
  };
}

export async function createContract(db, payload = {}) {
  const supplier_id = requirePositiveId(payload.supplier_id, 'supplier_id');
  const department_id = requirePositiveId(payload.department_id, 'department_id');
  const title = String(payload.title || '').trim();
  if (!title) throw new ContractError('Contract title is required');

  const category = payload.category || 'Software & Cloud';
  if (!CONTRACT_CATEGORIES.has(category)) {
    throw new ContractError('category is not a valid catalog category');
  }

  const start_date = requireYmd(payload.start_date, 'start_date');
  const end_date = requireYmd(payload.end_date, 'end_date');
  if (utcCalendarDaysUntil(end_date, start_date) < 0) {
    throw new ContractError('end_date must be on or after start_date');
  }

  let notice_period_days = 30;
  if (payload.notice_period_days !== undefined && payload.notice_period_days !== null && payload.notice_period_days !== '') {
    const notice = Number(payload.notice_period_days);
    if (!Number.isInteger(notice) || notice < 0) {
      throw new ContractError('notice_period_days must be a non-negative integer');
    }
    notice_period_days = notice;
  }

  const parsedItems = parseContractItems(payload.items, category);
  const calculatedAnnualValue = parsedItems.length > 0
    ? parsedItems.reduce((sum, item) => sum + item.total_price, 0)
    : centsField(payload.annual_value_cents, 'annual_value_cents');

  const auto_renew = payload.auto_renew ? 1 : 0;
  const actorName = await resolveActorName(db, payload);

  return await db.transaction(async () => {
    await requireSupplier(db, supplier_id);
    await requireDepartment(db, department_id);

    const currentYear = new Date().getFullYear();
    const contractNumber = await nextDocumentNumber(db, 'cnt', currentYear);

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
      category,
      start_date,
      end_date,
      notice_period_days,
      calculatedAnnualValue,
      auto_renew,
      payload.terms || null
    );

    let contractId = Number(result.lastInsertRowid);
    if (!contractId) {
      const row = await db.prepare(`SELECT id FROM contracts WHERE contract_number = ?`).get(contractNumber);
      contractId = Number(row?.id || 0);
    }
    if (!contractId) {
      throw new ContractError('Failed to allocate contract id after insert', 500);
    }

    if (parsedItems.length > 0) {
      const insertItem = db.prepare(`
        INSERT INTO contract_items (
          contract_id, catalog_item_id, description, quantity, unit_price, total_price, line_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const item of parsedItems) {
        await insertItem.run(
          contractId,
          item.catalog_item_id,
          item.description,
          item.quantity,
          item.unit_price,
          item.total_price,
          item.line_type
        );
      }
    }

    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('contract', ?, 'CREATED', ?, ?)
    `).run(
      contractId,
      actorName,
      `Contract ${contractNumber} (${title}) created with ACV ${calculatedAnnualValue} cents ($${formatCents(calculatedAnnualValue)})`
    );

    return await getContractDetail(db, contractId);
  })();
}

async function findOpenRenewalRequisition(db, contract) {
  const rows = await db.prepare(`
    SELECT id, pr_number, status, justification
    FROM purchase_requisitions
    WHERE source_contract_id = ?
       OR justification LIKE ?
    ORDER BY id DESC
  `).all(contract.id, `%${contract.contract_number}%`);
  return (rows || []).find((row) =>
    OPEN_RENEWAL_PR_STATUSES.has(row.status) &&
    /renewal/i.test(row.justification || '')
  ) || null;
}

/**
 * 1-click renewal requisition: copies contract lines into a PR and inserts
 * the existing sequential approval chain (insertApprovalChain).
 * Fail-closed: only active / expiring_soon contracts; supplier + department
 * required; integer cents only; refuses a second open renewal PR.
 */
export async function createRenewalRequisition(db, contractId, {
  requester_id,
  needed_by_date,
  notes,
  actor_name,
  today
} = {}) {
  const requesterId = requirePositiveId(requester_id, 'requester_id');

  return await db.transaction(async () => {
    const contract = await getContractDetail(db, contractId, { today });
    if (!RENEWABLE_STATUSES.has(contract.status)) {
      throw new ContractError(
        `Contract ${contract.contract_number} cannot be renewed while status is ${contract.status}`
      );
    }
    if (!contract.supplier_id) throw new ContractError('Contract is missing supplier_id');
    if (!contract.department_id) throw new ContractError('Contract is missing department_id');
    await requireSupplier(db, contract.supplier_id);
    await requireDepartment(db, contract.department_id);

    const acv = centsField(contract.annual_value_cents, 'annual_value_cents');
    const requester = await db.prepare(`SELECT id, name FROM users WHERE id = ?`).get(requesterId);
    if (!requester) throw new ContractError('requester_id does not match a user');
    const actorName = (typeof actor_name === 'string' && actor_name.trim()) || requester.name;

    const existing = await findOpenRenewalRequisition(db, contract);
    if (existing) {
      throw new ContractError(
        `Renewal requisition ${existing.pr_number} is already ${existing.status} for ${contract.contract_number}`
      );
    }

    const currentYear = new Date().getFullYear();
    const prNumber = await nextDocumentNumber(db, 'pr', currentYear);

    const prNeededDate = needed_by_date
      ? requireYmd(needed_by_date, 'needed_by_date')
      : contract.end_date;
    const justification = notes
      ? `Contract Renewal for ${contract.title} (${contract.contract_number}): ${notes}`
      : `Annual Contract Renewal for ${contract.title} (${contract.contract_number}). Renewal notice window: ${contract.notice_period_days} days.`;

    const insertPR = db.prepare(`
      INSERT INTO purchase_requisitions (
        pr_number, requester_id, department_id, status, total_amount, justification, needed_by_date, priority,
        source_contract_id, contract_use_status
      ) VALUES (?, ?, ?, 'pending_approval', ?, ?, ?, 'High', ?, 'proposed')
    `);

    const prResult = await insertPR.run(
      prNumber,
      requesterId,
      contract.department_id,
      acv,
      justification,
      prNeededDate,
      contract.id
    );

    let prId = Number(prResult.lastInsertRowid);
    if (!prId) {
      const row = await db.prepare(`SELECT id FROM purchase_requisitions WHERE pr_number = ?`).get(prNumber);
      prId = Number(row?.id || 0);
    }
    if (!prId) {
      throw new ContractError('Failed to allocate requisition id after insert', 500);
    }

    const insertItem = db.prepare(`
      INSERT INTO requisition_items (
        requisition_id, catalog_item_id, item_description, category, quantity, unit_price, total_price, estimated_supplier_id, line_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    if (contract.items && contract.items.length > 0) {
      for (const item of contract.items) {
        const qty = toQty(item.quantity);
        const unitPrice = centsField(item.unit_price, 'unit_price');
        await insertItem.run(
          prId,
          item.catalog_item_id || null,
          item.description,
          contract.category,
          qty,
          unitPrice,
          lineTotalCents(qty, unitPrice),
          contract.supplier_id,
          normalizeLineType(item.line_type, contract.category)
        );
      }
    } else {
      await insertItem.run(
        prId,
        null,
        `Annual Renewal - ${contract.title}`,
        contract.category,
        1,
        acv,
        acv,
        contract.supplier_id,
        normalizeLineType('service', contract.category)
      );
    }

    await insertApprovalChain(db, prId, acv, contract.department_id);

    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('requisition', ?, 'CONTRACT_PROPOSED', ?, ?)
    `).run(
      prId,
      actorName,
      `Proposed ${contract.contract_number} (${contract.title}) from 1-click renewal. ` +
      `ACV ${acv} cents ($${formatCents(acv)}). Approver must allow or refuse contract use.`
    );

    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('requisition', ?, 'SUBMITTED', ?, ?)
    `).run(
      prId,
      actorName,
      `Renewal requisition ${prNumber} submitted from contract ${contract.contract_number} for ${acv} cents ($${formatCents(acv)})`
    );

    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('contract', ?, 'RENEWAL_PR_CREATED', ?, ?)
    `).run(
      contractId,
      actorName,
      `Renewal requisition ${prNumber} created and routed for sequential approvals (${acv} cents)`
    );

    return {
      pr_id: prId,
      pr_number: prNumber,
      contract_id: contract.id,
      contract_number: contract.contract_number,
      source_contract_id: contract.id,
      contract_use_status: 'proposed',
      total_amount_cents: acv,
      message: `Renewal Requisition ${prNumber} created successfully.`
    };
  })();
}
