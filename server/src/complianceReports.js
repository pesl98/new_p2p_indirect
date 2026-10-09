/**
 * Compliance reports. They read immutable evidence and re-derive totals.
 * They do not copy sso_login_events or sso_assertion_uses into another table.
 *
 * audit_logs holds P2P decisions (approvals, receipts, invoices, payment runs,
 * delegations, and the rest of the buying journey). Those rows are append-only
 * via triggers. They store actor_name, which Sprint 1 stamps from the session.
 * compliance_audit_events holds auth, user, SSO-settings, and export events
 * and is hash-chained. SSO evidence stays in the Sprint 2 tables.
 */

import { buildApprovalSteps } from './approvalPolicy.js';
import { findLateBidRevisions } from './sourcingBidReadModel.js';
import { awardSodThresholdCents } from './sourcingApprovalHooks.js';
import { deploymentCurrency } from './currencyConfig.js';
import {
  GENESIS_HASH,
  canonicalCompliancePayload,
  complianceRowHash
} from './complianceAudit.js';

export const AUDIT_TRAIL_COLUMNS = [
  'source',
  'source_id',
  'created_at',
  'action',
  'actor_user_id',
  'actor_name',
  'entity_type',
  'entity_id',
  'details'
];

export const APPROVAL_COMPLIANCE_COLUMNS = [
  'code',
  'severity',
  'entity_type',
  'entity_id',
  'document_number',
  'actor_user_id',
  'actor_name',
  'message'
];

export const PAYMENT_SUPPORT_COLUMNS = [
  'code',
  'severity',
  'invoice_id',
  'invoice_number',
  'po_id',
  'po_number',
  'message'
];

export const VERIFICATION_COLUMNS = [
  'code',
  'severity',
  'entity_type',
  'entity_id',
  'document_number',
  'stored_cents',
  'derived_cents',
  'message'
];

export const VERIFICATION_CHECKS = [
  'po_total',
  'requisition_total',
  'invoice_total',
  'payment_run_total',
  'compliance_hash_chain'
];

function parseDay(value, name) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const error = new Error(`${name} must be YYYY-MM-DD`);
    error.statusCode = 400;
    throw error;
  }
  return text;
}

function nextUtcDay(day) {
  const [year, month, date] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(year, month - 1, date));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return `${dt.toISOString().slice(0, 10)} 00:00:00`;
}

export function parseAuditFilters(query = {}) {
  const from = parseDay(query.from, 'from');
  const to = parseDay(query.to, 'to');
  let entityId = null;
  if (query.entity_id != null && query.entity_id !== '') {
    const id = Number(query.entity_id);
    if (!Number.isInteger(id)) {
      const error = new Error('entity_id must be an integer');
      error.statusCode = 400;
      throw error;
    }
    entityId = id;
  }
  let limit = 500;
  if (query.limit != null && query.limit !== '') {
    limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 2000) {
      const error = new Error('limit must be an integer from 1 to 2000');
      error.statusCode = 400;
      throw error;
    }
  }
  return {
    fromStart: from ? `${from} 00:00:00` : null,
    toExclusive: to ? nextUtcDay(to) : null,
    actor: query.actor ? String(query.actor).trim() : '',
    entityType: query.entity_type ? String(query.entity_type).trim() : '',
    entityId,
    action: query.action ? String(query.action).trim() : '',
    limit
  };
}

function keepRow(row, filters) {
  if (filters.fromStart && String(row.created_at) < filters.fromStart) return false;
  if (filters.toExclusive && String(row.created_at) >= filters.toExclusive) return false;
  if (filters.entityType && row.entity_type !== filters.entityType) return false;
  if (filters.entityId != null && Number(row.entity_id) !== filters.entityId) return false;
  if (filters.action && row.action !== filters.action) return false;
  if (filters.actor) {
    const needle = filters.actor.toLowerCase();
    const byId = /^\d+$/.test(filters.actor) && Number(row.actor_user_id) === Number(filters.actor);
    const byName = String(row.actor_name || '').toLowerCase().includes(needle);
    if (!byId && !byName) return false;
  }
  return true;
}

