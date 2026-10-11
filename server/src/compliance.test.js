import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { applySchema, createMemoryDatabase } from './db.js';
import { createApp } from './app.js';
import { loadDbConfig } from './dbConfig.js';
import { hashPassword } from './auth.js';
import { withCookie } from './testSession.js';
import { appendComplianceEvent } from './complianceAudit.js';
import { prepareComplianceCsv } from './routes/compliance.js';
import {
  queryApprovalCompliance,
  queryAuditTrail,
  queryPaymentSupport,
  queryVerification,
  parseAuditFilters,
  toCsv
} from './complianceReports.js';

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
  return { status: response.status, body: await response.json() };
}

async function baseDb() {
  const db = await createMemoryDatabase();
  await db.exec(`
    INSERT INTO departments (id, code, name, approver_user_id) VALUES
      (1, 'MKT', 'Marketing', 2);
    INSERT INTO users (id, name, email, role, department_id, title, status) VALUES
      (1, 'Alice Chen', 'alice@example.com', 'requester', 1, 'Specialist', 'active'),
      (2, 'Bob Martinez', 'bob@example.com', 'approver', 1, 'VP', 'active'),
      (3, 'Carol Zhang', 'carol@example.com', 'procurement', 1, 'Sourcing', 'active'),
      (4, 'David Miller', 'david@example.com', 'finance', 1, 'Controller', 'active'),
      (5, 'Elena Rostova', 'elena@example.com', 'admin', 1, 'CFO', 'active');
    INSERT INTO suppliers (id, name, code, status) VALUES (1, 'TechSupply Global', 'SUP-TSG', 'active');
  `);
  return db;
}

function appFor(db) {
  return createApp({ db, config: loadDbConfig({}) });
}

