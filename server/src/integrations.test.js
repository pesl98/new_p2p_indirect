import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMemoryDatabase } from './db.js';
import { createApp } from './app.js';
import { loadDbConfig } from './dbConfig.js';
import { hashApiKey } from './apiKeys.js';
import { withCookie } from './testSession.js';
import {
  WEBHOOK_MAX_ATTEMPTS,
  dispatchWebhookOutbox,
  enqueueWebhook,
  replayWebhook,
  signWebhook,
  verifyWebhookSignature
} from './webhookOutbox.js';
import { convertRequisitionToPurchaseOrders } from './purchaseOrdersService.js';
import { createGoodsReceipt } from './goodsReceiptsService.js';
import { createVendorInvoice, approveInvoicePayment } from './invoicesService.js';
import { createPaymentRun, executePaymentRun } from './paymentRunsService.js';

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
      (1, 'Alice Chen', 'alice@example.com', 'requester', 1, 'active'),
      (4, 'David Miller', 'david@example.com', 'finance', 1, 'active'),
      (5, 'Elena Rostova', 'elena@example.com', 'admin', 1, 'active');
    INSERT INTO suppliers (id, name, code, status) VALUES (1, 'TechSupply Global', 'SUP-TSG', 'active');
    INSERT INTO budgets (department_id, fiscal_year, total_budget, committed_amount, actual_spent)
      VALUES (1, 2026, 50000000, 0, 0);
  `);
  return db;
}

function appFor(db, integrationConfig) {
  return createApp({
    db,
    config: loadDbConfig({}),
    integrationConfig: integrationConfig || {
      webhookTargetUrl: '',
      webhookSigningSecret: '',
      ready: false
    }
  });
}

async function issueKey(base, scopes, extra = {}) {
  const response = await json(await fetch(`${base}/api/integrations/keys`, withCookie(5, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: extra.name || 'SAP Vendors',
      scopes,
      rate_limit_per_minute: extra.rate_limit_per_minute,
      expires_at: extra.expires_at || null
    })
  })));
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}

function bearer(token, options = {}) {
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
  return { ...options, headers };
}

describe('webhook signature', () => {
  test('signs t=<unix>,v1=<hmac> and rejects tamper, skew, and the wrong secret', () => {
    const body = '{"id":"evt_1","type":"po.issued"}';
    const header = signWebhook('top-secret', 1700000000, body);
    assert.match(header, /^t=1700000000,v1=[0-9a-f]{64}$/);
    assert.equal(verifyWebhookSignature('top-secret', header, body, 1700000100).ok, true);
    assert.equal(verifyWebhookSignature('top-secret', header, body, 1700000000 + 301).reason, 'timestamp');
    assert.equal(verifyWebhookSignature('top-secret', header, `${body}x`, 1700000000).reason, 'signature');
    assert.equal(verifyWebhookSignature('other-secret', header, body, 1700000000).reason, 'signature');
    assert.equal(verifyWebhookSignature('top-secret', 'v1=abcd', body, 1700000000).reason, 'malformed');
  });
});

describe('scoped API keys', () => {
  test('stores only a hash, shows the key once, and rejects non-admins', async () => {
    const db = await createTestDb();
    const app = appFor(db);
    await withServer(app, async (base) => {
      const missing = await json(await fetch(`${base}/api/integrations/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Nope', scopes: ['vendors:write'] })
      }));
      assert.equal(missing.status, 401);

      const requester = await json(await fetch(`${base}/api/integrations/keys`, withCookie(1, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Nope', scopes: ['vendors:write'] })
      })));
      assert.equal(requester.status, 403);

      const finance = await json(await fetch(`${base}/api/integrations/keys`, withCookie(4)));
      assert.equal(finance.status, 403);

      const created = await issueKey(base, ['vendors:write', 'export:read']);
      assert.match(created.key, /^pfk_/);
      assert.equal(created.key.startsWith(created.key_prefix), true);

      const stored = await db.prepare(`SELECT * FROM api_keys WHERE id = ?`).get(created.id);
      assert.equal(stored.key_hash, hashApiKey(created.key));
      assert.equal(JSON.stringify(stored).includes(created.key), false);
      assert.notEqual(stored.key_hash, created.key);

      const listed = await json(await fetch(`${base}/api/integrations/keys`, withCookie(5)));
      assert.equal(listed.status, 200);
      assert.equal(JSON.stringify(listed.body).includes(created.key), false);
      assert.equal(listed.body[0].key_prefix, created.key_prefix);

      const audit = await db.prepare(`
        SELECT actor_name, actor_user_id, action FROM compliance_audit_events WHERE action = 'API_KEY_CREATED'
      `).get();
      assert.equal(audit.actor_name, 'Elena Rostova');
      assert.equal(Number(audit.actor_user_id), 5);
      assert.equal(JSON.stringify(audit).includes(created.key), false);
    });
  });

  test('accepts a valid key and rejects missing, invalid, revoked, expired, wrong scope, and the session cookie', async () => {
    const db = await createTestDb();
    const app = appFor(db);
    await withServer(app, async (base) => {
      const vendorKey = await issueKey(base, ['vendors:write'], { name: 'SAP Vendors' });
      const exportKey = await issueKey(base, ['export:read'], { name: 'ERP Pull' });

      const vendorBody = {
        external_id: 'ERP-V-1',
        name: 'Northwind',
        code: 'NW'
      };

      const ok = await json(await fetch(`${base}/api/integrations/vendors`, bearer(vendorKey.key, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(vendorBody)
      })));
      assert.equal(ok.status, 201);
      assert.equal(ok.body.supplier.name, 'Northwind');

      const missing = await json(await fetch(`${base}/api/integrations/vendors`, withCookie(5, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ external_id: 'ERP-V-2', name: 'Cookie Co' })
      })));
      assert.equal(missing.status, 401);
      assert.equal(missing.body.code, 'api_key_required');

      const invalid = await json(await fetch(`${base}/api/integrations/vendors`, bearer('pfk_not-a-real-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ external_id: 'ERP-V-3', name: 'Bad' })
      })));
      assert.equal(invalid.status, 401);
      assert.equal(invalid.body.code, 'api_key_invalid');

      const wrongScope = await json(await fetch(`${base}/api/integrations/vendors`, bearer(exportKey.key, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ external_id: 'ERP-V-4', name: 'Wrong scope' })
      })));
      assert.equal(wrongScope.status, 403);
      assert.equal(wrongScope.body.code, 'api_key_scope');

      const business = await json(await fetch(`${base}/api/suppliers`, bearer(vendorKey.key)));
      assert.equal(business.status, 401);
      assert.equal(business.body.error, 'Authentication required');

      const noCookie = await json(await fetch(`${base}/api/purchase-orders`));
      assert.equal(noCookie.status, 401);

      await json(await fetch(`${base}/api/integrations/keys/${vendorKey.id}/revoke`, withCookie(5, { method: 'POST' })));
      const revoked = await json(await fetch(`${base}/api/integrations/vendors`, bearer(vendorKey.key, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(vendorBody)
      })));
      assert.equal(revoked.status, 401);
      assert.equal(revoked.body.code, 'api_key_revoked');

      const expiring = await issueKey(base, ['vendors:write'], { name: 'Short lived' });
      await db.prepare(`UPDATE api_keys SET expires_at = ? WHERE id = ?`).run('2020-01-01T00:00:00.000Z', expiring.id);
      const expired = await json(await fetch(`${base}/api/integrations/vendors`, bearer(expiring.key, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ external_id: 'ERP-V-9', name: 'Late' })
      })));
      assert.equal(expired.status, 401);
      assert.equal(expired.body.code, 'api_key_expired');
    });
  });

  test('rate limit is per key and does not write the blocked request', async () => {
    const db = await createTestDb();
    const app = appFor(db);
    await withServer(app, async (base) => {
      const key = await issueKey(base, ['vendors:write'], { name: 'Limited', rate_limit_per_minute: 2 });
      for (const externalId of ['LIM-1', 'LIM-2']) {
        const response = await json(await fetch(`${base}/api/integrations/vendors`, bearer(key.key, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ external_id: externalId, name: externalId })
        })));
        assert.equal(response.status, 201);
      }
      const blocked = await json(await fetch(`${base}/api/integrations/vendors`, bearer(key.key, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ external_id: 'LIM-3', name: 'LIM-3' })
      })));
      assert.equal(blocked.status, 429);
      assert.equal(blocked.body.code, 'rate_limited');
      const count = await db.prepare(`SELECT COUNT(*) AS n FROM suppliers WHERE code LIKE 'EXT-LIM-%'`).get();
      assert.equal(Number(count.n), 2);
    });
  });
});

