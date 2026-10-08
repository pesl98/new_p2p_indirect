import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createMemoryDatabase, applySchema } from './db.js';
import { SqliteAdapter } from './sqliteAdapter.js';
import { createApp } from './app.js';
import { loadDbConfig } from './dbConfig.js';
import { withCookie } from './testSession.js';
import { createSupplierInvoice } from './invoicesService.js';
import {
  normalizeExtraction,
  setInvoiceOcrProviderForTests
} from './invoiceOcr.js';
import { ocrCallLimits } from './invoiceOcrGateway.js';
import {
  approveInvoiceProposal,
  rejectInvoiceProposal,
  sessionProposalActor,
  uploadInvoiceProposal
} from './invoiceProposalsService.js';
import { isLowConfidence } from '../../shared/invoiceConfidence.js';

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
      (5, 'Elena Rostova', 'elena@example.com', 'admin', 1, 'active'),
      (6, 'Rita Buyer', 'rita@example.com', 'requester', 1, 'active');
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

async function insertPo(db, {
  poId = 1,
  itemId = 1,
  supplierId = 1,
  ordered = 2,
  received = 2,
  unitPriceCents = 74900,
  poNumber = 'PO-TEST-001',
  description = 'Monitor'
} = {}) {
  await db.prepare(`
    INSERT INTO purchase_orders (id, po_number, supplier_id, created_by, status, total_amount, issue_date)
    VALUES (?, ?, ?, 5, 'received', ?, '2026-09-01')
  `).run(poId, poNumber, supplierId, ordered * unitPriceCents);
  await db.prepare(`
    INSERT INTO po_items (
      id, po_id, item_description, category, quantity, unit_price, total_price,
      quantity_received, quantity_invoiced, line_type
    ) VALUES (?, ?, ?, 'IT Hardware', ?, ?, ?, ?, 0, 'goods')
  `).run(itemId, poId, description, ordered, unitPriceCents, ordered * unitPriceCents, received);
}

function extraction(overrides = {}) {
  return {
    vendor_name: { value: 'TechSupply Global', confidence: 0.99 },
    invoice_number: { value: 'INV-1001', confidence: 0.95 },
    invoice_date: { value: '2026-09-04', confidence: 0.91 },
    due_date: { value: '2026-10-04', confidence: 0.42 },
    po_number: { value: 'PO-TEST-001', confidence: 0.93 },
    currency: { value: 'eur', confidence: 0.9 },
    net_cents: { value: 149800, confidence: 0.92 },
    vat_cents: { value: 0, confidence: 0.9 },
    gross_cents: { value: 149800, confidence: 0.88 },
    lines: [{
      description: { value: 'Monitor', confidence: 0.97 },
      quantity: { value: 2, confidence: 0.96 },
      unit_price_cents: { value: 74900, confidence: 0.94 }
    }],
    ...overrides
  };
}

function pdfOf(fields) {
  return Buffer.from(`%PDF-1.4\n%%OCR%%\n${JSON.stringify(fields)}\n`, 'utf8');
}

function installFake() {
  setInvoiceOcrProviderForTests({
    async extract(pdf) {
      const text = Buffer.from(pdf).toString('utf8');
      const marker = '\n%%OCR%%\n';
      const at = text.indexOf(marker);
      if (at < 0) throw new Error('missing OCR fixture');
      return JSON.parse(text.slice(at + marker.length));
    }
  });
}

async function upload(base, userId, fields, headers = {}) {
  return json(await fetch(`${base}/api/invoice-proposals`, withCookie(userId, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/pdf',
      'X-Filename': 'factuur.pdf',
      ...headers
    },
    body: pdfOf(fields)
  })));
}

async function issueKey(base, scopes) {
  const response = await json(await fetch(`${base}/api/integrations/keys`, withCookie(5, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Scan facturen', scopes })
  })));
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}

