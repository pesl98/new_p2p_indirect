import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import Database from 'better-sqlite3';
import { SqliteAdapter } from './sqliteAdapter.js';
import {
  applySchema,
  APPROVAL_REQUESTS_WAITING_MIGRATION_SQL,
  APPROVAL_DELEGATIONS_TABLE_SQL,
  invoiceShortPayDispositionsMigrationSql,
  PO_CHANGE_ORDERS_TABLE_SQL,
  PO_CHANGE_ORDER_ITEMS_TABLE_SQL,
  INVOICE_DUPLICATE_FLAGS_TABLE_SQL,
  CONTRACTS_TABLE_SQL,
  CONTRACT_ITEMS_TABLE_SQL,
  PURCHASE_REQUISITIONS_SOURCE_CONTRACT_ID_SQL,
  PURCHASE_REQUISITIONS_CONTRACT_USE_STATUS_SQL,
  PAYMENT_RUNS_TABLE_SQL,
  PAYMENT_RUN_ITEMS_TABLE_SQL,
  USERS_STATUS_COLUMN_SQL,
  USER_CREDENTIALS_TABLE_SQL,
  PURCHASE_REQUISITIONS_SKIPPED_CHECK_REBUILD_SQL,
  PURCHASE_REQUISITIONS_SKIPPED_CHECK_MIGRATION_SQL,
  purchaseRequisitionsContractUseNeedsSkippedRebuild,
  schemaPath
} from './db.js';
import { splitSqlScript } from './tursoHttp.js';

function tableSql(db, name) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
  return row?.sql || '';
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((col) => col.name);
}

