import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMemoryDatabase } from './db.js';
import { createApp } from './app.js';
import { loadDbConfig } from './dbConfig.js';
import { withCookie } from './testSession.js';
import { createSupplierInvoice, createVendorInvoice } from './invoicesService.js';
import { approveInvoicePayment } from './invoicesService.js';
import { listInvoiceExceptions } from './invoiceExceptionsService.js';
import { postInboundInvoice } from './integrationConnectors.js';

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', async () => {
      try {
        const { port } = server.address();
        await fn(`http://127.0.0.1:${port}`);
        server.close(() => resolve());
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

async function json(response) {
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body, headers: response.headers };
}

async function createTestDb() {
  const db = await createMemoryDatabase();
  await db.exec(`
    INSERT INTO departments (id, code, name) VALUES (1, 'ADM', 'Finance');
    INSERT INTO users (id, name, email, role, department_id, status) VALUES
      (4, 'David Miller', 'david@example.com', 'finance', 1, 'active'),
      (5, 'Elena Rostova', 'elena@example.com', 'admin', 1, 'active');
    INSERT INTO suppliers (id, name, code, status) VALUES
      (1, 'TechSupply Global', 'SUP-TSG', 'active'),
      (2, 'Other Vendor', 'SUP-OTH', 'active');
    INSERT INTO budgets (department_id, fiscal_year, total_budget, committed_amount, actual_spent)
      VALUES (1, 2026, 50000000, 0, 0);
  `);
  return db;
}

function appFor(db) {
  return createApp({
    db,
    config: loadDbConfig({}),
    integrationConfig: {
      webhookTargetUrl: 'https://erp.example/hooks',
      webhookSigningSecret: 'test-secret',
      ready: true
    }
  });
}

async function issueKey(base, scopes, extra = {}) {
  const response = await json(await fetch(`${base}/api/integrations/keys`, withCookie(5, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: extra.name || 'ERP Invoices',
      scopes,
      rate_limit_per_minute: extra.rate_limit_per_minute
    })
  })));
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}

function bearer(token, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}), Authorization: `Bearer ${token}` };
  return { ...options, headers };
}

async function insertPo(db, {
  poId = 1,
  itemId = 1,
  supplierId = 1,
  status = 'received',
  ordered = 2,
  received = 2,
  unitPriceCents = 74900,
  poNumber = 'PO-TEST-001',
  description = 'Monitor'
} = {}) {
  await db.prepare(`
    INSERT INTO purchase_orders (id, po_number, supplier_id, created_by, status, total_amount, issue_date)
    VALUES (?, ?, ?, 5, ?, ?, '2026-09-01')
  `).run(poId, poNumber, supplierId, status, ordered * unitPriceCents);
  await db.prepare(`
    INSERT INTO po_items (
      id, po_id, item_description, category, quantity, unit_price, total_price,
      quantity_received, quantity_invoiced, line_type
    ) VALUES (?, ?, ?, 'IT Hardware', ?, ?, ?, ?, 0, 'goods')
  `).run(itemId, poId, description, ordered, unitPriceCents, ordered * unitPriceCents, received);
}

function invoiceBody({
  externalId = 'TSG-INV-1001',
  invoiceNumber = 'INV-1001',
  poId = 1,
  supplierId = 1,
  itemId = 1,
  qty = 2,
  unitPrice = 74900,
  currency = 'EUR',
  invoiceDate = '2026-09-04',
  dueDate = '2026-10-04',
  tax = 0
} = {}) {
  return {
    external_id: externalId,
    invoice_number: invoiceNumber,
    po_id: poId,
    supplier_id: supplierId,
    currency,
    invoice_date: invoiceDate,
    due_date: dueDate,
    tax_amount: tax,
    lines: [
      {
        po_item_id: itemId,
        quantity_invoiced: qty,
        unit_price: unitPrice
      }
    ]
  };
}

async function postInvoice(base, token, body, headers = {}) {
  return json(await fetch(`${base}/api/integrations/invoices`, bearer(token, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })));
}