describe('append-only audit stores', () => {
  test('UPDATE and DELETE are rejected on audit, SSO, and compliance tables', async () => {
    const db = await baseDb();
    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('invoice', 1, 'PAID', 'David Miller', 'paid')
    `).run();
    await db.prepare(`
      INSERT INTO sso_login_events (provider, outcome, email, user_id)
      VALUES ('oidc', 'success', 'alice@example.com', 1)
    `).run();
    await db.prepare(`
      INSERT INTO sso_assertion_uses (provider, assertion_id)
      VALUES ('oidc', 'assert-1')
    `).run();
    await appendComplianceEvent(db, {
      action: 'LOGOUT',
      actor_user_id: 5,
      actor_name: 'Elena Rostova',
      actor_role: 'admin',
      entity_type: 'user',
      entity_id: 5,
      details: null
    });

    const statements = [
      `UPDATE audit_logs SET action = 'TAMPER' WHERE id = 1`,
      `DELETE FROM audit_logs WHERE id = 1`,
      `UPDATE sso_login_events SET outcome = 'failure' WHERE id = 1`,
      `DELETE FROM sso_login_events WHERE id = 1`,
      `UPDATE sso_assertion_uses SET assertion_id = 'other' WHERE id = 1`,
      `DELETE FROM sso_assertion_uses WHERE id = 1`,
      `UPDATE compliance_audit_events SET action = 'TAMPER' WHERE id = 1`,
      `DELETE FROM compliance_audit_events WHERE id = 1`
    ];
    for (const sql of statements) {
      await assert.rejects(
        async () => { await db.prepare(sql).run(); },
        /append-only/,
        sql
      );
    }

    await assert.rejects(
      async () => {
        await db.prepare(`
          INSERT INTO compliance_audit_events (
            created_at, action, actor_user_id, actor_name, entity_type, prev_hash, row_hash
          ) VALUES ('2026-01-01 00:00:00', 'X', 1, 'Elena Rostova', 'user', 'NOT-THE-CHAIN', '${'ab'.repeat(32)}')
        `).run();
      },
      /prev_hash mismatch/
    );
  });

  test('applySchema is idempotent and a valid chain verifies', async () => {
    const db = await createMemoryDatabase();
    await applySchema(db);
    await appendComplianceEvent(db, {
      action: 'LOGOUT',
      actor_user_id: null,
      actor_name: 'Ada',
      entity_type: 'user',
      entity_id: null
    });
    await appendComplianceEvent(db, {
      action: 'LOGOUT',
      actor_user_id: null,
      actor_name: 'Ada',
      entity_type: 'user',
      entity_id: null
    });
    const report = await queryVerification(db);
    assert.equal(report.findings.filter((row) => row.code.startsWith('hash_chain')).length, 0);
  });
});

describe('compliance report logic', () => {
  test('audit trail reads SSO rows without copying them and filters the union', async () => {
    const db = await baseDb();
    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details, created_at)
      VALUES ('invoice', 9, 'PAID', 'David Miller', 'said "hello", world', '2026-09-03 10:00:00')
    `).run();
    await db.prepare(`
      INSERT INTO sso_login_events (provider, outcome, email, user_id, reason, created_at)
      VALUES ('saml', 'failure', 'alice@example.com', 1, 'sso_user_unknown', '2026-09-04 10:00:00')
    `).run();
    await db.prepare(`
      INSERT INTO sso_assertion_uses (provider, assertion_id, created_at)
      VALUES ('oidc', 'assert-9', '2026-09-04 11:00:00')
    `).run();

    const all = await queryAuditTrail(db, parseAuditFilters({}));
    assert.ok(all.rows.some((row) => row.source === 'sso_login' && row.action === 'SSO_LOGIN_FAILURE'));
    assert.ok(all.rows.some((row) => row.source === 'sso_assertion' && row.action === 'ASSERTION_USED'));
    assert.ok(all.rows.some((row) => row.source === 'audit_logs' && row.action === 'PAID'));
    const copies = await db.prepare(`SELECT COUNT(*) AS n FROM compliance_audit_events`).get();
    assert.equal(Number(copies.n), 0);

    const paid = await queryAuditTrail(db, parseAuditFilters({
      from: '2026-09-03',
      to: '2026-09-03',
      actor: 'David',
      entity_type: 'invoice',
      entity_id: '9',
      action: 'PAID'
    }));
    assert.equal(paid.total, 1);
    assert.equal(paid.rows[0].details, 'said "hello", world');

    const later = await queryAuditTrail(db, parseAuditFilters({ from: '2026-09-04', action: 'PAID' }));
    assert.equal(later.total, 0);
  });

  test('approval report flags a seeded segregation-of-duties violation and leaves a clean chain alone', async () => {
    const db = await baseDb();
    await db.exec(`
      INSERT INTO purchase_requisitions (
        id, pr_number, requester_id, department_id, status, total_amount, priority
      ) VALUES
        (1, 'PR-SOD-1', 1, 1, 'approved', 5000, 'Low'),
        (2, 'PR-CLEAN-1', 1, 1, 'approved', 5000, 'Low'),
        (3, 'PR-WRONG-1', 1, 1, 'approved', 5000, 'Low');
      INSERT INTO approval_requests (id, requisition_id, approver_id, step_order, status, policy_version) VALUES
        (1, 1, 1, 1, 'approved', 2),
        (2, 2, 2, 1, 'approved', 2),
        (3, 3, 5, 1, 'approved', 2);
      INSERT INTO purchase_orders (
        id, po_number, requisition_id, supplier_id, created_by, status, total_amount, issue_date
      ) VALUES
        (1, 'PO-SOD-1', 1, 1, 3, 'issued', 5000, '2026-09-01'),
        (2, 'PO-CLEAN-1', 2, 1, 3, 'issued', 5000, '2026-09-01');
      INSERT INTO po_items (po_id, item_description, quantity, unit_price, total_price, line_type) VALUES
        (1, 'Chair', 1, 5000, 5000, 'goods'),
        (2, 'Chair', 1, 5000, 5000, 'goods');
      INSERT INTO goods_receipts (id, grn_number, po_id, received_by, receipt_date) VALUES
        (1, 'GRN-SOD-1', 1, 1, '2026-09-02'),
        (2, 'GRN-CLEAN-1', 2, 3, '2026-09-02');
      INSERT INTO invoices (
        id, invoice_number, po_id, supplier_id, invoice_date, due_date,
        subtotal, tax_amount, total_amount, status
      ) VALUES
        (1, 'INV-SOD', 1, 1, '2026-09-03', '2026-10-03', 5000, 0, 5000, 'paid'),
        (2, 'INV-CLEAN', 2, 1, '2026-09-03', '2026-10-03', 5000, 0, 5000, 'paid');
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details) VALUES
        ('requisition', 1, 'APPROVED', 'Alice Chen', 'self approved'),
        ('invoice', 1, 'APPROVED_FOR_PAYMENT', 'Alice Chen', 'ap'),
        ('invoice', 1, 'PAID', 'Alice Chen', 'paid'),
        ('requisition', 2, 'APPROVED', 'Bob Martinez', 'ok'),
        ('invoice', 2, 'APPROVED_FOR_PAYMENT', 'David Miller', 'ap'),
        ('invoice', 2, 'PAID', 'David Miller', 'paid');
    `);

    const report = await queryApprovalCompliance(db);
    const codes = new Set(report.findings.map((row) => row.code));
    for (const code of [
      'self_approval',
      'wrong_approver',
      'sod_requester_receiver',
      'sod_approver_receiver',
      'sod_ap_overlap'
    ]) {
      assert.ok(codes.has(code), `missing ${code}: ${JSON.stringify(report.findings)}`);
    }
    const sodRows = report.findings.filter((row) => row.document_number === 'PR-SOD-1').map((row) => row.code);
    assert.ok(sodRows.includes('self_approval'));
    assert.ok(!sodRows.includes('wrong_approver'), 'a step already flagged as self approval is not flagged twice');
    assert.ok(report.findings.some((row) => row.code === 'wrong_approver' && row.document_number === 'PR-WRONG-1'));
    const cleanHits = report.findings.filter((row) =>
      String(row.document_number || '').includes('CLEAN') || String(row.message).includes('PR-CLEAN')
      || String(row.message).includes('PO-CLEAN') || String(row.message).includes('INV-CLEAN')
      || String(row.message).includes('GRN-CLEAN')
    );
    assert.equal(cleanHits.length, 0, JSON.stringify(cleanHits));
  });

  test('a chain is judged by the policy version it was built under', async () => {
    const db = await baseDb();
    // Bob heads the department and raised the requisition himself. Version 1 routed it to him;
    // version 2 routes around him (to a role=approver in the department, then up the ladder).
    await db.exec(`
      INSERT INTO purchase_requisitions (
        id, pr_number, requester_id, department_id, status, total_amount, priority
      ) VALUES
        (1, 'PR-LEGACY', 2, 1, 'approved', 5000, 'Low'),
        (2, 'PR-V2-OK', 2, 1, 'approved', 5000, 'Low'),
        (3, 'PR-V2-BAD', 2, 1, 'approved', 5000, 'Low');
      INSERT INTO approval_requests (id, requisition_id, approver_id, step_order, status, policy_version) VALUES
        (1, 1, 2, 1, 'approved', NULL),
        (2, 2, 3, 1, 'approved', 2),
        (3, 3, 4, 1, 'approved', 2);
    `);
    const report = await queryApprovalCompliance(db);
    const codesFor = (doc) => report.findings.filter((row) => row.document_number === doc).map((row) => row.code);
    assert.deepEqual(codesFor('PR-LEGACY'), ['self_approval'], 'legacy chain: no wrong_approver on top of self approval');
    assert.deepEqual(codesFor('PR-V2-OK'), []);
    assert.deepEqual(codesFor('PR-V2-BAD'), ['wrong_approver']);
  });

  test('new chains record the policy version', async () => {
    const db = await baseDb();
    await db.exec(`
      INSERT INTO purchase_requisitions (id, pr_number, requester_id, department_id, status, total_amount, priority)
      VALUES (1, 'PR-NEW', 1, 1, 'pending_approval', 5000, 'Low')
    `);
    const { insertApprovalChain, APPROVAL_POLICY_VERSION } = await import('./approvalPolicy.js');
    await insertApprovalChain(db, 1, 5000, 1);
    const rows = await db.prepare(`SELECT policy_version FROM approval_requests WHERE requisition_id = 1`).all();
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((row) => Number(row.policy_version) === APPROVAL_POLICY_VERSION));
  });

  test('payment support flags paid invoices missing approval, receipt, or requisition approval', async () => {
    const db = await baseDb();
    await db.exec(`
      INSERT INTO purchase_requisitions (
        id, pr_number, requester_id, department_id, status, total_amount, priority
      ) VALUES (1, 'PR-OPEN', 1, 1, 'pending_approval', 4000, 'Low');
      INSERT INTO approval_requests (requisition_id, approver_id, step_order, status)
        VALUES (1, 2, 1, 'pending');
      INSERT INTO purchase_orders (
        id, po_number, requisition_id, supplier_id, created_by, status, total_amount, issue_date
      ) VALUES
        (1, 'PO-BARE', NULL, 1, 3, 'issued', 1000, '2026-09-01'),
        (2, 'PO-UNAPPROVED', 1, 1, 3, 'issued', 4000, '2026-09-01');
      INSERT INTO po_items (po_id, item_description, quantity, unit_price, total_price, line_type) VALUES
        (1, 'Mouse', 1, 1000, 1000, 'goods'),
        (2, 'Mouse', 1, 4000, 4000, 'goods');
      INSERT INTO goods_receipts (grn_number, po_id, received_by, receipt_date)
        VALUES ('GRN-OK', 2, 3, '2026-09-02');
      INSERT INTO invoices (
        id, invoice_number, po_id, supplier_id, invoice_date, due_date,
        subtotal, tax_amount, total_amount, status
      ) VALUES
        (1, 'INV-BARE', 1, 1, '2026-09-03', '2026-10-03', 1000, 0, 1000, 'paid'),
        (2, 'INV-UNAPPROVED-PR', 2, 1, '2026-09-03', '2026-10-03', 4000, 0, 4000, 'paid');
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
        VALUES ('invoice', 2, 'APPROVED_FOR_PAYMENT', 'David Miller', 'ap');
    `);

    const report = await queryPaymentSupport(db);
    const byInvoice = (number) => report.findings.filter((row) => row.invoice_number === number).map((row) => row.code);
    assert.deepEqual(byInvoice('INV-BARE').sort(), [
      'invoice_paid_without_approval',
      'invoice_paid_without_receipt'
    ]);
    assert.deepEqual(byInvoice('INV-UNAPPROVED-PR'), ['po_paid_without_requisition_approval']);
  });

  test('verification re-derives totals and flags a hash mismatch', async () => {
    const db = await baseDb();
    await db.exec(`
      INSERT INTO purchase_orders (
        id, po_number, supplier_id, created_by, status, total_amount, issue_date
      ) VALUES
        (1, 'PO-OK', 1, 3, 'issued', 1000, '2026-09-01'),
        (2, 'PO-BAD', 1, 3, 'issued', 9999, '2026-09-01');
      INSERT INTO po_items (po_id, item_description, quantity, unit_price, total_price) VALUES
        (1, 'Ok', 1, 1000, 1000),
        (2, 'Bad', 1, 1000, 1000);
      INSERT INTO purchase_requisitions (
        id, pr_number, requester_id, department_id, status, total_amount, priority
      ) VALUES (1, 'PR-BAD', 1, 1, 'draft', 50, 'Low');
      INSERT INTO requisition_items (
        requisition_id, item_description, category, quantity, unit_price, total_price
      ) VALUES (1, 'Line', 'IT Hardware', 1, 10, 10);
      INSERT INTO invoices (
        id, invoice_number, po_id, supplier_id, invoice_date, due_date,
        subtotal, tax_amount, total_amount, status
      ) VALUES (1, 'INV-BAD', 1, 1, '2026-09-03', '2026-10-03', 100, 0, 100, 'pending_match');
      INSERT INTO invoice_items (invoice_id, po_item_id, description, quantity_invoiced, unit_price, total_price)
        VALUES (1, 1, 'Ok', 1, 40, 40);
      INSERT INTO payment_runs (
        run_number, status, actor_name, billed_total_cents, payable_total_cents, invoice_count
      ) VALUES ('PAY-BAD', 'draft', 'David Miller', 0, 500, 0);
    `);
    await db.prepare(`
      INSERT INTO compliance_audit_events (
        created_at, action, actor_name, entity_type, details, prev_hash, row_hash
      ) VALUES ('2026-01-01 00:00:00', 'TAMPER', 'Eve', 'user', 'bad', 'GENESIS', ?)
    `).run('0'.repeat(64));

    const report = await queryVerification(db);
    assert.equal(report.currency, 'EUR');
    const codes = new Set(report.findings.map((row) => row.code));
    assert.ok(codes.has('po_total_mismatch'));
    assert.ok(codes.has('requisition_total_mismatch'));
    assert.ok(codes.has('invoice_total_mismatch'));
    assert.ok(codes.has('payment_run_payable_mismatch'));
    assert.ok(codes.has('hash_chain_digest_mismatch'));
    assert.equal(
      report.findings.some((row) => row.document_number === 'PO-OK'),
      false
    );
    const po = report.findings.find((row) => row.code === 'po_total_mismatch');
    assert.equal(po.stored_cents, 9999);
    assert.equal(po.derived_cents, 1000);
  });
});

