/**
 * Inbound vendor and catalog upserts, and pull-style ERP exports.
 *
 * The API key is the actor. A body user id or actor name is rejected.
 * Upserts are keyed by external_id. An Idempotency-Key header replays the
 * first successful response for that key and body.
 */

import { createHash } from 'node:crypto';
import { appendComplianceEvent, utcTimestamp } from './complianceAudit.js';
import { integrationPrincipal, IntegrationError } from './apiKeys.js';
import {
  assertAssignableSupplier,
  isUniqueConstraint,
  normalizeCatalogStatus,
  normalizeSupplierStatus,
  uniqueConflictMessage
} from './masterData.js';
import { requireIntegerCents } from './money.js';
import { deploymentCurrency } from './currencyConfig.js';
import { normalizeLineType, resolveServiceBasis } from './lineType.js';
import { invoicePayableCents } from './invoiceExceptionsService.js';

export const CATALOG_CATEGORIES = Object.freeze([
  'IT Hardware',
  'Software & Cloud',
  'Office Supplies',
  'Facilities & MRO',
  'Consulting & Professional Services',
  'Marketing & Events',
  'Travel & Subscriptions'
]);

const FORBIDDEN_ACTOR_FIELDS = [
  'actor_name',
  'actor_id',
  'actor_user_id',
  'actor_role',
  'user_id',
  'created_by',
  'approver_id',
  'approver_name',
  'requester_id',
  'received_by',
  'payer_name',
  'role'
];

/** Deployment currency stamped on export JSON and CSV. Default EUR. */
export function exportCurrency() {
  return deploymentCurrency();
}

export function assertNoActorFields(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  for (const field of FORBIDDEN_ACTOR_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      throw new IntegrationError(
        'Integration requests cannot name a user. The API key is the actor.',
        400,
        'actor_rejected'
      );
    }
  }
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function requireExternalId(value) {
  const externalId = String(value || '').trim();
  if (!/^[\w.\-:/]{1,128}$/.test(externalId)) {
    throw new IntegrationError(
      'external_id is required (1-128 characters: letters, numbers, and . _ - : /)',
      400,
      'invalid_external_id'
    );
  }
  return externalId;
}

function optionalText(value, field, max) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > max) {
    throw new IntegrationError(`${field} must be at most ${max} characters`, 400, 'invalid_field');
  }
  return text;
}

function codeFromExternalId(externalId) {
  const cleaned = externalId.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return `EXT-${cleaned || 'ID'}`.slice(0, 64);
}

async function findLink(db, entityType, externalId) {
  return db.prepare(`
    SELECT * FROM integration_entity_links
    WHERE entity_type = ? AND external_id = ?
  `).get(entityType, externalId);
}

async function saveLink(db, entityType, externalId, entityId, nowIso) {
  const existing = await findLink(db, entityType, externalId);
  if (existing) {
    await db.prepare(`
      UPDATE integration_entity_links SET entity_id = ?, updated_at = ? WHERE id = ?
    `).run(entityId, nowIso, existing.id);
    return;
  }
  await db.prepare(`
    INSERT INTO integration_entity_links (entity_type, external_id, entity_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(entityType, externalId, entityId, nowIso, nowIso);
}

async function writeIntegrationAudit(db, principal, { action, entityType, entityId, details, now }) {
  await db.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
    VALUES (?, ?, ?, ?, ?)
  `).run(entityType, entityId, action, principal.actor_name, details);
  await appendComplianceEvent(db, {
    actor_user_id: null,
    actor_name: principal.actor_name,
    actor_role: 'integration',
    action,
    entity_type: entityType,
    entity_id: entityId,
    details,
    created_at: utcTimestamp(now)
  });
}

function supplierView(row, externalId) {
  return {
    id: Number(row.id),
    external_id: externalId,
    name: row.name,
    code: row.code,
    contact_person: row.contact_person || null,
    email: row.email || null,
    phone: row.phone || null,
    address: row.address || null,
    payment_terms: row.payment_terms || 'Net 30',
    status: row.status || 'active'
  };
}