describe('Turso/SQLite schema migrations', () => {
  test('each split schema.sql statement is valid SQLite (Turso exec path)', () => {
    const schema = fs.readFileSync(schemaPath, 'utf8');
    const stmts = splitSqlScript(schema);
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    for (const stmt of stmts) {
      assert.doesNotThrow(() => raw.exec(stmt), `Turso-split statement failed to parse: ${stmt.slice(0, 120)}`);
    }
    const invoicesCols = raw.prepare(`PRAGMA table_info(invoices)`).all().map((col) => col.name);
    assert.ok(invoicesCols.includes('payable_total_cents'));
    assert.ok(invoicesCols.includes('duplicate_status'));
    assert.ok(raw.prepare(`SELECT sql FROM sqlite_master WHERE name = 'invoice_duplicate_flags'`).get());
    const deptCols = raw.prepare(`PRAGMA table_info(departments)`).all().map((col) => col.name);
    assert.ok(deptCols.includes('approver_user_id'));
    const delegationCols = raw.prepare(`PRAGMA table_info(approval_delegations)`).all().map((col) => col.name);
    assert.ok(delegationCols.includes('delegator_user_id'));
    assert.ok(delegationCols.includes('delegate_user_id'));
    assert.ok(delegationCols.includes('starts_at'));
    assert.ok(delegationCols.includes('active'));
    const poCols = raw.prepare(`PRAGMA table_info(purchase_orders)`).all().map((col) => col.name);
    assert.ok(poCols.includes('revision'));
    assert.ok(poCols.includes('change_order_count'));
    const coCols = raw.prepare(`PRAGMA table_info(po_change_orders)`).all().map((col) => col.name);
    assert.ok(coCols.includes('co_number'));
    assert.ok(coCols.includes('before_total_cents'));
    assert.ok(raw.prepare(`SELECT sql FROM sqlite_master WHERE name = 'po_change_order_items'`).get());
    assert.ok(raw.prepare(`SELECT sql FROM sqlite_master WHERE name = 'contracts'`).get());
    assert.ok(raw.prepare(`SELECT sql FROM sqlite_master WHERE name = 'contract_items'`).get());
    const contractCols = raw.prepare(`PRAGMA table_info(contracts)`).all().map((col) => col.name);
    assert.ok(contractCols.includes('annual_value_cents'));
    assert.ok(contractCols.includes('contract_number'));
    const prCols = raw.prepare(`PRAGMA table_info(purchase_requisitions)`).all().map((col) => col.name);
    assert.ok(prCols.includes('source_contract_id'));
    assert.ok(prCols.includes('contract_use_status'));
    const prSql = raw.prepare(`SELECT sql FROM sqlite_master WHERE name = 'purchase_requisitions'`).get().sql;
    assert.match(prSql, /contract_use_status TEXT NOT NULL DEFAULT 'none'/);
    assert.match(prSql, /'skipped'/);
    assert.ok(raw.prepare(`SELECT sql FROM sqlite_master WHERE name = 'payment_runs'`).get());
    assert.ok(raw.prepare(`SELECT sql FROM sqlite_master WHERE name = 'payment_run_items'`).get());
    const payCols = raw.prepare(`PRAGMA table_info(payment_runs)`).all().map((col) => col.name);
    assert.ok(payCols.includes('run_number'));
    assert.ok(payCols.includes('payable_total_cents'));
    assert.ok(payCols.includes('payment_reference'));
    const userCols = raw.prepare(`PRAGMA table_info(users)`).all().map((col) => col.name);
    assert.ok(userCols.includes('status'));
    assert.ok(userCols.includes('approval_limit'));
    assert.ok(raw.prepare(`SELECT sql FROM sqlite_master WHERE name = 'user_credentials'`).get());
    const credCols = raw.prepare(`PRAGMA table_info(user_credentials)`).all().map((col) => col.name);
    assert.ok(credCols.includes('password_hash'));
    assert.ok(credCols.includes('user_id'));
  });

  test('po_change_orders CREATE TABLE is a single Turso-split statement', () => {
    const header = splitSqlScript(PO_CHANGE_ORDERS_TABLE_SQL);
    assert.equal(header.length, 1);
    assert.match(header[0], /CREATE TABLE IF NOT EXISTS po_change_orders/i);
    assert.match(header[0], /UNIQUE\(po_id, revision\)/);
    const items = splitSqlScript(PO_CHANGE_ORDER_ITEMS_TABLE_SQL);
    assert.equal(items.length, 1);
    assert.match(items[0], /CREATE TABLE IF NOT EXISTS po_change_order_items/i);
  });

  test('invoice_duplicate_flags CREATE TABLE is a single Turso-split statement', () => {
    const stmts = splitSqlScript(INVOICE_DUPLICATE_FLAGS_TABLE_SQL);
    assert.equal(stmts.length, 1);
    assert.match(stmts[0], /CREATE TABLE IF NOT EXISTS invoice_duplicate_flags/i);
    assert.match(stmts[0], /candidate_invoice_id/);
    assert.match(stmts[0], /same_amount_near_date/);
    assert.match(stmts[0], /confirmed_duplicate/);
  });

  test('contracts CREATE TABLE statements are each a single Turso-split statement', () => {
    const header = splitSqlScript(CONTRACTS_TABLE_SQL);
    assert.equal(header.length, 1);
    assert.match(header[0], /CREATE TABLE IF NOT EXISTS contracts/i);
    assert.match(header[0], /annual_value_cents INTEGER NOT NULL/);
    const items = splitSqlScript(CONTRACT_ITEMS_TABLE_SQL);
    assert.equal(items.length, 1);
    assert.match(items[0], /CREATE TABLE IF NOT EXISTS contract_items/i);
    assert.match(items[0], /unit_price INTEGER NOT NULL/);
  });

  test('payment_runs CREATE TABLE statements are each a single Turso-split statement', () => {
    const header = splitSqlScript(PAYMENT_RUNS_TABLE_SQL);
    assert.equal(header.length, 1);
    assert.match(header[0], /CREATE TABLE IF NOT EXISTS payment_runs/i);
    assert.match(header[0], /run_number TEXT UNIQUE NOT NULL/);
    assert.match(header[0], /payable_total_cents INTEGER NOT NULL DEFAULT 0/);
    const items = splitSqlScript(PAYMENT_RUN_ITEMS_TABLE_SQL);
    assert.equal(items.length, 1);
    assert.match(items[0], /CREATE TABLE IF NOT EXISTS payment_run_items/i);
    assert.match(items[0], /UNIQUE\(run_id, invoice_id\)/);
  });

  test('user auth ALTER/CREATE statements are each a single Turso-split statement', () => {
    const statusSql = splitSqlScript(USERS_STATUS_COLUMN_SQL);
    assert.equal(statusSql.length, 1);
    assert.match(statusSql[0], /ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'/);
    const creds = splitSqlScript(USER_CREDENTIALS_TABLE_SQL);
    assert.equal(creds.length, 1);
    assert.match(creds[0], /CREATE TABLE IF NOT EXISTS user_credentials/i);
    assert.match(creds[0], /password_hash TEXT NOT NULL/);
  });

  test('purchase_requisitions contract-link ALTER statements are single Turso-split statements', () => {
    const idSql = splitSqlScript(PURCHASE_REQUISITIONS_SOURCE_CONTRACT_ID_SQL);
    assert.equal(idSql.length, 1);
    assert.match(idSql[0], /ALTER TABLE purchase_requisitions ADD COLUMN source_contract_id INTEGER/);
    const statusSql = splitSqlScript(PURCHASE_REQUISITIONS_CONTRACT_USE_STATUS_SQL);
    assert.equal(statusSql.length, 1);
    assert.match(statusSql[0], /ALTER TABLE purchase_requisitions ADD COLUMN contract_use_status TEXT NOT NULL DEFAULT 'none'/);
  });

  test('purchase_requisitions skipped CHECK rebuild SQL splits into four complete statements', () => {
    const stmts = splitSqlScript(PURCHASE_REQUISITIONS_SKIPPED_CHECK_REBUILD_SQL);
    assert.equal(stmts.length, 4);
    assert.match(stmts[0], /CREATE TABLE purchase_requisitions_migrated/i);
    assert.match(stmts[0], /CHECK \(contract_use_status IN \('none', 'proposed', 'allowed', 'refused', 'skipped'\)\)/);
    assert.match(stmts[0], /\)\s*$/);
    assert.match(stmts[1], /^INSERT INTO purchase_requisitions_migrated/i);
    assert.match(stmts[2], /^DROP TABLE purchase_requisitions/i);
    assert.match(stmts[3], /^ALTER TABLE purchase_requisitions_migrated RENAME TO purchase_requisitions/i);

    const full = splitSqlScript(PURCHASE_REQUISITIONS_SKIPPED_CHECK_MIGRATION_SQL);
    assert.equal(full.length, 6);
    assert.match(full[0], /PRAGMA foreign_keys = OFF/i);
    assert.match(full[5], /PRAGMA foreign_keys = ON/i);
  });

  test('purchaseRequisitionsContractUseNeedsSkippedRebuild detects #26 CHECK only', () => {
    assert.equal(
      purchaseRequisitionsContractUseNeedsSkippedRebuild(
        `CREATE TABLE purchase_requisitions (contract_use_status TEXT NOT NULL DEFAULT 'none' CHECK (contract_use_status IN ('none', 'proposed', 'allowed', 'refused')))`
      ),
      true
    );
    assert.equal(
      purchaseRequisitionsContractUseNeedsSkippedRebuild(
        `CREATE TABLE purchase_requisitions (contract_use_status TEXT NOT NULL DEFAULT 'none' CHECK (contract_use_status IN ('none', 'proposed', 'allowed', 'refused', 'skipped')))`
      ),
      false
    );
    assert.equal(
      purchaseRequisitionsContractUseNeedsSkippedRebuild(
        `CREATE TABLE purchase_requisitions (status TEXT CHECK (status IN ('draft')), contract_use_status TEXT NOT NULL DEFAULT 'none')`
      ),
      false
    );
  });

  test('approval_delegations CREATE TABLE is a single Turso-split statement', () => {
    const stmts = splitSqlScript(APPROVAL_DELEGATIONS_TABLE_SQL);
    assert.equal(stmts.length, 1);
    assert.match(stmts[0], /CREATE TABLE IF NOT EXISTS approval_delegations/i);
    assert.match(stmts[0], /delegator_user_id/);
    assert.match(stmts[0], /CHECK \(active IN \(0, 1\)\)/);
  });

  test('approval waiting rebuild SQL splits into four complete statements', () => {
    const stmts = splitSqlScript(APPROVAL_REQUESTS_WAITING_MIGRATION_SQL);
    assert.equal(stmts.length, 4);
    assert.match(stmts[0], /CREATE TABLE approval_requests_migrated/i);
    assert.match(stmts[0], /CHECK \(status IN \('pending', 'waiting', 'approved', 'rejected', 'skipped'\)\)/);
    assert.match(stmts[0], /\)\s*$/);
    assert.match(stmts[1], /^INSERT INTO approval_requests_migrated/i);
    assert.match(stmts[2], /^DROP TABLE approval_requests/i);
    assert.match(stmts[3], /^ALTER TABLE approval_requests_migrated RENAME TO approval_requests/i);
  });

  test('invoice short-pay CHECK rebuild SQL splits into four complete statements', () => {
    const stmts = splitSqlScript(invoiceShortPayDispositionsMigrationSql('NULL'));
    assert.equal(stmts.length, 4);
    assert.match(stmts[0], /CREATE TABLE invoice_exception_dispositions_migrated/i);
    assert.match(stmts[0], /'short_pay'/);
    assert.match(stmts[0], /'buyer_response'/);
    assert.match(stmts[0], /\)\s*$/);
    assert.match(stmts[1], /^INSERT INTO invoice_exception_dispositions_migrated/i);
    assert.match(stmts[1], /NULL/);
    assert.match(stmts[2], /^DROP TABLE invoice_exception_dispositions/i);
    assert.match(stmts[3], /RENAME TO invoice_exception_dispositions/i);

    const withCol = splitSqlScript(invoiceShortPayDispositionsMigrationSql('billed_total_cents'));
    assert.match(withCol[1], /accepted_match_status, billed_total_cents, created_at/);
  });

  test('applySchema adds catalog status, payable_total_cents, and short_pay CHECK on existing tables', async () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = new SqliteAdapter(raw);

    db.exec(`
      CREATE TABLE departments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL
      );
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        role TEXT NOT NULL,
        department_id INTEGER,
        title TEXT,
        approval_limit INTEGER DEFAULT 0,
        avatar TEXT
      );
      CREATE TABLE suppliers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        code TEXT UNIQUE NOT NULL,
        status TEXT DEFAULT 'active'
      );
      CREATE TABLE catalog_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sku TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        category TEXT NOT NULL,
        unit TEXT DEFAULT 'each',
        unit_price INTEGER NOT NULL,
        preferred_supplier_id INTEGER,
        lead_time_days INTEGER DEFAULT 3,
        image_url TEXT,
        line_type TEXT NOT NULL DEFAULT 'goods'
      );
      CREATE TABLE purchase_requisitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_number TEXT UNIQUE NOT NULL,
        requester_id INTEGER NOT NULL,
        department_id INTEGER NOT NULL,
        status TEXT DEFAULT 'draft',
        total_amount INTEGER DEFAULT 0
      );
      CREATE TABLE approval_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        requisition_id INTEGER NOT NULL,
        approver_id INTEGER NOT NULL,
        step_order INTEGER DEFAULT 1,
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'skipped')),
        comments TEXT,
        decided_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE purchase_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        po_number TEXT UNIQUE NOT NULL,
        supplier_id INTEGER NOT NULL,
        created_by INTEGER NOT NULL,
        status TEXT DEFAULT 'issued',
        total_amount INTEGER NOT NULL,
        issue_date TEXT NOT NULL
      );
      CREATE TABLE invoices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_number TEXT NOT NULL,
        po_id INTEGER NOT NULL,
        supplier_id INTEGER NOT NULL,
        invoice_date TEXT NOT NULL,
        due_date TEXT NOT NULL,
        subtotal INTEGER NOT NULL,
        tax_amount INTEGER DEFAULT 0,
        total_amount INTEGER NOT NULL,
        status TEXT DEFAULT 'pending_match',
        match_status TEXT DEFAULT 'pending'
      );
      CREATE TABLE invoice_exception_dispositions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_id INTEGER NOT NULL,
        disposition TEXT NOT NULL CHECK (disposition IN ('accept_variance', 'reject_invoice', 'return_to_buyer')),
        reason TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        accepted_total_cents INTEGER,
        accepted_match_status TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    db.exec(`
      INSERT INTO departments (id, code, name) VALUES (1, 'MKT', 'Marketing');
      INSERT INTO users (id, name, email, role, department_id) VALUES (1, 'Alice', 'a@example.com', 'requester', 1);
      INSERT INTO suppliers (id, name, code) VALUES (1, 'Vendor Co', 'SUP-1');
      INSERT INTO catalog_items (id, sku, name, category, unit_price, line_type)
        VALUES (1, 'SKU-OLD-1', 'Legacy item', 'Office Supplies', 199, 'goods');
      INSERT INTO purchase_requisitions (id, pr_number, requester_id, department_id, status, total_amount)
        VALUES (1, 'PR-OLD-1', 1, 1, 'pending_approval', 199);
      INSERT INTO approval_requests (id, requisition_id, approver_id, step_order, status)
        VALUES (1, 1, 1, 1, 'pending');
      INSERT INTO purchase_orders (id, po_number, supplier_id, created_by, status, total_amount, issue_date)
        VALUES (1, 'PO-OLD-1', 1, 1, 'issued', 199, '2026-09-01');
      INSERT INTO invoices (id, invoice_number, po_id, supplier_id, invoice_date, due_date, subtotal, total_amount)
        VALUES (1, 'INV-OLD-1', 1, 1, '2026-09-04', '2026-10-04', 199, 199);
      INSERT INTO invoice_exception_dispositions (invoice_id, disposition, reason, actor_name)
        VALUES (1, 'return_to_buyer', 'qty mismatch', 'David Miller');
    `);

    await applySchema(db);

    assert.ok(columnNames(db, 'catalog_items').includes('status'));
    assert.equal(
      db.prepare(`SELECT status FROM catalog_items WHERE id = 1`).get().status,
      'active'
    );

    assert.ok(columnNames(db, 'invoices').includes('payable_total_cents'));
    assert.equal(
      db.prepare(`SELECT payable_total_cents FROM invoices WHERE id = 1`).get().payable_total_cents,
      null
    );

    const approvalSql = tableSql(db, 'approval_requests');
    assert.match(approvalSql, /'waiting'/);
    assert.equal(
      db.prepare(`SELECT status FROM approval_requests WHERE id = 1`).get().status,
      'pending'
    );

    const dispositionSql = tableSql(db, 'invoice_exception_dispositions');
    assert.match(dispositionSql, /'short_pay'/);
    assert.match(dispositionSql, /'buyer_response'/);
    assert.ok(columnNames(db, 'invoice_exception_dispositions').includes('billed_total_cents'));
    const kept = db.prepare(
      `SELECT disposition, reason, billed_total_cents FROM invoice_exception_dispositions WHERE invoice_id = 1`
    ).get();
    assert.equal(kept.disposition, 'return_to_buyer');
    assert.equal(kept.reason, 'qty mismatch');
    assert.equal(kept.billed_total_cents, null);

    assert.ok(columnNames(db, 'departments').includes('approver_user_id'));
    assert.ok(columnNames(db, 'approval_delegations').includes('delegator_user_id'));
    assert.ok(columnNames(db, 'approval_delegations').includes('revoked_at'));
    assert.ok(columnNames(db, 'purchase_orders').includes('revision'));
    assert.ok(columnNames(db, 'purchase_orders').includes('change_order_count'));
    assert.equal(db.prepare(`SELECT revision FROM purchase_orders WHERE id = 1`).get().revision, 0);
    assert.ok(columnNames(db, 'po_change_orders').includes('co_number'));
    assert.ok(columnNames(db, 'po_change_order_items').includes('po_item_id'));
    assert.ok(columnNames(db, 'invoices').includes('duplicate_status'));
    assert.equal(
      db.prepare(`SELECT duplicate_status FROM invoices WHERE id = 1`).get().duplicate_status,
      'clear'
    );
    assert.ok(columnNames(db, 'invoice_duplicate_flags').includes('candidate_invoice_id'));
    assert.ok(columnNames(db, 'invoice_duplicate_flags').includes('match_rule'));
    assert.ok(columnNames(db, 'contracts').includes('annual_value_cents'));
    assert.ok(columnNames(db, 'contract_items').includes('unit_price'));
    assert.ok(columnNames(db, 'purchase_requisitions').includes('source_contract_id'));
    assert.ok(columnNames(db, 'purchase_requisitions').includes('contract_use_status'));
    assert.equal(
      db.prepare(`SELECT source_contract_id, contract_use_status FROM purchase_requisitions WHERE id = 1`).get().contract_use_status,
      'none'
    );
    assert.ok(columnNames(db, 'payment_runs').includes('run_number'));
    assert.ok(columnNames(db, 'payment_run_items').includes('invoice_id'));
    assert.ok(columnNames(db, 'payment_run_items').includes('payable_total_cents'));
    assert.ok(columnNames(db, 'users').includes('status'));
    assert.equal(
      db.prepare(`SELECT status FROM users WHERE id = 1`).get().status,
      'active'
    );
    assert.ok(columnNames(db, 'user_credentials').includes('password_hash'));
  });

  test('applySchema rebuilds purchase_requisitions CHECK so skipped opt-out works on #26-era tables', async () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = new SqliteAdapter(raw);

    db.exec(`
      CREATE TABLE departments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL
      );
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        role TEXT NOT NULL,
        department_id INTEGER,
        FOREIGN KEY (department_id) REFERENCES departments(id)
      );
      CREATE TABLE suppliers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        code TEXT UNIQUE NOT NULL
      );
      CREATE TABLE purchase_requisitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_number TEXT UNIQUE NOT NULL,
        requester_id INTEGER NOT NULL,
        department_id INTEGER NOT NULL,
        status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'pending_approval', 'approved', 'rejected', 'converted_to_po')),
        total_amount INTEGER DEFAULT 0,
        justification TEXT,
        needed_by_date TEXT,
        priority TEXT DEFAULT 'Medium' CHECK (priority IN ('Low', 'Medium', 'High', 'Urgent')),
        source_contract_id INTEGER,
        contract_use_status TEXT NOT NULL DEFAULT 'none' CHECK (contract_use_status IN ('none', 'proposed', 'allowed', 'refused')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (requester_id) REFERENCES users(id),
        FOREIGN KEY (department_id) REFERENCES departments(id)
      );
      CREATE TABLE requisition_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        requisition_id INTEGER NOT NULL,
        catalog_item_id INTEGER,
        item_description TEXT NOT NULL,
        category TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        unit_price INTEGER NOT NULL,
        total_price INTEGER NOT NULL,
        estimated_supplier_id INTEGER,
        FOREIGN KEY (requisition_id) REFERENCES purchase_requisitions(id) ON DELETE CASCADE
      );
      CREATE TABLE purchase_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        po_number TEXT UNIQUE NOT NULL,
        requisition_id INTEGER,
        supplier_id INTEGER NOT NULL,
        created_by INTEGER NOT NULL,
        status TEXT DEFAULT 'issued',
        total_amount INTEGER NOT NULL,
        issue_date TEXT NOT NULL,
        FOREIGN KEY (requisition_id) REFERENCES purchase_requisitions(id)
      );
    `);

    db.exec(`
      INSERT INTO departments (id, code, name) VALUES (1, 'MKT', 'Marketing');
      INSERT INTO users (id, name, email, role, department_id) VALUES (1, 'Alice', 'a@example.com', 'requester', 1);
      INSERT INTO suppliers (id, name, code) VALUES (1, 'Vendor Co', 'SUP-1');
      INSERT INTO purchase_requisitions (id, pr_number, requester_id, department_id, status, total_amount, justification, contract_use_status)
        VALUES (1, 'PR-OLD-26', 1, 1, 'draft', 54000, 'Figma seat', 'none');
      INSERT INTO requisition_items (id, requisition_id, item_description, category, quantity, unit_price, total_price)
        VALUES (1, 1, 'Figma seat', 'Software & Cloud', 1, 54000, 54000);
      INSERT INTO purchase_orders (id, po_number, requisition_id, supplier_id, created_by, status, total_amount, issue_date)
        VALUES (1, 'PO-OLD-26', 1, 1, 1, 'issued', 54000, '2026-09-01');
    `);

    assert.throws(
      () => db.prepare(`UPDATE purchase_requisitions SET contract_use_status = 'skipped' WHERE id = 1`).run(),
      /CHECK/i
    );

    await applySchema(db);

    const sql = tableSql(db, 'purchase_requisitions');
    assert.match(sql, /'skipped'/);
    assert.equal(purchaseRequisitionsContractUseNeedsSkippedRebuild(sql), false);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM requisition_items WHERE requisition_id = 1`).get().n, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM purchase_orders WHERE requisition_id = 1`).get().n, 1);

    db.prepare(`UPDATE purchase_requisitions SET contract_use_status = 'skipped' WHERE id = 1`).run();
    assert.equal(
      db.prepare(`SELECT contract_use_status FROM purchase_requisitions WHERE id = 1`).get().contract_use_status,
      'skipped'
    );
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM requisition_items`).get().n, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM purchase_orders`).get().n, 1);
  });

  test('applySchema rebuilds dispositions CHECK to add buyer_response on short_pay-era tables', async () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = new SqliteAdapter(raw);

    db.exec(`
      CREATE TABLE invoices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_number TEXT NOT NULL,
        po_id INTEGER NOT NULL,
        supplier_id INTEGER NOT NULL,
        invoice_date TEXT NOT NULL,
        due_date TEXT NOT NULL,
        subtotal INTEGER NOT NULL,
        tax_amount INTEGER DEFAULT 0,
        total_amount INTEGER NOT NULL,
        payable_total_cents INTEGER,
        status TEXT DEFAULT 'pending_match',
        match_status TEXT DEFAULT 'pending'
      );
      CREATE TABLE invoice_exception_dispositions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_id INTEGER NOT NULL,
        disposition TEXT NOT NULL CHECK (disposition IN ('accept_variance', 'reject_invoice', 'return_to_buyer', 'short_pay')),
        reason TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        accepted_total_cents INTEGER,
        accepted_match_status TEXT,
        billed_total_cents INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO invoices (id, invoice_number, po_id, supplier_id, invoice_date, due_date, subtotal, total_amount)
        VALUES (1, 'INV-OLD-2', 1, 1, '2026-09-04', '2026-10-04', 199, 199);
      INSERT INTO invoice_exception_dispositions (invoice_id, disposition, reason, actor_name, billed_total_cents)
        VALUES (1, 'return_to_buyer', 'qty mismatch', 'David Miller', 199);
    `);

    await applySchema(db);

    const dispositionSql = tableSql(db, 'invoice_exception_dispositions');
    assert.match(dispositionSql, /'buyer_response'/);
    assert.match(dispositionSql, /'short_pay'/);
    const kept = db.prepare(
      `SELECT disposition, billed_total_cents FROM invoice_exception_dispositions WHERE invoice_id = 1`
    ).get();
    assert.equal(kept.disposition, 'return_to_buyer');
    assert.equal(kept.billed_total_cents, 199);
  });

  test('applySchema backfills departments.approver_user_id from role=approver', async () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = new SqliteAdapter(raw);

    db.exec(`
      CREATE TABLE departments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL
      );
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        role TEXT NOT NULL,
        department_id INTEGER
      );
      INSERT INTO departments (id, code, name) VALUES
        (1, 'MKT', 'Marketing'),
        (2, 'ITE', 'IT');
      INSERT INTO users (id, name, email, role, department_id) VALUES
        (1, 'Alice', 'a@example.com', 'requester', 1),
        (2, 'Bob', 'b@example.com', 'approver', 1);
    `);

    await applySchema(db);

    assert.ok(columnNames(db, 'departments').includes('approver_user_id'));
    assert.equal(
      db.prepare(`SELECT approver_user_id FROM departments WHERE id = 1`).get().approver_user_id,
      2
    );
    assert.equal(
      db.prepare(`SELECT approver_user_id FROM departments WHERE id = 2`).get().approver_user_id,
      null
    );
  });
});