describe('inbound supplier invoices API', () => {
  test('happy path records the API key on the compliance ledger and does not approve', async () => {
    const db = await createTestDb();
    await insertPo(db);
    const app = appFor(db);
    await withServer(app, async (base) => {
      const key = await issueKey(base, ['invoices:write'], { name: 'ERP Invoices' });

      const cookieOnly = await json(await fetch(`${base}/api/integrations/invoices`, withCookie(5, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invoiceBody())
      })));
      assert.equal(cookieOnly.status, 401);
      assert.equal(cookieOnly.body.code, 'api_key_required');

      const created = await postInvoice(base, key.key, invoiceBody());
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.created, true);
      assert.equal(created.body.invoice.currency, 'EUR');
      assert.equal(created.body.invoice.status, 'matched');
      assert.equal(created.body.invoice.match_status, 'perfect_match');
      assert.equal(created.body.invoice.exception_queued, false);
      assert.equal(created.body.invoice.total_cents, 149800);

      const invoiceId = created.body.invoice.id;
      const compliance = await db.prepare(`
        SELECT actor_name, actor_role, actor_user_id, entity_type, entity_id, details
        FROM compliance_audit_events
        WHERE action = 'INTEGRATION_INVOICE_CREATED'
      `).get();
      assert.equal(compliance.actor_name, 'ERP Invoices');
      assert.equal(compliance.actor_role, 'integration');
      assert.equal(compliance.actor_user_id, null);
      assert.equal(compliance.entity_type, 'invoice');
      assert.equal(Number(compliance.entity_id), invoiceId);
      const details = JSON.parse(compliance.details);
      assert.equal(details.api_key_id, key.id);
      assert.equal(details.external_id, 'TSG-INV-1001');

      const matcher = await db.prepare(`
        SELECT actor_name FROM audit_logs
        WHERE entity_type = 'invoice' AND entity_id = ? AND action = '3_WAY_MATCHED'
      `).get(invoiceId);
      assert.equal(matcher.actor_name, 'System 3-Way Matcher');

      const principal = await db.prepare(`
        SELECT actor_name FROM audit_logs
        WHERE entity_type = 'invoice' AND entity_id = ? AND action = 'INTEGRATION_INVOICE_CREATED'
      `).get(invoiceId);
      assert.equal(principal.actor_name, 'ERP Invoices');

      const webhooks = await db.prepare(`SELECT event_type FROM webhook_outbox`).all();
      assert.deepEqual(webhooks, []);

      const spoof = await postInvoice(base, key.key, {
        ...invoiceBody({ externalId: 'TSG-INV-1002', invoiceNumber: 'INV-1002' }),
        actor_name: 'Elena Rostova',
        user_id: 5
      });
      assert.equal(spoof.status, 400);
      assert.equal(spoof.body.code, 'actor_rejected');

      await approveInvoicePayment(db, invoiceId, { approver_name: 'David Miller' });
      const approved = await db.prepare(`
        SELECT event_type FROM webhook_outbox WHERE event_type = 'invoice.approved'
      `).get();
      assert.equal(approved.event_type, 'invoice.approved');
    });
  });

  test('perfect match uses the same statuses as a UI invoice', async () => {
    const db = await createTestDb();
    await insertPo(db);
    const app = appFor(db);
    await withServer(app, async (base) => {
      const key = await issueKey(base, ['invoices:write']);
      const created = await postInvoice(base, key.key, invoiceBody());
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.invoice.match_status, 'perfect_match');
      assert.equal(created.body.invoice.status, 'matched');
      assert.equal(created.body.invoice.duplicate_status, 'clear');
      assert.equal(created.body.invoice.exception_queued, false);

      const row = await db.prepare(`SELECT status, match_status FROM invoices WHERE id = ?`).get(created.body.invoice.id);
      assert.equal(row.status, 'matched');
      assert.equal(row.match_status, 'perfect_match');
      const claimed = await db.prepare(`SELECT quantity_invoiced FROM po_items WHERE id = 1`).get();
      assert.equal(claimed.quantity_invoiced, 2);
    });
  });

  test('quantity variance lands on the exception workbench', async () => {
    const db = await createTestDb();
    await insertPo(db, { ordered: 4, received: 2 });
    const app = appFor(db);
    await withServer(app, async (base) => {
      const key = await issueKey(base, ['invoices:write']);
      const created = await postInvoice(base, key.key, invoiceBody({ qty: 3 }));
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.invoice.status, 'variance_flagged');
      assert.equal(created.body.invoice.match_status, 'quantity_variance');
      assert.equal(created.body.invoice.exception_queued, true);

      const open = await listInvoiceExceptions(db, { queue: 'open' });
      assert.equal(open.length, 1);
      assert.equal(Number(open[0].id), created.body.invoice.id);
      assert.ok(Number(open[0].fail_variances_count) >= 1);
    });
  });

  test('a second invoice with the same supplier, amount, and date is a duplicate suspect', async () => {
    const db = await createTestDb();
    await insertPo(db, { poId: 1, itemId: 1, poNumber: 'PO-TEST-001' });
    await insertPo(db, { poId: 2, itemId: 2, poNumber: 'PO-TEST-002' });
    const app = appFor(db);
    await withServer(app, async (base) => {
      const key = await issueKey(base, ['invoices:write']);
      const first = await postInvoice(base, key.key, invoiceBody());
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.equal(first.body.invoice.duplicate_status, 'clear');

      const second = await postInvoice(base, key.key, invoiceBody({
        externalId: 'TSG-INV-1002',
        invoiceNumber: 'INV-1002',
        poId: 2,
        itemId: 2
      }));
      assert.equal(second.status, 201, JSON.stringify(second.body));
      assert.equal(second.body.invoice.duplicate_status, 'suspect');
      assert.ok(second.body.invoice.duplicate_suspects.length >= 1);

      const flag = await db.prepare(`
        SELECT match_rule, status FROM invoice_duplicate_flags WHERE invoice_id = ?
      `).get(second.body.invoice.id);
      assert.equal(flag.status, 'open');
      assert.ok(flag.match_rule);
    });
  });

  test('Idempotency-Key replays the first success and rejects a different body', async () => {
    const db = await createTestDb();
    await insertPo(db);
    const app = appFor(db);
    await withServer(app, async (base) => {
      const key = await issueKey(base, ['invoices:write']);
      const headers = { 'Idempotency-Key': 'erp-post-1' };
      const first = await postInvoice(base, key.key, invoiceBody(), headers);
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.equal(first.headers.get('idempotent-replayed'), null);

      const replay = await postInvoice(base, key.key, invoiceBody(), headers);
      assert.equal(replay.status, 201);
      assert.equal(replay.headers.get('idempotent-replayed'), 'true');
      assert.equal(replay.body.invoice.id, first.body.invoice.id);
      const count = await db.prepare(`SELECT COUNT(*) AS n FROM invoices`).get();
      assert.equal(Number(count.n), 1);

      const conflict = await postInvoice(base, key.key, invoiceBody({ unitPrice: 75000 }), headers);
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.code, 'idempotency_conflict');
      const still = await db.prepare(`SELECT COUNT(*) AS n FROM invoices`).get();
      assert.equal(Number(still.n), 1);
    });
  });

  test('the same external_id is a no-op when unchanged and 409 when the payload differs', async () => {
    const db = await createTestDb();
    await insertPo(db);
    const app = appFor(db);
    await withServer(app, async (base) => {
      const key = await issueKey(base, ['invoices:write']);
      const first = await postInvoice(base, key.key, invoiceBody());
      assert.equal(first.status, 201);

      const again = await postInvoice(base, key.key, invoiceBody());
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.equal(again.body.created, false);
      assert.equal(again.body.unchanged, true);
      assert.equal(again.body.invoice.id, first.body.invoice.id);
      const events = await db.prepare(`
        SELECT COUNT(*) AS n FROM compliance_audit_events WHERE action = 'INTEGRATION_INVOICE_CREATED'
      `).get();
      assert.equal(Number(events.n), 1);

      const rewrite = await postInvoice(base, key.key, invoiceBody({ unitPrice: 80000 }));
      assert.equal(rewrite.status, 409);
      assert.equal(rewrite.body.code, 'invoice_immutable');
      assert.equal(rewrite.body.status, 'matched');
      assert.equal(rewrite.body.invoice_id, first.body.invoice.id);
      const price = await db.prepare(`SELECT unit_price FROM invoice_items WHERE invoice_id = ?`).get(first.body.invoice.id);
      assert.equal(price.unit_price, 74900);
    });
  });

  test('wrong scope, wrong currency, unknown PO, and vendor mismatch write nothing', async () => {
    const db = await createTestDb();
    await insertPo(db);
    const app = appFor(db);
    await withServer(app, async (base) => {
      const exportKey = await issueKey(base, ['export:read'], { name: 'ERP Pull' });
      const invoiceKey = await issueKey(base, ['invoices:write']);

      const wrongScope = await postInvoice(base, exportKey.key, invoiceBody());
      assert.equal(wrongScope.status, 403);
      assert.equal(wrongScope.body.code, 'api_key_scope');

      const wrongCurrency = await postInvoice(base, invoiceKey.key, invoiceBody({ currency: 'USD' }));
      assert.equal(wrongCurrency.status, 400);
      assert.equal(wrongCurrency.body.code, 'currency_mismatch');

      const unknownPo = await postInvoice(base, invoiceKey.key, invoiceBody({ poId: 999 }));
      assert.equal(unknownPo.status, 404);
      assert.equal(unknownPo.body.code, 'po_not_found');

      const mismatch = await postInvoice(base, invoiceKey.key, invoiceBody({ supplierId: 2 }));
      assert.equal(mismatch.status, 400);
      assert.equal(mismatch.body.code, 'vendor_mismatch');

      const line = await postInvoice(base, invoiceKey.key, invoiceBody({ itemId: 99 }));
      assert.equal(line.status, 400);
      assert.equal(line.body.code, 'po_line_mismatch');

      const invoices = await db.prepare(`SELECT COUNT(*) AS n FROM invoices`).get();
      const links = await db.prepare(`
        SELECT COUNT(*) AS n FROM integration_entity_links WHERE entity_type = 'invoice'
      `).get();
      assert.equal(Number(invoices.n), 0);
      assert.equal(Number(links.n), 0);
    });
  });

  test('a duplicate invoice number rolls back the link', async () => {
    const db = await createTestDb();
    await insertPo(db);
    const app = appFor(db);
    await withServer(app, async (base) => {
      const key = await issueKey(base, ['invoices:write']);
      const first = await postInvoice(base, key.key, invoiceBody());
      assert.equal(first.status, 201);
      const second = await postInvoice(base, key.key, invoiceBody({
        externalId: 'TSG-INV-OTHER',
        invoiceNumber: 'INV-1001'
      }));
      assert.equal(second.status, 409);
      assert.equal(second.body.code, 'duplicate_invoice_number');
      const invoices = await db.prepare(`SELECT COUNT(*) AS n FROM invoices`).get();
      const links = await db.prepare(`
        SELECT COUNT(*) AS n FROM integration_entity_links WHERE entity_type = 'invoice'
      `).get();
      assert.equal(Number(invoices.n), 1);
      assert.equal(Number(links.n), 1);
    });
  });

  test('rate limit is 429 once the key is over its window', async () => {
    const db = await createTestDb();
    await insertPo(db);
    const app = appFor(db);
    await withServer(app, async (base) => {
      const key = await issueKey(base, ['invoices:write'], { rate_limit_per_minute: 1 });
      const first = await postInvoice(base, key.key, invoiceBody());
      assert.equal(first.status, 201, JSON.stringify(first.body));
      const blocked = await postInvoice(base, key.key, invoiceBody({
        externalId: 'TSG-INV-1002',
        invoiceNumber: 'INV-1002'
      }));
      assert.equal(blocked.status, 429);
      assert.equal(blocked.body.code, 'rate_limited');
      assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
    });
  });

  test('dry-run evaluates match and duplicates without persisting', async () => {
    const db = await createTestDb();
    await insertPo(db, { ordered: 4, received: 2 });
    const preview = await createSupplierInvoice(db, {
      header: {
        invoice_number: 'INV-DRY',
        po_id: 1,
        supplier_id: 1,
        invoice_date: '2026-09-04',
        due_date: '2026-10-04',
        tax_amount: 0,
        notes: null
      },
      lines: [{ po_item_id: 1, description: 'Monitor', quantity_invoiced: 3, unit_price: 74900 }],
      actor: { actor_user_id: null, actor_name: 'preview', actor_role: null },
      source: 'ui',
      dryRun: true
    });
    assert.equal(preview.persisted, false);
    assert.equal(preview.dry_run, true);
    assert.equal(preview.invoiceId, null);
    assert.equal(preview.matchOutcome.invoiceStatus, 'variance_flagged');
    assert.equal(preview.matchOutcome.overallMatchStatus, 'quantity_variance');
    assert.equal(preview.exception.queued, true);
    assert.equal(preview.duplicate_status, 'clear');
    const invoices = await db.prepare(`SELECT COUNT(*) AS n FROM invoices`).get();
    const matches = await db.prepare(`SELECT COUNT(*) AS n FROM match_results`).get();
    const audits = await db.prepare(`SELECT COUNT(*) AS n FROM audit_logs`).get();
    assert.equal(Number(invoices.n), 0);
    assert.equal(Number(matches.n), 0);
    assert.equal(Number(audits.n), 0);

    const key = {
      id: 1,
      name: 'ERP Invoices',
      key_prefix: 'pfk_preview',
      scopes: ['invoices:write']
    };
    const apiPreview = await postInboundInvoice(db, invoiceBody({ qty: 3 }), key, new Date(), { dryRun: true });
    assert.equal(apiPreview.status, 200);
    assert.equal(apiPreview.body.dry_run, true);
    assert.equal(apiPreview.body.status, 'variance_flagged');
    assert.equal(apiPreview.body.exception.queued, true);
    const still = await db.prepare(`SELECT COUNT(*) AS n FROM invoices`).get();
    assert.equal(Number(still.n), 0);

    const ui = await createVendorInvoice(db, {
      invoice_number: 'INV-UI',
      po_id: 1,
      supplier_id: 1,
      invoice_date: '2026-09-04',
      due_date: '2026-10-04',
      tax_amount: 0,
      items: [{ po_item_id: 1, description: 'Monitor', quantity_invoiced: 2, unit_price: 74900 }]
    });
    assert.equal(ui.matchOutcome.overallMatchStatus, 'perfect_match');
    const compliance = await db.prepare(`
      SELECT COUNT(*) AS n FROM compliance_audit_events WHERE action = 'INTEGRATION_INVOICE_CREATED'
    `).get();
    assert.equal(Number(compliance.n), 0);
  });
});