export async function upsertVendor(db, body, key, now = new Date()) {
  assertNoActorFields(body);
  const principal = integrationPrincipal(key);
  const externalId = requireExternalId(body?.external_id);
  const name = optionalText(body?.name, 'name', 200);
  if (!name) throw new IntegrationError('name is required', 400, 'invalid_field');
  const contact = optionalText(body?.contact_person, 'contact_person', 200);
  const email = optionalText(body?.email, 'email', 200);
  if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new IntegrationError('email is not a valid address', 400, 'invalid_field');
  }
  const phone = optionalText(body?.phone, 'phone', 50);
  const address = optionalText(body?.address, 'address', 500);
  const paymentTerms = optionalText(body?.payment_terms, 'payment_terms', 40) || 'Net 30';
  const status = normalizeSupplierStatus(body?.status) || 'active';
  const requestedCode = body?.code == null || body.code === '' ? null : String(body.code).trim();
  if (requestedCode && (requestedCode.length > 64 || /[\u0000-\u001f]/.test(requestedCode))) {
    throw new IntegrationError('code must be 1-64 characters', 400, 'invalid_field');
  }
  const nowIso = now.toISOString();

  return db.transaction(async () => {
    const link = await findLink(db, 'supplier', externalId);
    if (link) {
      const current = await db.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(link.entity_id);
      if (!current) {
        throw new IntegrationError('Linked supplier no longer exists', 409, 'link_broken');
      }
      if (requestedCode && requestedCode !== current.code) {
        throw new IntegrationError('Supplier code is immutable', 400, 'immutable_code');
      }
      await db.prepare(`
        UPDATE suppliers
        SET name = ?, contact_person = ?, email = ?, phone = ?, address = ?, payment_terms = ?, status = ?
        WHERE id = ?
      `).run(name, contact, email, phone, address, paymentTerms, status, current.id);
      await saveLink(db, 'supplier', externalId, current.id, nowIso);
      const updated = await db.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(current.id);
      const details = JSON.stringify({
        api_key_id: principal.api_key_id,
        key_prefix: principal.key_prefix,
        external_id: externalId,
        created: false
      });
      await writeIntegrationAudit(db, principal, {
        action: 'INTEGRATION_VENDOR_UPDATED',
        entityType: 'supplier',
        entityId: current.id,
        details,
        now
      });
      return {
        status: 200,
        body: { external_id: externalId, created: false, supplier: supplierView(updated, externalId) }
      };
    }

    const code = requestedCode || codeFromExternalId(externalId);
    let result;
    try {
      result = await db.prepare(`
        INSERT INTO suppliers (name, code, contact_person, email, phone, address, payment_terms, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(name, code, contact, email, phone, address, paymentTerms, status);
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new IntegrationError(uniqueConflictMessage(error, 'Supplier code already exists'), 409, 'conflict');
      }
      throw error;
    }
    const id = Number(result.lastInsertRowid);
    await saveLink(db, 'supplier', externalId, id, nowIso);
    const created = await db.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(id);
    const details = JSON.stringify({
      api_key_id: principal.api_key_id,
      key_prefix: principal.key_prefix,
      external_id: externalId,
      created: true
    });
    await writeIntegrationAudit(db, principal, {
      action: 'INTEGRATION_VENDOR_CREATED',
      entityType: 'supplier',
      entityId: id,
      details,
      now
    });
    return {
      status: 201,
      body: { external_id: externalId, created: true, supplier: supplierView(created, externalId) }
    };
  });
}

async function supplierIdForExternal(db, externalId) {
  const link = await findLink(db, 'supplier', externalId);
  if (!link) {
    throw new IntegrationError(
      'preferred_supplier_external_id is not linked. Upsert the vendor first.',
      400,
      'supplier_not_linked'
    );
  }
  return Number(link.entity_id);
}

function catalogView(row, externalId, preferredExternalId) {
  return {
    id: Number(row.id),
    external_id: externalId,
    sku: row.sku,
    name: row.name,
    description: row.description || null,
    category: row.category,
    unit: row.unit || 'each',
    unit_price: Number(row.unit_price),
    preferred_supplier_id: row.preferred_supplier_id == null ? null : Number(row.preferred_supplier_id),
    preferred_supplier_external_id: preferredExternalId,
    lead_time_days: Number(row.lead_time_days ?? 0),
    line_type: row.line_type,
    service_basis: row.service_basis || null,
    status: row.status || 'active'
  };
}

export async function upsertCatalogItem(db, body, key, now = new Date()) {
  assertNoActorFields(body);
  const principal = integrationPrincipal(key);
  const externalId = requireExternalId(body?.external_id);
  const name = optionalText(body?.name, 'name', 200);
  if (!name) throw new IntegrationError('name is required', 400, 'invalid_field');
  if (!body?.category || !CATALOG_CATEGORIES.includes(body.category)) {
    throw new IntegrationError(
      `category must be one of: ${CATALOG_CATEGORIES.join(', ')}`,
      400,
      'invalid_field'
    );
  }
  if (body.line_type != null && body.line_type !== '' && body.line_type !== 'goods' && body.line_type !== 'service') {
    throw new IntegrationError('line_type must be goods or service', 400, 'invalid_field');
  }
  if (Object.prototype.hasOwnProperty.call(body, 'preferred_supplier_id')) {
    throw new IntegrationError(
      'Send preferred_supplier_external_id. Internal supplier ids are not accepted.',
      400,
      'actor_rejected'
    );
  }
  const lineType = normalizeLineType(body.line_type, body.category);
  const serviceBasis = resolveServiceBasis(body.service_basis, lineType);
  const unitPrice = requireIntegerCents(body.unit_price, 'unit_price');
  if (unitPrice < 0) throw new IntegrationError('unit_price must be zero or a positive number of cents', 400, 'invalid_field');
  const status = normalizeCatalogStatus(body?.status) || 'active';
  const description = optionalText(body?.description, 'description', 2000);
  const unit = optionalText(body?.unit, 'unit', 40) || 'each';
  const leadTime = body?.lead_time_days == null || body.lead_time_days === ''
    ? 3
    : Number(body.lead_time_days);
  if (!Number.isInteger(leadTime) || leadTime < 0 || leadTime > 3650) {
    throw new IntegrationError('lead_time_days must be an integer from 0 to 3650', 400, 'invalid_field');
  }
  const requestedSku = body?.sku == null || body.sku === '' ? null : String(body.sku).trim();
  if (requestedSku && (requestedSku.length > 64 || /[\u0000-\u001f]/.test(requestedSku))) {
    throw new IntegrationError('sku must be 1-64 characters', 400, 'invalid_field');
  }
  const preferredExternal = body?.preferred_supplier_external_id
    ? requireExternalId(body.preferred_supplier_external_id)
    : null;
  const nowIso = now.toISOString();

  return db.transaction(async () => {
    const link = await findLink(db, 'catalog_item', externalId);
    const current = link
      ? await db.prepare(`SELECT * FROM catalog_items WHERE id = ?`).get(link.entity_id)
      : null;
    if (link && !current) {
      throw new IntegrationError('Linked catalog item no longer exists', 409, 'link_broken');
    }
    const preferredId = preferredExternal ? await supplierIdForExternal(db, preferredExternal) : null;
    if (preferredId) {
      await assertAssignableSupplier(db, preferredId, {
        existingPreferredId: current?.preferred_supplier_id
      });
    }
    const sku = requestedSku || current?.sku || codeFromExternalId(externalId);

    if (current) {
      try {
        await db.prepare(`
          UPDATE catalog_items
          SET sku = ?, name = ?, description = ?, category = ?, unit = ?, unit_price = ?,
              preferred_supplier_id = ?, lead_time_days = ?, line_type = ?, service_basis = ?, status = ?
          WHERE id = ?
        `).run(
          sku, name, description, body.category, unit, unitPrice,
          preferredId, leadTime, lineType, serviceBasis, status, current.id
        );
      } catch (error) {
        if (isUniqueConstraint(error)) {
          throw new IntegrationError(uniqueConflictMessage(error, 'Catalog SKU already exists'), 409, 'conflict');
        }
        throw error;
      }
      await saveLink(db, 'catalog_item', externalId, current.id, nowIso);
      const updated = await db.prepare(`SELECT * FROM catalog_items WHERE id = ?`).get(current.id);
      const details = JSON.stringify({
        api_key_id: principal.api_key_id,
        key_prefix: principal.key_prefix,
        external_id: externalId,
        created: false
      });
      await writeIntegrationAudit(db, principal, {
        action: 'INTEGRATION_CATALOG_UPDATED',
        entityType: 'catalog_item',
        entityId: current.id,
        details,
        now
      });
      return {
        status: 200,
        body: {
          external_id: externalId,
          created: false,
          item: catalogView(updated, externalId, preferredExternal)
        }
      };
    }

    let result;
    try {
      result = await db.prepare(`
        INSERT INTO catalog_items (
          sku, name, description, category, unit, unit_price,
          preferred_supplier_id, lead_time_days, image_url, line_type, service_basis, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sku, name, description, body.category, unit, unitPrice,
        preferredId, leadTime, '📦', lineType, serviceBasis, status
      );
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new IntegrationError(uniqueConflictMessage(error, 'Catalog SKU already exists'), 409, 'conflict');
      }
      throw error;
    }
    const id = Number(result.lastInsertRowid);
    await saveLink(db, 'catalog_item', externalId, id, nowIso);
    const created = await db.prepare(`SELECT * FROM catalog_items WHERE id = ?`).get(id);
    const details = JSON.stringify({
      api_key_id: principal.api_key_id,
      key_prefix: principal.key_prefix,
      external_id: externalId,
      created: true
    });
    await writeIntegrationAudit(db, principal, {
      action: 'INTEGRATION_CATALOG_CREATED',
      entityType: 'catalog_item',
      entityId: id,
      details,
      now
    });
    return {
      status: 201,
      body: {
        external_id: externalId,
        created: true,
        item: catalogView(created, externalId, preferredExternal)
      }
    };
  });
}