describe('compliance API access and CSV', () => {
  test('session actor is stamped and a body persona is ignored', async () => {
    const db = await baseDb();
    const password = 'correct-horse';
    const hash = await hashPassword(password, 4);
    await db.prepare(`INSERT INTO user_credentials (user_id, password_hash) VALUES (1, ?)`).run(hash);
    const app = appFor(db);

    await withServer(app, async (base) => {
      const failed = await json(await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'alice@example.com',
          password: 'wrong',
          actor_name: 'Elena Rostova',
          actor_user_id: 99
        })
      }));
      assert.equal(failed.status, 401);

      const signedIn = await json(await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'alice@example.com',
          password,
          actor_name: 'Elena Rostova',
          actor_user_id: 99
        })
      }));
      assert.equal(signedIn.status, 200);

      const patched = await json(await fetch(`${base}/api/users/1`, withCookie(5, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Lead',
          actor_name: 'Alice Chen',
          actor_user_id: 1
        })
      })));
      assert.equal(patched.status, 200);
    });

    const events = await db.prepare(`
      SELECT action, actor_user_id, actor_name, details
      FROM compliance_audit_events
      ORDER BY id ASC
    `).all();
    const failure = events.find((row) => row.action === 'LOCAL_LOGIN_FAILURE');
    const success = events.find((row) => row.action === 'LOCAL_LOGIN_SUCCESS');
    const update = events.find((row) => row.action === 'USER_UPDATED');
    assert.equal(failure.actor_name, 'alice@example.com');
    assert.equal(Number(failure.actor_user_id), 1);
    assert.equal(Number(success.actor_user_id), 1);
    assert.equal(success.actor_name, 'Alice Chen');
    assert.equal(Number(update.actor_user_id), 5);
    assert.equal(update.actor_name, 'Elena Rostova');
    assert.match(update.details, /Lead|title|previous_role|"role":"requester"/);
  });

  test('non-admin roles are denied and CSV export is logged for finance', async () => {
    const db = await baseDb();
    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details, created_at)
      VALUES ('invoice', 3, 'PAID', 'David Miller', 'said "hello", world', '2026-09-03 10:00:00')
    `).run();
    await db.exec(`
      INSERT INTO purchase_orders (
        id, po_number, supplier_id, created_by, status, total_amount, issue_date
      ) VALUES (1, 'PO-BAD', 1, 3, 'issued', 9999, '2026-09-01');
      INSERT INTO po_items (po_id, item_description, quantity, unit_price, total_price)
        VALUES (1, 'Bad', 1, 1000, 1000);
    `);
    const app = appFor(db);
    const reports = ['audit-trail', 'approval-policy', 'payment-support', 'verification'];

    await withServer(app, async (base) => {
      const health = await json(await fetch(`${base}/api/health`));
      assert.equal(health.status, 200);
      const openRequisitions = await json(await fetch(`${base}/api/requisitions`));
      assert.equal(openRequisitions.status, 401);

      for (const report of reports) {
        const anon = await json(await fetch(`${base}/api/compliance/${report}`));
        assert.equal(anon.status, 401, report);
        for (const userId of [1, 2, 3]) {
          const denied = await json(await fetch(
            `${base}/api/compliance/${report}`,
            withCookie(userId)
          ));
          assert.equal(denied.status, 403, `${report} user ${userId}`);
        }
        const allowed = await json(await fetch(
          `${base}/api/compliance/${report}`,
          withCookie(4)
        ));
        assert.equal(allowed.status, 200, report);
        if (report === 'verification') {
          assert.equal(allowed.body.currency, 'EUR');
        }
        const admin = await json(await fetch(
          `${base}/api/compliance/${report}`,
          withCookie(5)
        ));
        assert.equal(admin.status, 200, report);
      }

      const exported = await fetch(
        `${base}/api/compliance/audit-trail?format=csv&action=PAID`,
        withCookie(4)
      );
      assert.equal(exported.status, 200);
      assert.match(exported.headers.get('content-type') || '', /text\/csv/);
      const csv = await exported.text();
      const [header, first] = csv.trim().split(/\n/);
      assert.equal(
        header,
        'source,source_id,created_at,action,actor_user_id,actor_name,entity_type,entity_id,details'
      );
      assert.match(first, /^audit_logs,1,2026-09-03 10:00:00,PAID,,David Miller,invoice,3,/);
      assert.match(first, /"said ""hello"", world"/);
      assert.equal(csv.endsWith('\n'), true);
      assert.equal(csv.includes('COMPLIANCE_EXPORT'), false);

      const verificationCsv = await fetch(
        `${base}/api/compliance/verification?format=csv`,
        withCookie(4)
      );
      const verificationText = await verificationCsv.text();
      assert.equal(verificationCsv.status, 200);
      assert.match(verificationText.split('\n')[0], /,currency$/);
      assert.match(verificationText, /EUR/);
    });

    const exportEvents = await db.prepare(`
      SELECT action, actor_user_id, actor_name, entity_type, details
      FROM compliance_audit_events
      WHERE action = 'COMPLIANCE_EXPORT'
    `).all();
    const exportEvent = exportEvents.find((row) => String(row.details).includes('audit-trail'));
    assert.equal(Number(exportEvent.actor_user_id), 4);
    assert.equal(exportEvent.actor_name, 'David Miller');
    assert.equal(exportEvent.entity_type, 'compliance_report');
    assert.match(exportEvent.details, /audit-trail/);
    assert.match(exportEvent.details, /csv/);
  });

  test('a CSV build failure does not write COMPLIANCE_EXPORT', async () => {
    const db = await baseDb();
    const user = { id: 4, name: 'David Miller', role: 'finance' };
    await assert.rejects(
      () => prepareComplianceCsv({
        db,
        user,
        report: 'audit-trail',
        columns: ['action'],
        rows: [{ action: 'PAID' }],
        filters: { action: 'PAID' },
        buildCsv() {
          throw new Error('csv build failed');
        }
      }),
      /csv build failed/
    );
    const afterThrow = await db.prepare(`
      SELECT COUNT(*) AS n FROM compliance_audit_events WHERE action = 'COMPLIANCE_EXPORT'
    `).get();
    assert.equal(Number(afterThrow.n), 0);

    let exportsDuringBuild = null;
    const csv = await prepareComplianceCsv({
      db,
      user,
      report: 'verification',
      columns: ['code'],
      rows: [{ code: 'ok' }],
      buildCsv(columns, rows) {
        const during = db.prepare(`
          SELECT COUNT(*) AS n FROM compliance_audit_events WHERE action = 'COMPLIANCE_EXPORT'
        `).get();
        exportsDuringBuild = Number(during.n);
        return toCsv(columns, rows);
      }
    });
    assert.equal(exportsDuringBuild, 0);
    assert.equal(csv, 'code\nok\n');
    const afterOk = await db.prepare(`
      SELECT COUNT(*) AS n FROM compliance_audit_events WHERE action = 'COMPLIANCE_EXPORT'
    `).get();
    assert.equal(Number(afterOk.n), 1);
  });
});