describe('inbound master data', () => {
  test('vendor upsert is idempotent and the integration key is the audit actor', async () => {
    const db = await createTestDb();
    const app = appFor(db);
    await withServer(app, async (base) => {
      const key = await issueKey(base, ['vendors:write', 'catalog:write'], { name: 'SAP Vendors' });
      const body = { external_id: 'ERP-V-100', name: 'Northwind', email: 'ap@northwind.test' };
      const headers = {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'vendor-100-a'
      };
      const first = await json(await fetch(`${base}/api/integrations/vendors`, bearer(key.key, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      })));
      assert.equal(first.status, 201);
      assert.equal(first.body.created, true);

      const replay = await json(await fetch(`${base}/api/integrations/vendors`, bearer(key.key, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      })));
      assert.equal(replay.status, 201);
      assert.equal(replay.headers.get('idempotent-replayed'), 'true');
      assert.equal(replay.body.supplier.id, first.body.supplier.id);

      const conflict = await json(await fetch(`${base}/api/integrations/vendors`, bearer(key.key, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, name: 'Other' })
      })));
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.code, 'idempotency_conflict');

      const again = await json(await fetch(`${base}/api/integrations/vendors`, bearer(key.key, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, name: 'Northwind Updated' })
      })));
      assert.equal(again.status, 200);
      assert.equal(again.body.created, false);
      assert.equal(again.body.supplier.id, first.body.supplier.id);

      const suppliers = await db.prepare(`SELECT COUNT(*) AS n FROM suppliers WHERE name LIKE 'Northwind%'`).get();
      assert.equal(Number(suppliers.n), 1);

      const events = await db.prepare(`
        SELECT action, actor_name, actor_user_id, actor_role, entity_type
        FROM compliance_audit_events
        WHERE action LIKE 'INTEGRATION_VENDOR%'
        ORDER BY id ASC
      `).all();
      assert.equal(events.length, 2);
      assert.equal(events[0].actor_name, 'SAP Vendors');
      assert.equal(events[0].actor_user_id, null);
      assert.equal(events[0].actor_role, 'integration');
      assert.equal(events[0].entity_type, 'supplier');
      assert.equal(events[1].action, 'INTEGRATION_VENDOR_UPDATED');

      const logs = await db.prepare(`
        SELECT actor_name FROM audit_logs WHERE entity_type = 'supplier' AND action LIKE 'INTEGRATION_VENDOR%'
      `).all();
      assert.equal(logs.length, 2);
      assert.equal(logs[0].actor_name, 'SAP Vendors');

      const spoof = await json(await fetch(`${base}/api/integrations/vendors`, bearer(key.key, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ external_id: 'ERP-V-200', name: 'Spoof', actor_name: 'Elena Rostova', user_id: 5 })
      })));
      assert.equal(spoof.status, 400);
      assert.equal(spoof.body.code, 'actor_rejected');

      assert.throws(
        () => db.prepare(`UPDATE audit_logs SET action = 'TAMPER' WHERE entity_type = 'supplier'`).run(),
        /append-only/
      );
      assert.throws(
        () => db.prepare(`DELETE FROM compliance_audit_events WHERE action = 'INTEGRATION_VENDOR_CREATED'`).run(),
        /append-only/
      );

      const item = await json(await fetch(`${base}/api/integrations/catalog`, bearer(key.key, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'sku-1' },
        body: JSON.stringify({
          external_id: 'ERP-SKU-1',
          sku: 'SKU-NW-1',
          name: 'Paper',
          category: 'Office Supplies',
          unit_price: 250,
          preferred_supplier_external_id: 'ERP-V-100'
        })
      })));
      assert.equal(item.status, 201);
      const itemReplay = await json(await fetch(`${base}/api/integrations/catalog`, bearer(key.key, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'sku-1' },
        body: JSON.stringify({
          external_id: 'ERP-SKU-1',
          sku: 'SKU-NW-1',
          name: 'Paper',
          category: 'Office Supplies',
          unit_price: 250,
          preferred_supplier_external_id: 'ERP-V-100'
        })
      })));
      assert.equal(itemReplay.status, 201);
      assert.equal(itemReplay.headers.get('idempotent-replayed'), 'true');
      const catalogCount = await db.prepare(`SELECT COUNT(*) AS n FROM catalog_items WHERE sku = 'SKU-NW-1'`).get();
      assert.equal(Number(catalogCount.n), 1);
      const catalogAudit = await db.prepare(`
        SELECT actor_name, actor_role FROM compliance_audit_events WHERE action = 'INTEGRATION_CATALOG_CREATED'
      `).get();
      assert.equal(catalogAudit.actor_name, 'SAP Vendors');
      assert.equal(catalogAudit.actor_role, 'integration');
    });
  });
});

