/**
 * Automatic PR → contract assignment.
 *
 * Matching is best-effort and never blocks requisition create/submit.
 * A hit stores source_contract_id with contract_use_status = 'proposed'.
 * Explicit opt-out (skip_contract_match or draft clear) stores 'skipped'
 * so a later submit does not rematch. Status 'none' means unmatched so far
 * and submit may still auto-match.
 * The approver must allow or refuse contract use on the first approve
 * of a proposed link; refuse does not reject the PR (it becomes ad-hoc).
 */

import { computeContractStatus } from './contractsService.js';
import { formatCents } from './money.js';

export class ContractAssignmentError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ContractAssignmentError';
    this.statusCode = statusCode;
  }
}

export const CONTRACT_USE_NONE = 'none';
export const CONTRACT_USE_PROPOSED = 'proposed';
export const CONTRACT_USE_ALLOWED = 'allowed';
export const CONTRACT_USE_REFUSED = 'refused';
export const CONTRACT_USE_SKIPPED = 'skipped';

export const CONTRACT_USE_STATUSES = new Set([
  CONTRACT_USE_NONE,
  CONTRACT_USE_PROPOSED,
  CONTRACT_USE_ALLOWED,
  CONTRACT_USE_REFUSED,
  CONTRACT_USE_SKIPPED
]);

const ASSIGNABLE_STATUSES = new Set(['active', 'expiring_soon']);
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function utcTodayYmd(todayStr) {
  if (todayStr) {
    if (!YMD.test(String(todayStr))) {
      throw new ContractAssignmentError('today must be YYYY-MM-DD');
    }
    return String(todayStr);
  }
  return new Date().toISOString().slice(0, 10);
}

function isExplicitTrue(value) {
  return value === true || value === 1 || value === 'true' || value === '1';
}

function isExplicitFalse(value) {
  return value === false || value === 0 || value === 'false' || value === '0';
}

/** Parse allow_contract_use. Returns true / false / undefined (missing). */
export function parseAllowContractUse(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (isExplicitTrue(value)) return true;
  if (isExplicitFalse(value)) return false;
  return undefined;
}