function normalizeIdempotencyKey(value) {
  if (value == null || value === '') return null;
  const key = String(value).trim();
  if (!key || key.length > 200 || /[\u0000-\u001f]/.test(key)) {
    throw new IntegrationError('Idempotency-Key must be 1-200 characters', 400, 'invalid_idempotency_key');
  }
  return key;
}

async function findIdempotency(db, apiKeyId, key) {
  return db.prepare(`
    SELECT * FROM integration_idempotency WHERE api_key_id = ? AND idempotency_key = ?
  `).get(apiKeyId, key);
}

function replayOrConflict(existing, requestHash) {
  if (existing.request_hash !== requestHash) {
    throw new IntegrationError(
      'Idempotency-Key was already used with a different request body',
      409,
      'idempotency_conflict'
    );
  }
  return {
    replay: true,
    status: Number(existing.response_status),
    body: JSON.parse(existing.response_body)
  };
}

export async function runIdempotent(db, apiKey, idempotencyHeader, body, work) {
  const key = normalizeIdempotencyKey(idempotencyHeader);
  const requestHash = key ? sha256(canonicalJson(body ?? null)) : null;
  if (key) {
    const existing = await findIdempotency(db, apiKey.id, key);
    if (existing) return replayOrConflict(existing, requestHash);
  }
  try {
    return await db.transaction(async () => {
      const result = await work();
      if (key) {
        await db.prepare(`
          INSERT INTO integration_idempotency (
            api_key_id, idempotency_key, request_hash, response_status, response_body, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          apiKey.id,
          key,
          requestHash,
          result.status,
          JSON.stringify(result.body),
          new Date().toISOString()
        );
      }
      return { replay: false, status: result.status, body: result.body };
    });
  } catch (error) {
    if (key && isUniqueConstraint(error) && /integration_idempotency/i.test(String(error.message || ''))) {
      const existing = await findIdempotency(db, apiKey.id, key);
      if (existing) return replayOrConflict(existing, requestHash);
    }
    throw error;
  }
}

const INVOICE_EXPORT_COLUMNS = [
  'id',
  'invoice_number',
  'supplier_id',
  'supplier_code',
  'supplier_name',
  'supplier_external_id',
  'po_id',
  'po_number',
  'invoice_date',
  'due_date',
  'status',
  'currency',
  'subtotal_cents',
  'tax_cents',
  'billed_total_cents',
  'payable_total_cents',
  'payment_reference'
];

function csvCell(value) {
  if (value == null) return '';
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toExportCsv(columns, rows) {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row[column])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function exportFormat(req) {
  const query = String(req.query?.format || '').toLowerCase();
  if (query === 'csv' || query === 'json') return query;
  const accept = String(req.headers?.accept || '');
  if (accept.includes('text/csv')) return 'csv';
  return 'json';
}

async function recordExport(db, key, resource, count, format) {
  const principal = integrationPrincipal(key);
  await appendComplianceEvent(db, {
    actor_user_id: null,
    actor_name: principal.actor_name,
    actor_role: 'integration',
    action: 'INTEGRATION_EXPORT',
    entity_type: 'export',
    entity_id: null,
    details: JSON.stringify({
      api_key_id: principal.api_key_id,
      key_prefix: principal.key_prefix,
      resource,
      format,
      count
    })
  });
}

export async function exportInvoices(db, key, req) {
  const status = String(req.query?.status || 'approved_for_payment');
  if (status !== 'approved_for_payment' && status !== 'paid') {
    throw new IntegrationError(
      'status must be approved_for_payment or paid',
      400,
      'invalid_field'
    );
  }
  const rows = await db.prepare(`
    SELECT inv.*, s.code AS supplier_code, s.name AS supplier_name,
           po.po_number, link.external_id AS supplier_external_id
    FROM invoices inv
    JOIN suppliers s ON s.id = inv.supplier_id
    JOIN purchase_orders po ON po.id = inv.po_id
    LEFT JOIN integration_entity_links link
      ON link.entity_type = 'supplier' AND link.entity_id = s.id
    WHERE inv.status = ?
    ORDER BY inv.id ASC
  `).all(status);
  const invoices = (rows || []).map((row) => ({
    id: Number(row.id),
    invoice_number: row.invoice_number,
    supplier_id: Number(row.supplier_id),
    supplier_code: row.supplier_code,
    supplier_name: row.supplier_name,
    supplier_external_id: row.supplier_external_id || null,
    po_id: Number(row.po_id),
    po_number: row.po_number,
    invoice_date: row.invoice_date,
    due_date: row.due_date,
    status: row.status,
    currency: exportCurrency(),
    subtotal_cents: Number(row.subtotal),
    tax_cents: Number(row.tax_amount || 0),
    billed_total_cents: Number(row.total_amount),
    payable_total_cents: invoicePayableCents(row),
    payment_reference: row.payment_reference || null
  }));
  const format = exportFormat(req);
  await recordExport(db, key, 'invoices', invoices.length, format);
  if (format === 'csv') {
    return {
      format,
      filename: 'approved-invoices.csv',
      body: toExportCsv(INVOICE_EXPORT_COLUMNS, invoices),
      contentType: 'text/csv; charset=utf-8'
    };
  }
  return {
    format,
    body: {
      exported_at: new Date().toISOString(),
      currency: exportCurrency(),
      count: invoices.length,
      invoices
    }
  };
}

const PAYMENT_RUN_CSV_COLUMNS = [
  'id',
  'run_number',
  'status',
  'payment_date',
  'payment_reference',
  'billed_total_cents',
  'payable_total_cents',
  'invoice_count',
  'created_at',
  'executed_at',
  'invoice_id',
  'invoice_number',
  'invoice_billed_total_cents',
  'invoice_payable_total_cents',
  'currency'
];

export async function exportPaymentRuns(db, key, req) {
  const status = String(req.query?.status || 'executed');
  if (!['draft', 'executed', 'all'].includes(status)) {
    throw new IntegrationError('status must be draft, executed, or all', 400, 'invalid_field');
  }
  const runs = status === 'all'
    ? await db.prepare(`
        SELECT * FROM payment_runs WHERE status IN ('draft', 'executed') ORDER BY id ASC
      `).all()
    : await db.prepare(`
        SELECT * FROM payment_runs WHERE status = ? ORDER BY id ASC
      `).all(status);
  const paymentRuns = [];
  for (const run of runs || []) {
    const items = await db.prepare(`
      SELECT pri.invoice_id, pri.billed_total_cents, pri.payable_total_cents, inv.invoice_number
      FROM payment_run_items pri
      JOIN invoices inv ON inv.id = pri.invoice_id
      WHERE pri.run_id = ?
      ORDER BY pri.id ASC
    `).all(run.id);
    paymentRuns.push({
      id: Number(run.id),
      run_number: run.run_number,
      status: run.status,
      payment_date: run.payment_date || null,
      payment_reference: run.payment_reference || null,
      billed_total_cents: Number(run.billed_total_cents),
      payable_total_cents: Number(run.payable_total_cents),
      invoice_count: Number(run.invoice_count),
      currency: exportCurrency(),
      created_at: run.created_at,
      executed_at: run.executed_at || null,
      invoices: (items || []).map((item) => ({
        invoice_id: Number(item.invoice_id),
        invoice_number: item.invoice_number,
        billed_total_cents: Number(item.billed_total_cents),
        payable_total_cents: Number(item.payable_total_cents)
      }))
    });
  }
  const format = exportFormat(req);
  await recordExport(db, key, 'payment_runs', paymentRuns.length, format);
  if (format === 'csv') {
    const flat = [];
    for (const run of paymentRuns) {
      if (run.invoices.length === 0) {
        flat.push({ ...run, invoice_id: '', invoice_number: '', invoice_billed_total_cents: '', invoice_payable_total_cents: '' });
      } else {
        for (const invoice of run.invoices) {
          flat.push({
            ...run,
            invoice_id: invoice.invoice_id,
            invoice_number: invoice.invoice_number,
            invoice_billed_total_cents: invoice.billed_total_cents,
            invoice_payable_total_cents: invoice.payable_total_cents
          });
        }
      }
    }
    return {
      format,
      filename: 'payment-runs.csv',
      body: toExportCsv(PAYMENT_RUN_CSV_COLUMNS, flat),
      contentType: 'text/csv; charset=utf-8'
    };
  }
  return {
    format,
    body: {
      exported_at: new Date().toISOString(),
      currency: exportCurrency(),
      count: paymentRuns.length,
      payment_runs: paymentRuns
    }
  };
}