describe('exports', () => {
  test('approved invoices and payment runs export as JSON and CSV', async () => {
    const db = await createTestDb();
    await db.exec(`
      INSERT INTO purchase_orders (id, po_number, supplier_id, created_by, status, total_amount, issue_date)
        VALUES (1, 'PO-2026-010', 1, 5, 'issued', 1000, '2026-09-01');
      INSERT INTO invoices (
        id, invoice_number, po_id, supplier_id, invoice_date, due_date,
        subtotal, tax_amount, total_amount, payable_total_cents, status, payment_reference
      ) VALUES (
        1, 'INV-100', 1, 1, '2026-09-02', '2026-10-02',
        1000, 0, 1000, 900, 'approved_for_payment', NULL
      );
      INSERT INTO payment_runs (
        id, run_number, status, payment_date, payment_reference, actor_name,
        billed_total_cents, payable_total_cents, invoice_count, executed_at
      ) VALUES (
        1, 'PAY-2026-001', 'executed', '2026-10-03', 'ACH-9', 'Elena Rostova',
        1000, 900, 1, '2026-10-03 12:00:00'
      );
      INSERT INTO payment_run_items (run_id, invoice_id, billed_total_cents, payable_total_cents)
        VALUES (1, 1, 1000, 900);
    `);
    const app = appFor(db);
    await withServer(app, async (base) => {
      const key = await issueKey(base, ['export:read'], { name: 'ERP Pull' });
      const invoices = await json(await fetch(`${base}/api/integrations/exports/invoices`, bearer(key.key)));
      assert.equal(invoices.status, 200);
      assert.equal(invoices.body.currency, 'USD');
      assert.equal(invoices.body.count, 1);
      assert.deepEqual(invoices.body.invoices[0], {
        id: 1,
        invoice_number: 'INV-100',
        supplier_id: 1,
        supplier_code: 'SUP-TSG',
        supplier_name: 'TechSupply Global',
        supplier_external_id: null,
        po_id: 1,
        po_number: 'PO-2026-010',
        invoice_date: '2026-09-02',
        due_date: '2026-10-02',
        status: 'approved_for_payment',
        currency: 'USD',
        subtotal_cents: 1000,
        tax_cents: 0,
        billed_total_cents: 1000,
        payable_total_cents: 900,
        payment_reference: null
      });

      const csv = await fetch(`${base}/api/integrations/exports/invoices?format=csv`, bearer(key.key));
      const csvText = await csv.text();
      assert.equal(csv.status, 200);
      assert.match(csv.headers.get('content-type'), /text\/csv/);
      assert.match(csvText.split('\n')[0], /invoice_number,supplier_id,supplier_code/);
      assert.match(csvText, /INV-100/);

      const runs = await json(await fetch(`${base}/api/integrations/exports/payment-runs`, bearer(key.key)));
      assert.equal(runs.status, 200);
      assert.equal(runs.body.count, 1);
      assert.equal(runs.body.payment_runs[0].run_number, 'PAY-2026-001');
      assert.equal(runs.body.payment_runs[0].status, 'executed');
      assert.equal(runs.body.payment_runs[0].payable_total_cents, 900);
      assert.deepEqual(runs.body.payment_runs[0].invoices, [{
        invoice_id: 1,
        invoice_number: 'INV-100',
        billed_total_cents: 1000,
        payable_total_cents: 900
      }]);

      const runCsv = await fetch(`${base}/api/integrations/exports/payment-runs?format=csv`, bearer(key.key));
      const runCsvText = await runCsv.text();
      assert.match(runCsvText, /PAY-2026-001/);
      assert.match(runCsvText, /INV-100/);

      const exportAudit = await db.prepare(`
        SELECT actor_name, actor_role, action FROM compliance_audit_events WHERE action = 'INTEGRATION_EXPORT'
      `).all();
      assert.ok(exportAudit.length >= 2);
      assert.equal(exportAudit[0].actor_name, 'ERP Pull');
      assert.equal(exportAudit[0].actor_role, 'integration');
    });
  });

  test('config endpoint reports webhook setup without returning the secret or URL', async () => {
    const db = await createTestDb();
    const secret = 'signing-secret-value-should-not-leak';
    const app = appFor(db, {
      webhookTargetUrl: 'https://erp.example/hooks/procureflow?token=super-secret-query',
      webhookSigningSecret: secret,
      ready: true
    });
    await withServer(app, async (base) => {
      const hidden = await json(await fetch(`${base}/api/integrations/config`));
      assert.equal(hidden.status, 401);
      const config = await json(await fetch(`${base}/api/integrations/config`, withCookie(5)));
      assert.equal(config.status, 200);
      assert.equal(config.body.webhook_target_configured, true);
      assert.equal(config.body.webhook_signing_secret_configured, true);
      assert.equal(config.body.webhook_target_host, 'erp.example');
      const serialized = JSON.stringify(config.body);
      assert.equal(serialized.includes(secret), false);
      assert.equal(serialized.includes('super-secret-query'), false);
      assert.equal(serialized.includes('/hooks/'), false);
    });
  });
});