describe('Sprint 7b invoice proposals', { concurrency: 1 }, () => {
  afterEach(() => {
    setInvoiceOcrProviderForTests(null);
    delete process.env.INVOICE_PDF_MAX_BYTES;
    delete process.env.INVOICE_PROPOSAL_SOD;
    delete process.env.INVOICE_PROPOSAL_UPLOADS_PER_MINUTE;
    delete process.env.INVOICE_OCR_TIMEOUT_MS;
    delete process.env.INVOICE_OCR_PROVIDER;
    delete process.env.INVOICE_OCR_MODEL;
  });

  test('low confidence is highlighted below 0.8', () => {
    assert.equal(isLowConfidence(0.8), false);
    assert.equal(isLowConfidence(0.799), true);
    assert.equal(isLowConfidence(undefined), true);
    const mapped = normalizeExtraction({
      currency: { value: 'eur', confidence: 0.5 },
      invoice_date: { value: 'not-a-date', confidence: 0.99 },
      net_cents: { value: 10.5, confidence: 0.99 }
    });
    assert.equal(mapped.currency.value, 'EUR');
    assert.equal(mapped.currency.confidence, 0.5);
    assert.equal(mapped.invoice_date.value, null);
      assert.equal(mapped.net_cents.value, null);
    const unsafe = normalizeExtraction({
      net_cents: { value: 1e20, confidence: 0.99 },
      vat_cents: { value: -5, confidence: 0.99 },
      gross_cents: { value: 149800, confidence: 0.9 }
    });
    assert.equal(unsafe.net_cents.value, null);
    assert.equal(unsafe.net_cents.confidence, 0);
    assert.equal(unsafe.vat_cents.value, null);
    assert.equal(unsafe.gross_cents.value, 149800);
  });

  test('ocr limits default to 20s and one retry', () => {
    assert.deepEqual(ocrCallLimits({}), { timeoutMs: 20000, maxRetries: 1 });
    assert.equal(ocrCallLimits({ INVOICE_OCR_TIMEOUT_MS: '5000' }).timeoutMs, 5000);
    assert.equal(ocrCallLimits({ INVOICE_OCR_TIMEOUT_MS: '10' }).timeoutMs, 20000);
    assert.equal(ocrCallLimits({ INVOICE_OCR_TIMEOUT_MS: 'nope' }).timeoutMs, 20000);
  });

  test('fake provider maps fields, highlights low confidence, and previews a match', async () => {
    installFake();
    const db = await createTestDb();
    await insertPo(db);
    const app = appFor(db);
    await withServer(app, async (base) => {
      const created = await upload(base, 5, extraction());
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const proposal = created.body.proposal;
      assert.equal(proposal.working.currency, 'EUR');
      assert.equal(proposal.working.supplier_id, 1);
      assert.equal(proposal.working.po_id, 1);
      assert.equal(proposal.working.lines[0].po_item_id, 1);
      assert.equal(proposal.working.lines[0].unit_price_cents, 74900);
      assert.equal(proposal.fields.due_date.highlight, true);
      assert.equal(proposal.fields.invoice_number.highlight, false);
      assert.ok(proposal.low_confidence_fields.includes('due_date'));
      assert.equal(proposal.preview.ready, true);
      assert.equal(proposal.preview.match.match_status, 'perfect_match');
      assert.equal(proposal.preview.duplicate_status, 'clear');
      assert.equal(JSON.stringify(created.body).includes('%PDF-'), false);
      assert.equal(proposal.status, 'proposed');

      const events = await db.prepare(`
        SELECT action, actor_user_id, actor_name, actor_role
        FROM compliance_audit_events
        WHERE entity_type = 'invoice_proposal' AND entity_id = ?
        ORDER BY id
      `).all(proposal.id);
      assert.deepEqual(events.map((row) => row.action), [
        'INVOICE_PROPOSAL_UPLOADED',
        'INVOICE_PROPOSAL_EXTRACTED'
      ]);
      assert.equal(events[0].actor_user_id, 5);
      assert.equal(events[0].actor_name, 'Elena Rostova');
      assert.equal(events[0].actor_role, 'admin');
    });
  });

  test('approve posts a perfect match through the shared invoice service', async () => {
    installFake();
    const db = await createTestDb();
    await insertPo(db);
    await withServer(appFor(db), async (base) => {
      const created = await upload(base, 4, extraction({ invoice_number: { value: 'INV-2001', confidence: 0.95 } }));
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const id = created.body.proposal.id;
      const approved = await json(await fetch(`${base}/api/invoice-proposals/${id}/approve`, withCookie(5, {
        method: 'POST'
      })));
      assert.equal(approved.status, 201, JSON.stringify(approved.body));
      assert.equal(approved.body.invoice.match_status, 'perfect_match');
      assert.equal(approved.body.invoice.status, 'matched');
      assert.equal(approved.body.proposal.status, 'posted');
      const invoice = await db.prepare(`SELECT invoice_number, status, match_status FROM invoices WHERE id = ?`).get(approved.body.invoice.invoiceId);
      assert.equal(invoice.invoice_number, 'INV-2001');
      assert.equal(invoice.status, 'matched');
      assert.equal(invoice.match_status, 'perfect_match');
      const hooks = await db.prepare(`SELECT event_type FROM webhook_outbox ORDER BY id`).all();
      assert.deepEqual(hooks.map((row) => row.event_type), ['invoice.created', 'invoice_proposal.posted']);
      const posted = await db.prepare(`
        SELECT action FROM compliance_audit_events
        WHERE entity_type = 'invoice_proposal' AND action = 'INVOICE_PROPOSAL_POSTED' AND entity_id = ?
      `).get(id);
      assert.ok(posted);
    });
  });

  test('edit then post keeps OCR values and audits the diff', async () => {
    installFake();
    const db = await createTestDb();
    await insertPo(db);
    await withServer(appFor(db), async (base) => {
      const created = await upload(base, 4, extraction({ invoice_number: { value: 'INV-3001', confidence: 0.95 } }));
      const proposal = created.body.proposal;
      const body = {
        ...proposal.working,
        invoice_number: 'INV-3001-EDIT'
      };
      const posted = await json(await fetch(`${base}/api/invoice-proposals/${proposal.id}/post`, withCookie(5, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })));
      assert.equal(posted.status, 201, JSON.stringify(posted.body));
      assert.equal(posted.body.proposal.fields.invoice_number.value, 'INV-3001');
      assert.equal(posted.body.proposal.working.invoice_number, 'INV-3001-EDIT');
      assert.equal(posted.body.proposal.baseline.invoice_number, 'INV-3001');
      const invoice = await db.prepare(`SELECT invoice_number FROM invoices WHERE id = ?`).get(posted.body.invoice.invoiceId);
      assert.equal(invoice.invoice_number, 'INV-3001-EDIT');
      const edited = await db.prepare(`
        SELECT details FROM compliance_audit_events
        WHERE entity_type = 'invoice_proposal' AND action = 'INVOICE_PROPOSAL_EDITED' AND entity_id = ?
      `).get(proposal.id);
      const diffs = JSON.parse(edited.details).diffs;
      const number = diffs.find((row) => row.field === 'invoice_number');
      assert.equal(number.ocr, 'INV-3001');
      assert.equal(number.edited, 'INV-3001-EDIT');
    });
  });

  test('reject keeps the PDF, requires a reason, and enqueues invoice_proposal.rejected', async () => {
    installFake();
    const db = await createTestDb();
    await insertPo(db);
    await withServer(appFor(db), async (base) => {
      const created = await upload(base, 4, extraction({ invoice_number: { value: 'INV-4001', confidence: 0.95 } }));
      const id = created.body.proposal.id;
      const missing = await json(await fetch(`${base}/api/invoice-proposals/${id}/reject`, withCookie(5, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: '   ' })
      })));
      assert.equal(missing.status, 400);
      assert.equal(missing.body.code, 'rejection_reason_required');
      const rejected = await json(await fetch(`${base}/api/invoice-proposals/${id}/reject`, withCookie(5, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Niet van deze leverancier' })
      })));
      assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
      assert.equal(rejected.body.proposal.status, 'rejected');
      assert.equal(rejected.body.proposal.rejected_reason, 'Niet van deze leverancier');
      const invoices = await db.prepare(`SELECT COUNT(*) AS n FROM invoices`).get();
      assert.equal(invoices.n, 0);
      const hook = await db.prepare(`SELECT event_type, payload FROM webhook_outbox`).get();
      assert.equal(hook.event_type, 'invoice_proposal.rejected');
      assert.equal(JSON.parse(hook.payload).reason, 'Niet van deze leverancier');
      assert.equal(JSON.parse(hook.payload).currency, 'EUR');
      const pdf = await fetch(`${base}/api/invoice-proposals/${id}/pdf`, withCookie(5));
      assert.equal(pdf.status, 200);
      assert.equal(pdf.headers.get('content-type'), 'application/pdf');
      const bytes = Buffer.from(await pdf.arrayBuffer());
      assert.equal(bytes.subarray(0, 5).toString('ascii'), '%PDF-');
      const anon = await fetch(`${base}/api/invoice-proposals/${id}/pdf`);
      assert.equal(anon.status, 401);
    });
  });

  test('duplicate is visible on the proposal before anything is posted', async () => {
    installFake();
    const db = await createTestDb();
    await insertPo(db);
    await createSupplierInvoice(db, {
      header: {
        invoice_number: 'INV-EXISTING',
        po_id: 1,
        supplier_id: 1,
        invoice_date: '2026-09-04',
        due_date: '2026-10-04',
        tax_amount: 0
      },
      lines: [{ po_item_id: 1, description: 'Monitor', quantity_invoiced: 2, unit_price: 74900 }],
      source: 'ui'
    });
    await withServer(appFor(db), async (base) => {
      const created = await upload(base, 5, extraction({ invoice_number: { value: 'INV-5001', confidence: 0.95 } }));
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.proposal.preview.duplicate_status, 'suspect');
      assert.equal(created.body.proposal.status, 'proposed');
      const count = await db.prepare(`SELECT COUNT(*) AS n FROM invoices`).get();
      assert.equal(count.n, 1);
    });
  });

  test('a requester cannot upload or download, and the uploader cannot approve', async () => {
    installFake();
    const db = await createTestDb();
    await insertPo(db);
    await withServer(appFor(db), async (base) => {
      const blocked = await upload(base, 6, extraction());
      assert.equal(blocked.status, 403);
      const created = await upload(base, 4, extraction({ invoice_number: { value: 'INV-6001', confidence: 0.95 } }));
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const id = created.body.proposal.id;
      const pdf = await fetch(`${base}/api/invoice-proposals/${id}/pdf`, withCookie(6));
      assert.equal(pdf.status, 403);
      const sod = await json(await fetch(`${base}/api/invoice-proposals/${id}/approve`, withCookie(4, { method: 'POST' })));
      assert.equal(sod.status, 403);
      assert.equal(sod.body.code, 'sod_violation');
      process.env.INVOICE_PROPOSAL_SOD = 'off';
      const allowed = await json(await fetch(`${base}/api/invoice-proposals/${id}/approve`, withCookie(4, { method: 'POST' })));
      assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
    });
  });

  test('upload is disabled when the OCR provider is not configured', async () => {
    const db = await createTestDb();
    await withServer(appFor(db), async (base) => {
      const config = await json(await fetch(`${base}/api/invoice-proposals/config`, withCookie(4)));
      assert.equal(config.status, 200);
      assert.equal(config.body.enabled, false);
      const uploaded = await upload(base, 4, extraction());
      assert.equal(uploaded.status, 503);
      assert.equal(uploaded.body.code, 'ocr_not_configured');
      const count = await db.prepare(`SELECT COUNT(*) AS n FROM invoice_proposals`).get();
      assert.equal(count.n, 0);
    });
  });

  test('rejects a file that is too large or not a PDF', async () => {
    installFake();
    process.env.INVOICE_PDF_MAX_BYTES = '32';
    const db = await createTestDb();
    await withServer(appFor(db), async (base) => {
      const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(64, 1)]);
      const tooBig = await json(await fetch(`${base}/api/invoice-proposals`, withCookie(4, {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf' },
        body: big
      })));
      assert.equal(tooBig.status, 413);
      assert.equal(tooBig.body.code, 'file_too_large');
      const fake = await json(await fetch(`${base}/api/invoice-proposals`, withCookie(4, {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf', 'X-Filename': 'nota.pdf' },
        body: Buffer.from('this is not a pdf')
      })));
      assert.equal(fake.status, 400);
      assert.equal(fake.body.code, 'not_a_pdf');
      const count = await db.prepare(`SELECT COUNT(*) AS n FROM invoice_proposals`).get();
      assert.equal(count.n, 0);
    });
  });

  test('API key upload uses invoices:write, idempotency, and the key as actor', async () => {
    installFake();
    const db = await createTestDb();
    await insertPo(db);
    await withServer(appFor(db), async (base) => {
      const key = await issueKey(base, ['invoices:write']);
      const pdf = pdfOf(extraction({ invoice_number: { value: 'INV-API-1', confidence: 0.96 } }));
      const post = async (token, body, headers) => json(await fetch(`${base}/api/integrations/invoice-proposals`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/pdf',
          'X-Filename': 'scan.pdf',
          ...headers
        },
        body
      }));
      const created = await post(key.key, pdf, { 'Idempotency-Key': 'scan-1' });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.proposal.source, 'integration');
      assert.equal(created.body.proposal.uploaded_by_user_id, null);
      const again = await post(key.key, pdf, { 'Idempotency-Key': 'scan-1' });
      assert.equal(again.status, 201);
      assert.equal(again.headers.get('idempotent-replayed'), 'true');
      assert.equal(again.body.proposal.id, created.body.proposal.id);
      const rows = await db.prepare(`SELECT COUNT(*) AS n FROM invoice_proposals`).get();
      assert.equal(rows.n, 1);
      const clash = await post(key.key, pdfOf(extraction({ invoice_number: { value: 'INV-API-2', confidence: 0.9 } })), {
        'Idempotency-Key': 'scan-1'
      });
      assert.equal(clash.status, 409);
      assert.equal(clash.body.code, 'idempotency_conflict');
      const event = await db.prepare(`
        SELECT actor_user_id, actor_name, actor_role, details
        FROM compliance_audit_events
        WHERE action = 'INVOICE_PROPOSAL_UPLOADED'
        ORDER BY id DESC LIMIT 1
      `).get();
      assert.equal(event.actor_user_id, null);
      assert.equal(event.actor_name, 'Scan facturen');
      assert.equal(event.actor_role, 'integration');
      assert.equal(JSON.parse(event.details).api_key_id, key.id);

      const other = await issueKey(base, ['vendors:write']);
      const denied = await post(other.key, pdf, {});
      assert.equal(denied.status, 403);
      assert.equal(denied.body.code, 'api_key_scope');

      const approved = await json(await fetch(
        `${base}/api/invoice-proposals/${created.body.proposal.id}/approve`,
        withCookie(4, { method: 'POST' })
      ));
      assert.equal(approved.status, 201, JSON.stringify(approved.body));
    });
  });

  test('PDF bytes stay off the proposal row and a non-ASCII name round-trips', async () => {
    installFake();
    const db = await createTestDb();
    await insertPo(db);
    await withServer(appFor(db), async (base) => {
      const created = await upload(base, 5, extraction({ invoice_number: { value: 'INV-NAME', confidence: 0.95 } }), {
        'Content-Disposition': "attachment; filename*=UTF-8''factuur-caf%C3%A9.pdf"
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.proposal.filename, 'factuur-café.pdf');
      assert.equal(JSON.stringify(created.body).includes('%PDF-'), false);
      assert.throws(() => db.prepare('SELECT pdf_bytes FROM invoice_proposals').get());
      const stored = await db.prepare(
        'SELECT pdf_bytes FROM invoice_proposal_files WHERE proposal_id = ?'
      ).get(created.body.proposal.id);
      assert.equal(Buffer.from(stored.pdf_bytes).subarray(0, 5).toString('ascii'), '%PDF-');
      const list = await json(await fetch(`${base}/api/invoice-proposals?limit=1&offset=0`, withCookie(5)));
      assert.equal(list.status, 200);
      assert.equal(list.body.limit, 1);
      assert.equal(list.body.offset, 0);
      assert.equal(list.body.proposals.length, 1);
      assert.equal(JSON.stringify(list.body).includes('%PDF-'), false);
      const pdf = await fetch(`${base}/api/invoice-proposals/${created.body.proposal.id}/pdf`, withCookie(5));
      assert.match(pdf.headers.get('content-disposition'), /filename\*=UTF-8''factuur-caf%C3%A9\.pdf/);
    });
  });

  test('a guessed vendor is not bound and needs a choice', async () => {
    installFake();
    const db = await createTestDb();
    await insertPo(db);
    await withServer(appFor(db), async (base) => {
      const created = await upload(base, 5, extraction({
        vendor_name: { value: 'TechSupply', confidence: 0.92 },
        invoice_number: { value: 'INV-GUESS', confidence: 0.95 }
      }));
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const proposal = created.body.proposal;
      assert.equal(proposal.vendor_match.status, 'suggested');
      assert.equal(proposal.working.supplier_id, null);
      assert.equal(proposal.preview.ready, false);
      assert.ok(proposal.preview.blockers.includes('vendor_unmatched'));
      assert.ok(proposal.low_confidence_fields.includes('supplier_id'));
    });
  });

  test('totals that do not reconcile block post until an audited reason is given', async () => {
    installFake();
    const db = await createTestDb();
    await insertPo(db);
    await withServer(appFor(db), async (base) => {
      const created = await upload(base, 4, extraction({
        invoice_number: { value: 'INV-TOTALS', confidence: 0.95 },
        net_cents: { value: 100, confidence: 0.9 },
        vat_cents: { value: 0, confidence: 0.9 },
        gross_cents: { value: 100, confidence: 0.9 }
      }));
      const id = created.body.proposal.id;
      assert.ok(created.body.proposal.preview.blockers.includes('lines_net_mismatch'));
      const blocked = await json(await fetch(`${base}/api/invoice-proposals/${id}/approve`, withCookie(5, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      })));
      assert.equal(blocked.status, 400);
      assert.equal(blocked.body.code, 'proposal_not_ready');
      const posted = await json(await fetch(`${base}/api/invoice-proposals/${id}/approve`, withCookie(5, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ override_reason: 'Papieren factuur telt korting buiten de regels' })
      })));
      assert.equal(posted.status, 201, JSON.stringify(posted.body));
      const audit = await db.prepare(`
        SELECT details FROM compliance_audit_events
        WHERE entity_type = 'invoice_proposal' AND action = 'INVOICE_PROPOSAL_POSTED' AND entity_id = ?
      `).get(id);
      assert.equal(JSON.parse(audit.details).totals_override, 'Papieren factuur telt korting buiten de regels');
    });
  });

  test('the person who created the uploading API key cannot approve', async () => {
    installFake();
    const db = await createTestDb();
    await insertPo(db);
    await withServer(appFor(db), async (base) => {
      const key = await issueKey(base, ['invoices:write']);
      const pdf = pdfOf(extraction({ invoice_number: { value: 'INV-SOD-KEY', confidence: 0.96 } }));
      const created = await json(await fetch(`${base}/api/integrations/invoice-proposals`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key.key}`,
          'Content-Type': 'application/pdf',
          'X-Filename': 'scan.pdf',
          'Idempotency-Key': 'sod-key-1'
        },
        body: pdf
      }));
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const id = created.body.proposal.id;
      const creator = await json(await fetch(`${base}/api/invoice-proposals/${id}/approve`, withCookie(5, {
        method: 'POST'
      })));
      assert.equal(creator.status, 403);
      assert.equal(creator.body.code, 'sod_violation');
      const other = await json(await fetch(`${base}/api/invoice-proposals/${id}/approve`, withCookie(4, {
        method: 'POST'
      })));
      assert.equal(other.status, 201, JSON.stringify(other.body));
    });
  });

  test('UI uploads are limited per user per minute', async () => {
    installFake();
    process.env.INVOICE_PROPOSAL_UPLOADS_PER_MINUTE = '1';
    const db = await createTestDb();
    await insertPo(db);
    await withServer(appFor(db), async (base) => {
      const first = await upload(base, 4, extraction({ invoice_number: { value: 'INV-RATE-1', confidence: 0.95 } }));
      assert.equal(first.status, 201, JSON.stringify(first.body));
      const second = await upload(base, 4, extraction({ invoice_number: { value: 'INV-RATE-2', confidence: 0.95 } }));
      assert.equal(second.status, 429);
      assert.equal(second.body.code, 'rate_limited');
    });
  });

  test('approve versus approve, and approve versus reject, change the row once', async () => {
    installFake();
    const file = path.join(os.tmpdir(), `pf-proposal-race-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
    const left = await openProposalFile(file);
    const right = await openProposalFile(file);
    try {
      await seedProposalFile(left);
      const david = sessionProposalActor({ id: 4, name: 'David Miller', role: 'finance' });
      const elena = sessionProposalActor({ id: 5, name: 'Elena Rostova', role: 'admin' });
      const first = await uploadInvoiceProposal(left, {
        pdf: pdfOf(extraction({ invoice_number: { value: 'INV-RACE-A', confidence: 0.95 } })),
        filename: 'factuur.pdf',
        actor: david
      });
      const doubled = await Promise.allSettled([
        approveInvoiceProposal(left, first.id, elena),
        approveInvoiceProposal(right, first.id, elena)
      ]);
      assert.equal(doubled.filter((row) => row.status === 'fulfilled').length, 1);
      const lost = doubled.find((row) => row.status === 'rejected');
      assert.equal(lost.reason.code, 'proposal_not_open');
      assert.equal(Number(left.prepare('SELECT COUNT(*) AS n FROM invoices').get().n), 1);

      const second = await uploadInvoiceProposal(left, {
        pdf: pdfOf(extraction({ invoice_number: { value: 'INV-RACE-B', confidence: 0.95 } })),
        filename: 'factuur.pdf',
        actor: david
      });
      const mixed = await Promise.allSettled([
        approveInvoiceProposal(left, second.id, elena),
        rejectInvoiceProposal(right, second.id, elena, 'Dubbel ontvangen')
      ]);
      assert.equal(mixed.filter((row) => row.status === 'fulfilled').length, 1);
      const other = mixed.find((row) => row.status === 'rejected');
      assert.equal(other.reason.code, 'proposal_not_open');
      const row = left.prepare('SELECT status, posted_invoice_id FROM invoice_proposals WHERE id = ?').get(second.id);
      const invoices = Number(left.prepare('SELECT COUNT(*) AS n FROM invoices').get().n);
      if (row.status === 'posted') {
        assert.ok(row.posted_invoice_id);
        assert.equal(invoices, 2);
      } else {
        assert.equal(row.status, 'rejected');
        assert.equal(invoices, 1);
      }
    } finally {
      try { left.close(); } catch { /* closed */ }
      try { right.close(); } catch { /* closed */ }
      fs.rmSync(file, { force: true });
      for (const suffix of ['-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
  });
});

async function openProposalFile(file) {
  const raw = new Database(file, { timeout: 8000 });
  raw.pragma('journal_mode = WAL');
  raw.pragma('busy_timeout = 8000');
  const db = new SqliteAdapter(raw);
  await applySchema(db);
  return db;
}

async function seedProposalFile(db) {
  await db.exec(`
    INSERT INTO departments (id, code, name) VALUES (1, 'ADM', 'Finance');
    INSERT INTO users (id, name, email, role, department_id, status) VALUES
      (4, 'David Miller', 'david@example.com', 'finance', 1, 'active'),
      (5, 'Elena Rostova', 'elena@example.com', 'admin', 1, 'active');
    INSERT INTO suppliers (id, name, code, status) VALUES
      (1, 'TechSupply Global', 'SUP-TSG', 'active');
    INSERT INTO budgets (department_id, fiscal_year, total_budget, committed_amount, actual_spent)
      VALUES (1, 2026, 50000000, 0, 0);
  `);
  await insertPo(db);
}