function sortTrail(rows) {
  return rows.sort((a, b) => {
    const created = String(a.created_at).localeCompare(String(b.created_at));
    if (created) return created;
    const source = String(a.source).localeCompare(String(b.source));
    if (source) return source;
    return Number(a.source_id) - Number(b.source_id);
  });
}

function summarize(findings) {
  const byCode = {};
  for (const finding of findings) {
    byCode[finding.code] = (byCode[finding.code] || 0) + 1;
  }
  return { count: findings.length, by_code: byCode };
}

function csvCell(value) {
  if (value == null) return '';
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(columns, rows) {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row[column])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export async function queryAuditTrail(db, filters) {
  const auditLogs = await db.prepare(`
    SELECT id, entity_type, entity_id, action, actor_name, details, created_at
    FROM audit_logs
  `).all();
  const ssoLogins = await db.prepare(`
    SELECT id, provider, outcome, subject, email, user_id, reason, assertion_id, created_at
    FROM sso_login_events
  `).all();
  const assertions = await db.prepare(`
    SELECT id, provider, assertion_id, created_at
    FROM sso_assertion_uses
  `).all();
  const compliance = await db.prepare(`
    SELECT id, created_at, action, actor_user_id, actor_name, actor_role,
           entity_type, entity_id, details, prev_hash, row_hash
    FROM compliance_audit_events
  `).all();

  const rows = [];
  for (const row of auditLogs || []) {
    rows.push({
      source: 'audit_logs',
      source_id: row.id,
      created_at: row.created_at,
      action: row.action,
      actor_user_id: null,
      actor_name: row.actor_name,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      details: row.details
    });
  }
  for (const row of ssoLogins || []) {
    rows.push({
      source: 'sso_login',
      source_id: row.id,
      created_at: row.created_at,
      action: row.outcome === 'success' ? 'SSO_LOGIN_SUCCESS' : 'SSO_LOGIN_FAILURE',
      actor_user_id: row.user_id ?? null,
      actor_name: row.email || row.subject || row.provider,
      entity_type: 'sso_login',
      entity_id: row.user_id ?? null,
      details: [row.provider, row.reason, row.assertion_id].filter(Boolean).join(' ')
    });
  }
  for (const row of assertions || []) {
    rows.push({
      source: 'sso_assertion',
      source_id: row.id,
      created_at: row.created_at,
      action: 'ASSERTION_USED',
      actor_user_id: null,
      actor_name: row.provider,
      entity_type: 'sso_assertion',
      entity_id: row.id,
      details: `${row.provider}:${row.assertion_id}`
    });
  }
  for (const row of compliance || []) {
    rows.push({
      source: 'compliance_audit',
      source_id: row.id,
      created_at: row.created_at,
      action: row.action,
      actor_user_id: row.actor_user_id ?? null,
      actor_name: row.actor_name,
      entity_type: row.entity_type,
      entity_id: row.entity_id ?? null,
      details: row.details
    });
  }

  const matched = sortTrail(rows.filter((row) => keepRow(row, filters)));
  return {
    rows: matched.slice(0, filters.limit),
    total: matched.length,
    limit: filters.limit
  };
}

function finding(code, fields) {
  return {
    code,
    severity: 'high',
    entity_type: null,
    entity_id: null,
    document_number: null,
    actor_user_id: null,
    actor_name: null,
    message: '',
    ...fields
  };
}

export async function queryApprovalCompliance(db) {
  const findings = [];
  const seen = new Set();
  const add = (row) => {
    const key = `${row.code}:${row.entity_type}:${row.entity_id}:${row.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(row);
  };

  const selfSteps = await db.prepare(`
    SELECT ar.id AS approval_id, ar.step_order, ar.status, ar.approver_id,
           pr.id AS requisition_id, pr.pr_number, u.name AS approver_name
    FROM approval_requests ar
    JOIN purchase_requisitions pr ON pr.id = ar.requisition_id
    JOIN users u ON u.id = ar.approver_id
    WHERE ar.status != 'skipped' AND ar.approver_id = pr.requester_id
  `).all();
  for (const row of selfSteps || []) {
    add(finding('self_approval', {
      entity_type: 'approval_request',
      entity_id: row.approval_id,
      document_number: row.pr_number,
      actor_user_id: row.approver_id,
      actor_name: row.approver_name,
      message: `${row.pr_number} step ${row.step_order} (${row.status}) is assigned to the requester ${row.approver_name} (id=${row.approver_id}).`
    }));
  }

  const selfDecisions = await db.prepare(`
    SELECT a.action, a.actor_name, pr.id AS requisition_id, pr.pr_number, pr.requester_id
    FROM audit_logs a
    JOIN purchase_requisitions pr ON pr.id = a.entity_id AND a.entity_type = 'requisition'
    JOIN users u ON u.id = pr.requester_id
    WHERE a.action IN ('APPROVED', 'STEP_APPROVED', 'REJECTED')
      AND lower(a.actor_name) = lower(u.name)
  `).all();
  for (const row of selfDecisions || []) {
    add(finding('self_approval', {
      entity_type: 'requisition',
      entity_id: row.requisition_id,
      document_number: row.pr_number,
      actor_user_id: row.requester_id,
      actor_name: row.actor_name,
      message: `${row.pr_number} ${row.action} was recorded by the requester ${row.actor_name} (id=${row.requester_id}).`
    }));
  }

  const requisitions = await db.prepare(`
    SELECT DISTINCT pr.id, pr.pr_number, pr.total_amount, pr.department_id
    FROM purchase_requisitions pr
    JOIN approval_requests ar ON ar.requisition_id = pr.id
  `).all();
  for (const pr of requisitions || []) {
    let steps;
    const award = await db.prepare(`
      SELECT a.total_cents, a.is_lowest, a.reason, a.status, a.id AS award_id,
             e.owner_user_id, e.id AS event_id, e.event_number
      FROM sourcing_awards a
      JOIN sourcing_events e ON e.id = a.event_id
      WHERE a.award_requisition_id = ?
      ORDER BY a.id DESC
      LIMIT 1
    `).get(pr.id);
    let excludeUserIds = [];
    if (award && Number(award.total_cents) > awardSodThresholdCents()) {
      const conflicts = await db.prepare(`
        SELECT user_id FROM sourcing_evaluators
        WHERE event_id = ? AND coi_status = 'conflict_declared'
      `).all(award.event_id);
      excludeUserIds = [
        Number(award.owner_user_id),
        ...conflicts.map((row) => Number(row.user_id))
      ];
    }
    try {
      steps = await buildApprovalSteps({
        totalAmount: pr.total_amount,
        departmentId: pr.department_id,
        db,
        excludeUserIds
      });
    } catch (error) {
      add(finding('policy_unresolved', {
        severity: 'warning',
        entity_type: 'requisition',
        entity_id: pr.id,
        document_number: pr.pr_number,
        message: error.message
      }));
      continue;
    }
    const expected = new Map(steps.map((step) => [Number(step.step_order), Number(step.approver_id)]));
    const stored = await db.prepare(`
      SELECT ar.id, ar.step_order, ar.status, ar.approver_id, u.name AS approver_name
      FROM approval_requests ar
      JOIN users u ON u.id = ar.approver_id
      WHERE ar.requisition_id = ? AND ar.status != 'skipped'
    `).all(pr.id);
    const present = new Set();
    for (const row of stored || []) {
      present.add(Number(row.step_order));
      const policyApprover = expected.get(Number(row.step_order));
      if (policyApprover == null) {
        add(finding('unexpected_approval_step', {
          entity_type: 'approval_request',
          entity_id: row.id,
          document_number: pr.pr_number,
          actor_user_id: row.approver_id,
          actor_name: row.approver_name,
          message: `${pr.pr_number} has step ${row.step_order}, which current policy does not require for this amount.`
        }));
      } else if (policyApprover !== Number(row.approver_id)) {
        add(finding('wrong_approver', {
          entity_type: 'approval_request',
          entity_id: row.id,
          document_number: pr.pr_number,
          actor_user_id: row.approver_id,
          actor_name: row.approver_name,
          message: `${pr.pr_number} step ${row.step_order} is assigned to ${row.approver_name} (id=${row.approver_id}); current policy assigns user id=${policyApprover}.`
        }));
      }
    }
    for (const step of steps) {
      if (!present.has(Number(step.step_order))) {
        add(finding('missing_approval_step', {
          entity_type: 'requisition',
          entity_id: pr.id,
          document_number: pr.pr_number,
          actor_user_id: step.approver_id,
          message: `${pr.pr_number} is missing policy step ${step.step_order} (approver id=${step.approver_id}).`
        }));
      }
    }
    if (award && Number(award.total_cents) > awardSodThresholdCents()) {
      for (const row of stored || []) {
        if (Number(row.approver_id) === Number(award.owner_user_id)) {
          add(finding('sourcing_award_self_approval', {
            entity_type: 'approval_request',
            entity_id: row.id,
            document_number: pr.pr_number,
            actor_user_id: row.approver_id,
            actor_name: row.approver_name,
            message: `${award.event_number} award ${pr.pr_number} step ${row.step_order} is assigned to the RFQ owner ${row.approver_name} (id=${row.approver_id}) above the segregation threshold.`
          }));
        }
      }
    }
    if (award && Number(award.is_lowest) !== 1) {
      add(finding('sourcing_award_not_lowest', {
        severity: 'info',
        entity_type: 'sourcing_award',
        entity_id: award.award_id,
        document_number: award.event_number,
        message: `${award.event_number} was not awarded to the lowest bid. Reason: ${award.reason || 'none'}.`
      }));
    }
  }

  const lateBids = await findLateBidRevisions(db);
  for (const row of lateBids || []) {
    add(finding('sourcing_bid_after_deadline', {
      severity: 'info',
      entity_type: 'sourcing_event',
      entity_id: row.event_id,
      document_number: row.event_number,
      message: `${row.event_number} has a bid revision submitted at ${row.submitted_at}, which is not before the deadline ${row.deadline_at}.`
    }));
  }

  const goodsReceipts = await db.prepare(`
    SELECT gr.id, gr.grn_number, gr.received_by, receiver.name AS receiver_name,
           po.po_number, po.requisition_id, pr.pr_number, pr.requester_id,
           requester.name AS requester_name
    FROM goods_receipts gr
    JOIN purchase_orders po ON po.id = gr.po_id
    JOIN users receiver ON receiver.id = gr.received_by
    LEFT JOIN purchase_requisitions pr ON pr.id = po.requisition_id
    LEFT JOIN users requester ON requester.id = pr.requester_id
  `).all();
  const serviceSheets = await db.prepare(`
    SELECT ses.id, ses.ses_number, ses.decided_by, receiver.name AS receiver_name,
           po.po_number, po.requisition_id, pr.pr_number, pr.requester_id,
           requester.name AS requester_name
    FROM service_entry_sheets ses
    JOIN purchase_orders po ON po.id = ses.po_id
    JOIN users receiver ON receiver.id = ses.decided_by
    LEFT JOIN purchase_requisitions pr ON pr.id = po.requisition_id
    LEFT JOIN users requester ON requester.id = pr.requester_id
    WHERE ses.status = 'accepted' AND ses.decided_by IS NOT NULL
  `).all();

  const receipts = [
    ...(goodsReceipts || []).map((row) => ({ ...row, kind: 'goods_receipt', number: row.grn_number })),
    ...(serviceSheets || []).map((row) => ({ ...row, kind: 'service_entry_sheet', number: row.ses_number, received_by: row.decided_by }))
  ];

  for (const row of receipts) {
    if (row.requester_id != null && Number(row.received_by) === Number(row.requester_id)) {
      add(finding('sod_requester_receiver', {
        entity_type: row.kind,
        entity_id: row.id,
        document_number: row.number,
        actor_user_id: row.received_by,
        actor_name: row.receiver_name,
        message: `${row.number} on ${row.po_number} was received by the requester ${row.receiver_name} (id=${row.received_by}) of ${row.pr_number}.`
      }));
    }
    if (row.requisition_id == null) continue;
    const approver = await db.prepare(`
      SELECT ar.approver_id, u.name
      FROM approval_requests ar
      JOIN users u ON u.id = ar.approver_id
      WHERE ar.requisition_id = ? AND ar.status = 'approved' AND ar.approver_id = ?
    `).get(row.requisition_id, row.received_by);
    if (approver) {
      add(finding('sod_approver_receiver', {
        entity_type: row.kind,
        entity_id: row.id,
        document_number: row.number,
        actor_user_id: row.received_by,
        actor_name: row.receiver_name,
        message: `${row.number} on ${row.po_number} was received by ${row.receiver_name} (id=${row.received_by}), who approved ${row.pr_number}.`
      }));
    }
  }

  const apEvents = await db.prepare(`
    SELECT a.id, a.action, a.actor_name, i.id AS invoice_id, i.invoice_number,
           po.id AS po_id, po.po_number, po.requisition_id, pr.requester_id,
           requester.name AS requester_name
    FROM audit_logs a
    JOIN invoices i ON i.id = a.entity_id AND a.entity_type = 'invoice'
    JOIN purchase_orders po ON po.id = i.po_id
    LEFT JOIN purchase_requisitions pr ON pr.id = po.requisition_id
    LEFT JOIN users requester ON requester.id = pr.requester_id
    WHERE a.action IN ('APPROVED_FOR_PAYMENT', 'APPROVED_PAYMENT', 'PAID')
      AND i.status IN ('approved_for_payment', 'paid')
  `).all();
  const users = await db.prepare(`SELECT id, name, role FROM users`).all();
  for (const row of apEvents || []) {
    const matches = (users || []).filter(
      (user) => String(user.name).trim().toLowerCase() === String(row.actor_name).trim().toLowerCase()
    );
    for (const user of matches) {
      const roles = [];
      if (row.requester_id != null && Number(user.id) === Number(row.requester_id)) roles.push('requester');
      if (row.requisition_id != null) {
        const approved = await db.prepare(`
          SELECT 1 AS ok FROM approval_requests
          WHERE requisition_id = ? AND status = 'approved' AND approver_id = ?
        `).get(row.requisition_id, user.id);
        if (approved) roles.push('approver');
        const received = await db.prepare(`
          SELECT 1 AS ok FROM goods_receipts gr
          JOIN purchase_orders po ON po.id = gr.po_id
          WHERE po.requisition_id = ? AND gr.received_by = ?
          UNION
          SELECT 1 AS ok FROM service_entry_sheets ses
          JOIN purchase_orders po ON po.id = ses.po_id
          WHERE po.requisition_id = ? AND ses.status = 'accepted' AND ses.decided_by = ?
        `).get(row.requisition_id, user.id, row.requisition_id, user.id);
        if (received) roles.push('receiver');
      }
      if (roles.length) {
        add(finding('sod_ap_overlap', {
          entity_type: 'invoice',
          entity_id: row.invoice_id,
          document_number: row.invoice_number,
          actor_user_id: user.id,
          actor_name: row.actor_name,
          message: `${row.invoice_number} ${row.action} actor ${row.actor_name} (id=${user.id}) is also the ${roles.join(' and ')} on ${row.po_number}.`
        }));
      }
    }
  }

  return {
    findings,
    summary: summarize(findings),
    definition: {
      self_approval: 'An approval step that is not skipped is assigned to the requisition requester, or an APPROVED / STEP_APPROVED / REJECTED audit row was written in the requester’s name.',
      wrong_approver: 'An approval step’s approver_id is not the user buildApprovalSteps assigns today for that step, amount, and department. Delegations do not rewrite approver_id, so a delegate decision is not itself a violation.',
      sod_requester_receiver: 'A goods receipt receiver, or the user who accepted a service entry sheet, is the requisition requester.',
      sod_approver_receiver: 'That same receiver approved the requisition.',
      sod_ap_overlap: 'The actor name on invoice APPROVED_FOR_PAYMENT, APPROVED_PAYMENT, or PAID matches a user who is the requester, an approver, or the receiver. audit_logs stores the session name, not a user id.',
      sourcing_award_self_approval: 'An award above the segregation threshold has an approval step assigned to the RFQ owner.',
      sourcing_award_not_lowest: 'The award was not the lowest bid. The recorded reason is shown. This finding is informational.',
      sourcing_bid_after_deadline: 'A bid revision was submitted at or after the deadline. The database trigger should make this impossible.'
    }
  };
}

function needsGoodsReceipt(lines) {
  return lines.some((line) => line.line_type !== 'service' && line.receipt_basis !== 'consignment');
}

function needsServiceAcceptance(lines) {
  return lines.some((line) => line.line_type === 'service');
}

export async function queryPaymentSupport(db) {
  const invoices = await db.prepare(`
    SELECT i.id, i.invoice_number, i.status, i.po_id,
           po.po_number, po.requisition_id, po.order_source, po.settlement_kind
    FROM invoices i
    JOIN purchase_orders po ON po.id = i.po_id
    WHERE i.status = 'paid'
  `).all();
  const findings = [];
  for (const invoice of invoices || []) {
    const approved = await db.prepare(`
      SELECT 1 AS ok FROM audit_logs
      WHERE entity_type = 'invoice' AND entity_id = ?
        AND action IN ('APPROVED_FOR_PAYMENT', 'APPROVED_PAYMENT')
    `).get(invoice.id);
    if (!approved) {
      findings.push({
        code: 'invoice_paid_without_approval',
        severity: 'high',
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number,
        po_id: invoice.po_id,
        po_number: invoice.po_number,
        message: `${invoice.invoice_number} is paid and has no APPROVED_FOR_PAYMENT or APPROVED_PAYMENT audit row.`
      });
    }

    const measured = invoice.settlement_kind === 'utility' || invoice.settlement_kind === 'bulk';
    const consignment = invoice.order_source === 'consignment';
    if (!measured && !consignment) {
      const lines = await db.prepare(`
        SELECT line_type, receipt_basis FROM po_items WHERE po_id = ?
      `).all(invoice.po_id);
      const lineList = lines || [];
      const goods = needsGoodsReceipt(lineList);
      const service = needsServiceAcceptance(lineList);
      const hasGrn = await db.prepare(
        `SELECT 1 AS ok FROM goods_receipts WHERE po_id = ?`
      ).get(invoice.po_id);
      const hasSes = await db.prepare(
        `SELECT 1 AS ok FROM service_entry_sheets WHERE po_id = ? AND status = 'accepted'`
      ).get(invoice.po_id);
      const missingGoods = (goods || (!goods && !service)) && !hasGrn;
      const missingService = service && !hasSes;
      if (missingGoods || missingService) {
        const gaps = [];
        if (missingGoods) gaps.push('no goods receipt');
        if (missingService) gaps.push('no accepted service entry');
        findings.push({
          code: 'invoice_paid_without_receipt',
          severity: 'high',
          invoice_id: invoice.id,
          invoice_number: invoice.invoice_number,
          po_id: invoice.po_id,
          po_number: invoice.po_number,
          message: `${invoice.invoice_number} is paid against ${invoice.po_number} with ${gaps.join(' and ')}. Consignment, utility, and bulk payables are not GRN documents and are not flagged here.`
        });
      }
    }

    if (invoice.requisition_id != null) {
      const prApproved = await db.prepare(`
        SELECT 1 AS ok FROM approval_requests
        WHERE requisition_id = ? AND status = 'approved'
      `).get(invoice.requisition_id);
      if (!prApproved) {
        findings.push({
          code: 'po_paid_without_requisition_approval',
          severity: 'high',
          invoice_id: invoice.id,
          invoice_number: invoice.invoice_number,
          po_id: invoice.po_id,
          po_number: invoice.po_number,
          message: `${invoice.po_number} has paid invoice ${invoice.invoice_number} and its requisition has no approved step.`
        });
      }
    }
  }

  return {
    findings,
    summary: summarize(findings),
    definition: {
      invoice_paid_without_approval: 'Invoice status is paid and audit_logs has neither APPROVED_FOR_PAYMENT nor APPROVED_PAYMENT for that invoice.',
      invoice_paid_without_receipt: 'A standard purchase PO (not consignment, utility, or bulk) was paid without a goods receipt for goods lines and/or an accepted service entry for service lines.',
      po_paid_without_requisition_approval: 'A paid invoice’s PO points at a requisition that has no approval_requests row in status approved. POs with no requisition (draw-down or measured payables) are not flagged.'
    }
  };
}

function moneyFinding(code, row) {
  return {
    code,
    severity: 'high',
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    document_number: row.document_number,
    stored_cents: Number(row.stored_cents),
    derived_cents: Number(row.derived_cents),
    message: row.message
  };
}

export async function queryVerification(db) {
  const findings = [];

  const pos = await db.prepare(`
    SELECT po.id, po.po_number, po.total_amount AS stored_cents,
           COALESCE((SELECT SUM(total_price) FROM po_items WHERE po_id = po.id), 0) AS derived_cents
    FROM purchase_orders po
    WHERE po.total_amount != COALESCE((SELECT SUM(total_price) FROM po_items WHERE po_id = po.id), 0)
  `).all();
  for (const row of pos || []) {
    findings.push(moneyFinding('po_total_mismatch', {
      entity_type: 'purchase_order',
      entity_id: row.id,
      document_number: row.po_number,
      stored_cents: row.stored_cents,
      derived_cents: row.derived_cents,
      message: `${row.po_number} header total ${row.stored_cents} cents does not equal the sum of po_items.total_price (${row.derived_cents} cents).`
    }));
  }

  const requisitions = await db.prepare(`
    SELECT pr.id, pr.pr_number, pr.total_amount AS stored_cents,
           COALESCE((SELECT SUM(total_price) FROM requisition_items WHERE requisition_id = pr.id), 0) AS derived_cents
    FROM purchase_requisitions pr
    WHERE pr.total_amount != COALESCE((SELECT SUM(total_price) FROM requisition_items WHERE requisition_id = pr.id), 0)
  `).all();
  for (const row of requisitions || []) {
    findings.push(moneyFinding('requisition_total_mismatch', {
      entity_type: 'requisition',
      entity_id: row.id,
      document_number: row.pr_number,
      stored_cents: row.stored_cents,
      derived_cents: row.derived_cents,
      message: `${row.pr_number} header total ${row.stored_cents} cents does not equal the sum of requisition_items.total_price (${row.derived_cents} cents).`
    }));
  }

  const invoices = await db.prepare(`
    SELECT i.id, i.invoice_number, i.subtotal, i.tax_amount, i.total_amount,
           COALESCE((SELECT SUM(total_price) FROM invoice_items WHERE invoice_id = i.id), 0) AS line_cents
    FROM invoices i
    WHERE i.subtotal != COALESCE((SELECT SUM(total_price) FROM invoice_items WHERE invoice_id = i.id), 0)
       OR i.total_amount != i.subtotal + COALESCE(i.tax_amount, 0)
  `).all();
  for (const row of invoices || []) {
    const tax = Number(row.tax_amount || 0);
    const derived = Number(row.line_cents) + tax;
    findings.push(moneyFinding('invoice_total_mismatch', {
      entity_type: 'invoice',
      entity_id: row.id,
      document_number: row.invoice_number,
      stored_cents: row.total_amount,
      derived_cents: derived,
      message: `${row.invoice_number} total ${row.total_amount} cents does not match line sum ${row.line_cents} plus tax ${tax} (subtotal stored ${row.subtotal}).`
    }));
  }

  const runs = await db.prepare(`
    SELECT r.id, r.run_number, r.billed_total_cents, r.payable_total_cents, r.invoice_count,
           COALESCE(SUM(i.billed_total_cents), 0) AS billed_derived,
           COALESCE(SUM(i.payable_total_cents), 0) AS payable_derived,
           COUNT(i.id) AS count_derived
    FROM payment_runs r
    LEFT JOIN payment_run_items i ON i.run_id = r.id
    GROUP BY r.id
  `).all();
  for (const row of runs || []) {
    if (Number(row.payable_total_cents) !== Number(row.payable_derived)) {
      findings.push(moneyFinding('payment_run_payable_mismatch', {
        entity_type: 'payment_run',
        entity_id: row.id,
        document_number: row.run_number,
        stored_cents: row.payable_total_cents,
        derived_cents: row.payable_derived,
        message: `${row.run_number} payable_total_cents ${row.payable_total_cents} does not equal the sum of payment_run_items (${row.payable_derived}).`
      }));
    }
    if (Number(row.billed_total_cents) !== Number(row.billed_derived)) {
      findings.push(moneyFinding('payment_run_billed_mismatch', {
        entity_type: 'payment_run',
        entity_id: row.id,
        document_number: row.run_number,
        stored_cents: row.billed_total_cents,
        derived_cents: row.billed_derived,
        message: `${row.run_number} billed_total_cents ${row.billed_total_cents} does not equal the sum of payment_run_items (${row.billed_derived}).`
      }));
    }
    if (Number(row.invoice_count) !== Number(row.count_derived)) {
      findings.push(moneyFinding('payment_run_count_mismatch', {
        entity_type: 'payment_run',
        entity_id: row.id,
        document_number: row.run_number,
        stored_cents: row.invoice_count,
        derived_cents: row.count_derived,
        message: `${row.run_number} invoice_count ${row.invoice_count} does not equal the number of payment_run_items (${row.count_derived}).`
      }));
    }
  }

  const chain = await db.prepare(`
    SELECT id, created_at, action, actor_user_id, actor_name, actor_role,
           entity_type, entity_id, details, prev_hash, row_hash
    FROM compliance_audit_events
    ORDER BY id ASC
  `).all();
  let previous = GENESIS_HASH;
  for (const row of chain || []) {
    if (row.prev_hash !== previous) {
      findings.push({
        code: 'hash_chain_prev_mismatch',
        severity: 'high',
        entity_type: 'compliance_audit_event',
        entity_id: row.id,
        document_number: null,
        stored_cents: null,
        derived_cents: null,
        message: `compliance_audit_events id=${row.id} prev_hash does not match the previous row.`
      });
    }
    const expected = complianceRowHash(row.prev_hash, canonicalCompliancePayload(row));
    if (expected !== row.row_hash) {
      findings.push({
        code: 'hash_chain_digest_mismatch',
        severity: 'high',
        entity_type: 'compliance_audit_event',
        entity_id: row.id,
        document_number: null,
        stored_cents: null,
        derived_cents: null,
        message: `compliance_audit_events id=${row.id} row_hash does not match the recomputed SHA-256.`
      });
    }
    previous = row.row_hash;
  }

  return {
    currency: deploymentCurrency(),
    findings,
    summary: summarize(findings),
    checks: VERIFICATION_CHECKS,
    definition: {
      po_total: 'purchase_orders.total_amount versus the sum of po_items.total_price.',
      requisition_total: 'purchase_requisitions.total_amount versus the sum of requisition_items.total_price.',
      invoice_total: 'invoices.subtotal versus the sum of invoice_items.total_price, and total_amount versus subtotal plus tax.',
      payment_run_total: 'payment_runs billed, payable, and invoice_count versus payment_run_items.',
      compliance_hash_chain: 'Each compliance_audit_events row_hash recomputed from the canonical payload and linked through prev_hash. An empty chain is valid. audit_logs is append-only but not hash-chained, because those rows are written from many call sites and historical rows have no digest.'
    }
  };
}