describe('webhook outbox', () => {
  test('retries with backoff, dead-letters, and replay delivers', async () => {
    const db = await createMemoryDatabase();
    const now = new Date('2026-10-06T12:00:00.000Z');
    const id = await enqueueWebhook(db, {
      eventType: 'po.issued',
      entityType: 'purchase_order',
      entityId: 7,
      data: { po_id: 7, po_number: 'PO-1' },
      now
    });
    const calls = [];
    const failing = async (url, options) => {
      calls.push({ url, body: options.body, signature: options.headers['X-ProcureFlow-Signature'] });
      return { ok: false, status: 500, text: async () => 'nope' };
    };
    const config = {
      webhookTargetUrl: 'https://erp.example/hooks',
      webhookSigningSecret: 'hook-secret',
      ready: true
    };

    const unconfigured = await dispatchWebhookOutbox(db, {
      now,
      config: { webhookTargetUrl: '', webhookSigningSecret: '', ready: false }
    });
    assert.equal(unconfigured.skipped, 'not_configured');
    assert.equal(calls.length, 0);

    let cursor = now;
    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
      const summary = await dispatchWebhookOutbox(db, { now: cursor, fetchImpl: failing, config });
      const row = await db.prepare(`SELECT * FROM webhook_outbox WHERE id = ?`).get(id);
      if (attempt < WEBHOOK_MAX_ATTEMPTS) {
        assert.equal(summary.failed, 1);
        assert.equal(row.status, 'pending');
        assert.equal(Number(row.attempt_count), attempt);
        const tooSoon = new Date(Date.parse(row.next_attempt_at) - 1000);
        const skipped = await dispatchWebhookOutbox(db, { now: tooSoon, fetchImpl: failing, config });
        assert.equal(skipped.failed, 0);
        assert.equal(skipped.delivered, 0);
        cursor = new Date(Date.parse(row.next_attempt_at) + 1000);
      } else {
        assert.equal(summary.dead, 1);
        assert.equal(row.status, 'dead');
        assert.equal(Number(row.attempt_count), WEBHOOK_MAX_ATTEMPTS);
      }
    }
    assert.equal(calls.length, WEBHOOK_MAX_ATTEMPTS);
    const signed = verifyWebhookSignature('hook-secret', calls[0].signature, calls[0].body, Math.floor(now.getTime() / 1000));
    assert.equal(signed.ok, true);
    assert.match(calls[0].body, /"id":"evt_1"/);

    const admin = { id: 5, name: 'Elena Rostova', role: 'admin' };
    await db.exec(`
      INSERT INTO users (id, name, email, role, status) VALUES (5, 'Elena Rostova', 'elena@example.com', 'admin', 'active');
    `);
    const success = async () => ({ ok: true, status: 200, text: async () => '' });
    const replayed = await replayWebhook(db, id, admin, {
      now: cursor,
      fetchImpl: success,
      config
    });
    assert.equal(replayed.event.status, 'delivered');
    assert.equal(replayed.delivery.delivered, 1);
    const replayAudit = await db.prepare(`
      SELECT actor_name, action FROM compliance_audit_events WHERE action = 'WEBHOOK_REPLAYED'
    `).get();
    assert.equal(replayAudit.actor_name, 'Elena Rostova');
  });

  test('PO issue, receipt, invoice approval, and payment runs enqueue events', async () => {
    const db = await createTestDb();
    await db.exec(`
      INSERT INTO users (id, name, email, role, department_id, status)
        VALUES (3, 'Carol Zhang', 'carol@example.com', 'procurement', 1, 'active');
      INSERT INTO purchase_requisitions (
        id, pr_number, requester_id, department_id, status, total_amount, needed_by_date
      ) VALUES (1, 'PR-2026-001', 1, 1, 'approved', 5000, '2026-10-20');
      INSERT INTO requisition_items (
        id, requisition_id, item_description, category, quantity, unit_price, total_price, estimated_supplier_id, line_type
      ) VALUES (1, 1, 'Paper', 'Office Supplies', 2, 2500, 5000, 1, 'goods');
    `);
    const created = await convertRequisitionToPurchaseOrders(db, { requisition_id: 1, created_by: 3 });
    const poId = created[0].poId;
    const line = await db.prepare(`SELECT id FROM po_items WHERE po_id = ?`).get(poId);
    await createGoodsReceipt(db, {
      po_id: poId,
      received_by: 3,
      receipt_date: '2026-10-06',
      actor_name: 'Carol Zhang',
      items: [{ po_item_id: line.id, quantity_received: 2 }]
    });
    const invoice = await createVendorInvoice(db, {
      invoice_number: 'INV-HOOK',
      po_id: poId,
      supplier_id: 1,
      invoice_date: '2026-10-06',
      due_date: '2026-11-06',
      tax_amount: 0,
      items: [{ po_item_id: line.id, description: 'Paper', quantity_invoiced: 2, unit_price: 2500 }]
    });
    await approveInvoicePayment(db, invoice.invoiceId, { approver_name: 'David Miller' });
    const run = await createPaymentRun(db, { invoice_ids: [invoice.invoiceId], actor_name: 'David Miller' });
    await executePaymentRun(db, run.id, {
      payment_date: '2026-10-07',
      payment_reference: 'ACH-HOOK',
      actor_name: 'David Miller'
    });
    const types = (await db.prepare(`SELECT event_type FROM webhook_outbox ORDER BY id ASC`).all())
      .map((row) => row.event_type);
    assert.deepEqual(types, [
      'po.issued',
      'receipt.posted',
      'invoice.approved',
      'payment_run.created',
      'payment_run.paid'
    ]);
  });
});