export function resolveLineSupplierId(line) {
  if (line?.estimated_supplier_id != null && line.estimated_supplier_id !== '') {
    const n = Number(line.estimated_supplier_id);
    if (Number.isInteger(n) && n > 0) return n;
  }
  if (line?.catalog_preferred_supplier_id != null && line.catalog_preferred_supplier_id !== '') {
    const n = Number(line.catalog_preferred_supplier_id);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

/** Majority supplier by line count; ties break to the lower supplier id. */
export function majoritySupplierId(supplierIds) {
  const counts = new Map();
  for (const id of supplierIds) {
    if (id == null) continue;
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) continue;
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [id, count] of counts) {
    if (count > bestCount || (count === bestCount && (best == null || id < best))) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}

function catalogIdSet(lines) {
  const ids = new Set();
  for (const line of lines || []) {
    const id = Number(line.catalog_item_id);
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  return ids;
}

function categorySet(lines) {
  const cats = new Set();
  for (const line of lines || []) {
    if (line?.category) cats.add(String(line.category));
  }
  return cats;
}

/**
 * Score an eligible contract against PR lines.
 *
 * +100 supplier appears on any line
 * +20  that supplier is the majority vendor
 * +40  contract.category overlaps a line category
 * +50  contract_items.catalog_item_id overlaps a line catalog item
 *
 * Tie-break (applied after score): nearest end_date, then highest ACV, then id.
 */
export function scoreContractCandidate(contract, context) {
  const supplierIds = context.supplierIds || [];
  const majority = context.majoritySupplierId;
  const categories = context.categories instanceof Set ? context.categories : new Set(context.categories || []);
  const catalogIds = context.catalogItemIds instanceof Set
    ? context.catalogItemIds
    : new Set(context.catalogItemIds || []);

  let score = 0;
  const reasons = [];
  const contractSupplier = Number(contract.supplier_id);
  const supplierMatch = supplierIds.includes(contractSupplier);
  if (supplierMatch) {
    score += 100;
    reasons.push('supplier');
    if (majority != null && contractSupplier === majority) {
      score += 20;
      reasons.push('majority_supplier');
    }
  }

  const categoryMatch = categories.has(contract.category);
  if (categoryMatch) {
    score += 40;
    reasons.push('category');
  }

  const itemIds = (contract.item_catalog_ids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0);
  const catalogOverlap = itemIds.some((id) => catalogIds.has(id));
  if (catalogOverlap) {
    score += 50;
    reasons.push('catalog_item');
  }

  return { score, reasons, supplierMatch, categoryMatch, catalogOverlap };
}

/**
 * Confident enough to auto-propose:
 * - any supplier match, or
 * - catalog-item overlap, or
 * - unique category match (exactly one eligible contract in those categories).
 * Category-only with multiple candidates is ambiguous → leave unassigned.
 */
export function isConfidentMatch(scored, { uniqueCategoryMatch } = {}) {
  if (!scored || scored.score <= 0) return false;
  if (scored.supplierMatch) return true;
  if (scored.catalogOverlap) return true;
  if (scored.categoryMatch && uniqueCategoryMatch) return true;
  return false;
}

function compareCandidates(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const daysA = Number.isFinite(a.days_until_expiry) ? a.days_until_expiry : 99999;
  const daysB = Number.isFinite(b.days_until_expiry) ? b.days_until_expiry : 99999;
  if (daysA !== daysB) return daysA - daysB;
  const acvA = Number(a.annual_value_cents) || 0;
  const acvB = Number(b.annual_value_cents) || 0;
  if (acvB !== acvA) return acvB - acvA;
  return Number(a.id) - Number(b.id);
}

async function loadContractsWithItems(db) {
  const contracts = await db.prepare(`
    SELECT
      c.*,
      s.name as supplier_name,
      s.code as supplier_code
    FROM contracts c
    JOIN suppliers s ON c.supplier_id = s.id
  `).all();
  const items = await db.prepare(`
    SELECT contract_id, catalog_item_id FROM contract_items
  `).all();
  const byContract = new Map();
  for (const item of items || []) {
    const list = byContract.get(item.contract_id) || [];
    list.push(item.catalog_item_id);
    byContract.set(item.contract_id, list);
  }
  return (contracts || []).map((contract) => ({
    ...contract,
    item_catalog_ids: byContract.get(contract.id) || []
  }));
}

function matchContextFromLines(lines) {
  const supplierIds = [];
  for (const line of lines || []) {
    const id = resolveLineSupplierId(line);
    if (id != null) supplierIds.push(id);
  }
  return {
    supplierIds,
    majoritySupplierId: majoritySupplierId(supplierIds),
    categories: categorySet(lines),
    catalogItemIds: catalogIdSet(lines)
  };
}

/**
 * Pick the best eligible contract for these PR lines, or null.
 * Fail-soft: returns null when nothing is confident enough.
 */
export function pickBestContract(contracts, lines, { today } = {}) {
  const todayStr = utcTodayYmd(today);
  const context = matchContextFromLines(lines);
  const eligible = [];
  for (const contract of contracts || []) {
    let status;
    try {
      status = computeContractStatus(contract, todayStr);
    } catch {
      continue;
    }
    if (!ASSIGNABLE_STATUSES.has(status)) continue;
    const scored = scoreContractCandidate(contract, context);
    eligible.push({
      ...contract,
      status,
      days_until_expiry: computeDaysUntilExpiry(contract, todayStr),
      ...scored
    });
  }

  const categoryHits = eligible.filter((c) => c.categoryMatch);
  const uniqueCategoryMatch = categoryHits.length === 1;

  const ranked = eligible
    .filter((c) => isConfidentMatch(c, { uniqueCategoryMatch }))
    .sort(compareCandidates);

  return ranked[0] || null;
}

function computeDaysUntilExpiry(contract, todayStr) {
  try {
    const enriched = computeContractStatus(contract, todayStr);
    if (enriched === 'expired' || enriched === 'cancelled') return 99999;
  } catch {
    return 99999;
  }
  const end = String(contract.end_date || '');
  if (!YMD.test(end) || !YMD.test(todayStr)) return 99999;
  const [ey, em, ed] = end.split('-').map(Number);
  const [ty, tm, td] = todayStr.split('-').map(Number);
  const toUtc = Date.UTC(ey, em - 1, ed);
  const fromUtc = Date.UTC(ty, tm - 1, td);
  return Math.round((toUtc - fromUtc) / 86400000);
}

export async function loadRequisitionLinesForMatch(db, prId) {
  return db.prepare(`
    SELECT
      ri.estimated_supplier_id,
      ri.category,
      ri.catalog_item_id,
      ci.preferred_supplier_id as catalog_preferred_supplier_id
    FROM requisition_items ri
    LEFT JOIN catalog_items ci ON ri.catalog_item_id = ci.id
    WHERE ri.requisition_id = ?
  `).all(prId);
}

export async function matchContractForLines(db, lines, { today } = {}) {
  if (!lines || lines.length === 0) return null;
  const hydrated = [];
  for (const line of lines) {
    let preferred = line.catalog_preferred_supplier_id;
    if ((preferred == null || preferred === '') && line.catalog_item_id) {
      const cat = await db.prepare(
        `SELECT preferred_supplier_id FROM catalog_items WHERE id = ?`
      ).get(line.catalog_item_id);
      preferred = cat?.preferred_supplier_id ?? null;
    }
    hydrated.push({ ...line, catalog_preferred_supplier_id: preferred });
  }
  const contracts = await loadContractsWithItems(db);
  return pickBestContract(contracts, hydrated, { today });
}

export async function matchContractForRequisition(db, prId, { today } = {}) {
  const lines = await loadRequisitionLinesForMatch(db, prId);
  return matchContractForLines(db, lines, { today });
}

function proposedAuditDetails(contract, extra = '') {
  const acv = Number(contract.annual_value_cents) || 0;
  const base = `Proposed ${contract.contract_number} (${contract.title || 'contract'}) ` +
    `supplier=${contract.supplier_name || contract.supplier_id} ` +
    `ACV ${acv} cents ($${formatCents(acv)}) ` +
    `${contract.start_date || '?'} → ${contract.end_date || '?'}`;
  return extra ? `${base}. ${extra}` : base;
}

export async function writeProposedContractLink(db, {
  prId,
  contract,
  actorName = 'System',
  reason = 'auto-match'
}) {
  await db.prepare(`
    UPDATE purchase_requisitions
    SET source_contract_id = ?, contract_use_status = 'proposed', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(contract.id, prId);

  await db.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
    VALUES ('requisition', ?, 'CONTRACT_PROPOSED', ?, ?)
  `).run(
    prId,
    actorName,
    proposedAuditDetails(contract, `reason=${reason}`)
  );
}

export async function writeClearedContractLink(db, { prId, actorName = 'System', previousContractNumber }) {
  await db.prepare(`
    UPDATE purchase_requisitions
    SET source_contract_id = NULL, contract_use_status = 'skipped', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(prId);

  await db.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
    VALUES ('requisition', ?, 'CONTRACT_CLEARED', ?, ?)
  `).run(
    prId,
    actorName,
    previousContractNumber
      ? `Cleared contract link ${previousContractNumber}; requester opted out of auto-match.`
      : 'Requester opted out of contract auto-match; requisition stays ad-hoc.'
  );
}

async function loadAssignableContract(db, contractId, { today } = {}) {
  const id = Number(contractId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ContractAssignmentError('source_contract_id must be a positive integer');
  }
  const contract = await db.prepare(`
    SELECT
      c.*,
      s.name as supplier_name,
      s.code as supplier_code
    FROM contracts c
    JOIN suppliers s ON c.supplier_id = s.id
    WHERE c.id = ?
  `).get(id);
  if (!contract) {
    throw new ContractAssignmentError('source_contract_id does not match a contract', 400);
  }
  const status = computeContractStatus(contract, today);
  if (!ASSIGNABLE_STATUSES.has(status)) {
    throw new ContractAssignmentError(
      `Contract ${contract.contract_number} cannot be assigned while status is ${status}`
    );
  }
  return { ...contract, status };
}

/**
 * Apply assignment after PR lines exist. Never throws on auto-match failure.
 * Explicit source_contract_id is fail-closed (invalid id / not assignable).
 */
export async function assignContractToRequisition(db, prId, {
  source_contract_id,
  skip_contract_match,
  actor_name,
  today
} = {}) {
  if (isExplicitTrue(skip_contract_match)) {
    const existing = await db.prepare(
      `SELECT source_contract_id FROM purchase_requisitions WHERE id = ?`
    ).get(prId);
    let previousNumber = null;
    if (existing?.source_contract_id) {
      const prev = await db.prepare(
        `SELECT contract_number FROM contracts WHERE id = ?`
      ).get(existing.source_contract_id);
      previousNumber = prev?.contract_number || null;
    }
    await writeClearedContractLink(db, {
      prId,
      actorName: (typeof actor_name === 'string' && actor_name.trim()) || 'System',
      previousContractNumber: previousNumber
    });
    return { source_contract_id: null, contract_use_status: CONTRACT_USE_SKIPPED, match: null };
  }

  const actorName = (typeof actor_name === 'string' && actor_name.trim()) || 'System';

  if (source_contract_id != null && source_contract_id !== '') {
    const contract = await loadAssignableContract(db, source_contract_id, { today });
    await writeProposedContractLink(db, {
      prId,
      contract,
      actorName,
      reason: 'explicit'
    });
    return {
      source_contract_id: contract.id,
      contract_use_status: CONTRACT_USE_PROPOSED,
      match: contract
    };
  }

  try {
    const match = await matchContractForRequisition(db, prId, { today });
    if (!match) {
      return { source_contract_id: null, contract_use_status: CONTRACT_USE_NONE, match: null };
    }
    await writeProposedContractLink(db, {
      prId,
      contract: match,
      actorName,
      reason: `auto-match score=${match.score} [${(match.reasons || []).join(',')}]`
    });
    return {
      source_contract_id: match.id,
      contract_use_status: CONTRACT_USE_PROPOSED,
      match
    };
  } catch (error) {
    if (error instanceof ContractAssignmentError) throw error;
    console.error('Contract auto-match failed; leaving requisition unassigned:', error);
    return { source_contract_id: null, contract_use_status: CONTRACT_USE_NONE, match: null };
  }
}

/**
 * Draft override: set, replace, or clear the proposed contract before submit.
 */
export async function updateDraftContractLink(db, prId, {
  source_contract_id,
  actor_name,
  today
} = {}) {
  const pr = await db.prepare(`SELECT * FROM purchase_requisitions WHERE id = ?`).get(prId);
  if (!pr) throw new ContractAssignmentError('Requisition not found', 404);
  if (pr.status !== 'draft') {
    throw new ContractAssignmentError('Contract link can only be changed on a draft requisition');
  }

  const actorName = (typeof actor_name === 'string' && actor_name.trim()) || 'Requester';
  const previousNumber = pr.source_contract_id
    ? (await db.prepare(`SELECT contract_number FROM contracts WHERE id = ?`).get(pr.source_contract_id))?.contract_number
    : null;

  if (source_contract_id === null || source_contract_id === '' || source_contract_id === 0) {
    await writeClearedContractLink(db, { prId, actorName, previousContractNumber: previousNumber });
    return { source_contract_id: null, contract_use_status: CONTRACT_USE_SKIPPED };
  }

  const contract = await loadAssignableContract(db, source_contract_id, { today });
  await writeProposedContractLink(db, {
    prId,
    contract,
    actorName,
    reason: 'draft-override'
  });
  return { source_contract_id: contract.id, contract_use_status: CONTRACT_USE_PROPOSED, match: contract };
}

export const SOURCE_CONTRACT_JOIN_SQL = `
      LEFT JOIN contracts src_c ON pr.source_contract_id = src_c.id
      LEFT JOIN suppliers src_s ON src_c.supplier_id = src_s.id
`;

export const SOURCE_CONTRACT_SELECT_SQL = `
      src_c.contract_number as source_contract_number,
      src_c.title as source_contract_title,
      src_c.category as source_contract_category,
      src_c.supplier_id as source_contract_supplier_id,
      src_c.start_date as source_contract_start_date,
      src_c.end_date as source_contract_end_date,
      src_c.annual_value_cents as source_contract_annual_value_cents,
      src_c.notice_period_days as source_contract_notice_period_days,
      src_c.status as source_contract_stored_status,
      src_s.name as source_contract_supplier_name,
      src_s.code as source_contract_supplier_code
`;

export function nestSourceContract(row, { today } = {}) {
  if (!row) return row;
  const status = row.contract_use_status || CONTRACT_USE_NONE;
  if (!row.source_contract_id) {
    return {
      ...row,
      contract_use_status: status,
      source_contract: null
    };
  }

  let liveStatus = row.source_contract_stored_status || null;
  if (row.source_contract_end_date) {
    try {
      liveStatus = computeContractStatus({
        status: row.source_contract_stored_status,
        end_date: row.source_contract_end_date,
        notice_period_days: row.source_contract_notice_period_days
      }, today);
    } catch {
      // keep stored
    }
  }

  return {
    ...row,
    contract_use_status: status,
    source_contract: {
      id: row.source_contract_id,
      contract_number: row.source_contract_number,
      title: row.source_contract_title,
      category: row.source_contract_category,
      supplier_id: row.source_contract_supplier_id,
      supplier_name: row.source_contract_supplier_name,
      supplier_code: row.source_contract_supplier_code,
      start_date: row.source_contract_start_date,
      end_date: row.source_contract_end_date,
      annual_value_cents: row.source_contract_annual_value_cents,
      notice_period_days: row.source_contract_notice_period_days,
      status: liveStatus,
      use_status: status
    }
  };
}
