import fs from 'fs';
import { TursoHttpClient } from './tursoHttp.js';
import { SqliteAdapter } from './sqliteAdapter.js';
import {
  TURSO_REQUIRED_MSG,
  TursoConfigError,
  assertDeployableConfig,
  defaultSqlitePath,
  ensureSqliteDataDir,
  loadDbConfig,
  schemaPath
} from './dbConfig.js';

export { schemaPath, loadDbConfig, TursoConfigError, TURSO_REQUIRED_MSG };

const SERVICE_CATEGORY_SQL = `'Consulting & Professional Services', 'Software & Cloud', 'Marketing & Events', 'Travel & Subscriptions'`;

let cachedDb;
let cachedPromise;

async function maybe(value) {
  return value;
}

async function tableHasColumn(database, table, column) {
  const cols = await maybe(database.prepare(`PRAGMA table_info(${table})`).all());
  return (cols || []).some((c) => c.name === column);
}

/** Table rebuild used when existing DBs lack `waiting` in approval_requests CHECK. */
export const APPROVAL_REQUESTS_WAITING_MIGRATION_SQL = `
    CREATE TABLE approval_requests_migrated (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requisition_id INTEGER NOT NULL,
      approver_id INTEGER NOT NULL,
      step_order INTEGER DEFAULT 1,
      status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'waiting', 'approved', 'rejected', 'skipped')),
      comments TEXT,
      decided_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (requisition_id) REFERENCES purchase_requisitions(id) ON DELETE CASCADE,
      FOREIGN KEY (approver_id) REFERENCES users(id)
    );
    INSERT INTO approval_requests_migrated
      (id, requisition_id, approver_id, step_order, status, comments, decided_at, created_at)
      SELECT id, requisition_id, approver_id, step_order, status, comments, decided_at, created_at
      FROM approval_requests;
    DROP TABLE approval_requests;
    ALTER TABLE approval_requests_migrated RENAME TO approval_requests;
  `;

/** Existing DBs created before sequential routing need CHECK to allow `waiting`. */
async function migrateApprovalRequestsWaitingStatus(database) {
  const row = await maybe(
    database.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'approval_requests'`
    ).get()
  );
  if (!row?.sql || row.sql.includes("'waiting'")) return;

  await maybe(database.exec(APPROVAL_REQUESTS_WAITING_MIGRATION_SQL));
}

/** Existing DBs created before supplier+invoice uniqueness need a unique index. */
async function migrateInvoiceNumberUniqueness(database) {
  const table = await maybe(
    database.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'invoices'`
    ).get()
  );
  if ((table?.sql || '').includes('UNIQUE(supplier_id, invoice_number)')) return;

  const indexes = await maybe(
    database.prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'invoices'`
    ).all()
  );
  const hasUnique = (indexes || []).some((idx) =>
    /supplier_id/i.test(idx.sql || '') && /invoice_number/i.test(idx.sql || '')
  );
  if (hasUnique) return;

  await maybe(
    database.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS invoices_supplier_invoice_number ON invoices(supplier_id, invoice_number)`
    )
  );
}

/** Existing DBs need line_type / quantity_accepted columns; SES tables come from schema.sql. */
async function migrateLineTypesAndServiceEntrySheets(database) {
  const tables = (await maybe(
    database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()
  ) || []).map((row) => row.name);

  if (tables.includes('catalog_items') && !(await tableHasColumn(database, 'catalog_items', 'line_type'))) {
    await maybe(database.exec(`ALTER TABLE catalog_items ADD COLUMN line_type TEXT NOT NULL DEFAULT 'goods'`));
  }
  if (tables.includes('requisition_items') && !(await tableHasColumn(database, 'requisition_items', 'line_type'))) {
    await maybe(database.exec(`ALTER TABLE requisition_items ADD COLUMN line_type TEXT NOT NULL DEFAULT 'goods'`));
  }
  if (tables.includes('po_items') && !(await tableHasColumn(database, 'po_items', 'line_type'))) {
    await maybe(database.exec(`ALTER TABLE po_items ADD COLUMN line_type TEXT NOT NULL DEFAULT 'goods'`));
  }
  if (tables.includes('po_items') && !(await tableHasColumn(database, 'po_items', 'quantity_accepted'))) {
    await maybe(database.exec(`ALTER TABLE po_items ADD COLUMN quantity_accepted INTEGER DEFAULT 0`));
  }

  if (tables.includes('catalog_items')) {
    await maybe(database.exec(
      `UPDATE catalog_items SET line_type = 'service' WHERE category IN (${SERVICE_CATEGORY_SQL})`
    ));
  }
  if (tables.includes('requisition_items')) {
    await maybe(database.exec(
      `UPDATE requisition_items SET line_type = 'service' WHERE category IN (${SERVICE_CATEGORY_SQL})`
    ));
  }
  if (tables.includes('po_items')) {
    await maybe(database.exec(
      `UPDATE po_items SET line_type = 'service' WHERE category IN (${SERVICE_CATEGORY_SQL})`
    ));
  }
}

/** Existing DBs created before catalog master-data maintenance need status. */
async function migrateCatalogItemStatus(database) {
  const tables = (await maybe(
    database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()
  ) || []).map((row) => row.name);

  if (tables.includes('catalog_items') && !(await tableHasColumn(database, 'catalog_items', 'status'))) {
    await maybe(database.exec(
      `ALTER TABLE catalog_items ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`
    ));
  }
}

/**
 * Rebuild invoice_exception_dispositions when CHECK lacks `short_pay`
 * or `buyer_response`. `billedSelect` is `billed_total_cents` if the old
 * table already has that column, otherwise `NULL`.
 */
export function invoiceShortPayDispositionsMigrationSql(billedSelect = 'NULL') {
  return `
      CREATE TABLE invoice_exception_dispositions_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_id INTEGER NOT NULL,
        disposition TEXT NOT NULL CHECK (disposition IN ('accept_variance', 'reject_invoice', 'return_to_buyer', 'short_pay', 'buyer_response')),
        reason TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        accepted_total_cents INTEGER,
        accepted_match_status TEXT,
        billed_total_cents INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
      );
      INSERT INTO invoice_exception_dispositions_migrated
        (id, invoice_id, disposition, reason, actor_name, accepted_total_cents, accepted_match_status, billed_total_cents, created_at)
        SELECT id, invoice_id, disposition, reason, actor_name, accepted_total_cents, accepted_match_status, ${billedSelect}, created_at
        FROM invoice_exception_dispositions;
      DROP TABLE invoice_exception_dispositions;
      ALTER TABLE invoice_exception_dispositions_migrated RENAME TO invoice_exception_dispositions;
    `;
}

/**
 * Existing DBs need invoices.payable_total_cents (NULL = pay billed) and
 * invoice_exception_dispositions CHECK values (short_pay, buyer_response)
 * plus billed_total_cents. CHECK cannot be ALTERed — rebuild when missing.
 */
async function migrateInvoiceShortPay(database) {
  const tables = (await maybe(
    database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()
  ) || []).map((row) => row.name);

  if (tables.includes('invoices') && !(await tableHasColumn(database, 'invoices', 'payable_total_cents'))) {
    await maybe(database.exec(`ALTER TABLE invoices ADD COLUMN payable_total_cents INTEGER`));
  }

  if (!tables.includes('invoice_exception_dispositions')) return;

  const table = await maybe(
    database.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'invoice_exception_dispositions'`
    ).get()
  );
  const sql = table?.sql || '';
  const hasShortPayCheck = sql.includes("'short_pay'");
  const hasBuyerResponseCheck = sql.includes("'buyer_response'");
  const hasBilledCol = await tableHasColumn(database, 'invoice_exception_dispositions', 'billed_total_cents');

  if (!hasShortPayCheck || !hasBuyerResponseCheck) {
    const billedSelect = hasBilledCol ? 'billed_total_cents' : 'NULL';
    await maybe(database.exec(invoiceShortPayDispositionsMigrationSql(billedSelect)));
    return;
  }

  if (!hasBilledCol) {
    await maybe(database.exec(
      `ALTER TABLE invoice_exception_dispositions ADD COLUMN billed_total_cents INTEGER`
    ));
  }
}

/** Existing DBs created before org-admin dept heads need approver_user_id. */
export const DEPARTMENT_APPROVER_COLUMN_SQL =
  `ALTER TABLE departments ADD COLUMN approver_user_id INTEGER`;

/** Backfill mapping from the legacy first role=approver in that department. */
export const DEPARTMENT_APPROVER_BACKFILL_SQL = `
  UPDATE departments
  SET approver_user_id = (
    SELECT u.id FROM users u
    WHERE u.role = 'approver' AND u.department_id = departments.id
    ORDER BY u.id ASC
    LIMIT 1
  )
  WHERE approver_user_id IS NULL
`;

async function migrateDepartmentApprover(database) {
  const tables = (await maybe(
    database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()
  ) || []).map((row) => row.name);

  if (!tables.includes('departments')) return;

  if (!(await tableHasColumn(database, 'departments', 'approver_user_id'))) {
    await maybe(database.exec(DEPARTMENT_APPROVER_COLUMN_SQL));
  }

  if (tables.includes('users')) {
    await maybe(database.exec(DEPARTMENT_APPROVER_BACKFILL_SQL));
  }
}

/**
 * Existing DBs created before OOO substitute approvers need approval_delegations.
 * CREATE TABLE IF NOT EXISTS matches catalog/SES table bootstrap in schema.sql.
 */
export const APPROVAL_DELEGATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS approval_delegations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    delegator_user_id INTEGER NOT NULL,
    delegate_user_id INTEGER NOT NULL,
    starts_at TEXT,
    ends_at TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    reason TEXT,
    created_by_user_id INTEGER,
    created_by_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    revoked_at DATETIME,
    revoked_by_user_id INTEGER,
    revoked_by_name TEXT,
    FOREIGN KEY (delegator_user_id) REFERENCES users(id),
    FOREIGN KEY (delegate_user_id) REFERENCES users(id),
    FOREIGN KEY (created_by_user_id) REFERENCES users(id),
    FOREIGN KEY (revoked_by_user_id) REFERENCES users(id)
  )
`;

async function migrateApprovalDelegations(database) {
  await maybe(database.exec(APPROVAL_DELEGATIONS_TABLE_SQL));
}

/**
 * Existing DBs created before PO change orders need header revision columns
 * plus po_change_orders / po_change_order_items. CREATE TABLE IF NOT EXISTS
 * matches catalog/SES/delegation bootstrap in schema.sql.
 */
export const PURCHASE_ORDERS_REVISION_COLUMN_SQL =
  `ALTER TABLE purchase_orders ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`;

export const PURCHASE_ORDERS_CHANGE_ORDER_COUNT_COLUMN_SQL =
  `ALTER TABLE purchase_orders ADD COLUMN change_order_count INTEGER NOT NULL DEFAULT 0`;

export const PO_CHANGE_ORDERS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS po_change_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    po_id INTEGER NOT NULL,
    co_number TEXT UNIQUE NOT NULL,
    revision INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('draft', 'applied')),
    reason TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    notes TEXT,
    before_total_cents INTEGER NOT NULL,
    after_total_cents INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    applied_at DATETIME,
    UNIQUE(po_id, revision),
    FOREIGN KEY (po_id) REFERENCES purchase_orders(id)
  )
`;

export const PO_CHANGE_ORDER_ITEMS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS po_change_order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    change_order_id INTEGER NOT NULL,
    po_item_id INTEGER NOT NULL,
    old_quantity INTEGER NOT NULL,
    new_quantity INTEGER NOT NULL,
    old_unit_price INTEGER NOT NULL,
    new_unit_price INTEGER NOT NULL,
    notes TEXT,
    FOREIGN KEY (change_order_id) REFERENCES po_change_orders(id) ON DELETE CASCADE,
    FOREIGN KEY (po_item_id) REFERENCES po_items(id)
  )
`;

async function migratePurchaseOrderChangeOrders(database) {
  const tables = (await maybe(
    database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()
  ) || []).map((row) => row.name);

  if (tables.includes('purchase_orders') && !(await tableHasColumn(database, 'purchase_orders', 'revision'))) {
    await maybe(database.exec(PURCHASE_ORDERS_REVISION_COLUMN_SQL));
  }
  if (tables.includes('purchase_orders') && !(await tableHasColumn(database, 'purchase_orders', 'change_order_count'))) {
    await maybe(database.exec(PURCHASE_ORDERS_CHANGE_ORDER_COUNT_COLUMN_SQL));
  }

  await maybe(database.exec(PO_CHANGE_ORDERS_TABLE_SQL));
  await maybe(database.exec(PO_CHANGE_ORDER_ITEMS_TABLE_SQL));
}

export async function applySchema(database) {
  const schema = fs.readFileSync(schemaPath, 'utf8');
  await maybe(database.exec(schema));
  await migrateApprovalRequestsWaitingStatus(database);
  await migrateInvoiceNumberUniqueness(database);
  await migrateLineTypesAndServiceEntrySheets(database);
  await migrateCatalogItemStatus(database);
  await migrateInvoiceShortPay(database);
  await migrateDepartmentApprover(database);
  await migrateApprovalDelegations(database);
  await migratePurchaseOrderChangeOrders(database);
  return database;
}

async function openSqlite(sqlitePath) {
  let Database;
  try {
    ({ default: Database } = await import('better-sqlite3'));
  } catch (error) {
    throw new Error(
      `better-sqlite3 is required for local SQLite mode but could not be loaded: ${error.message}`
    );
  }
  ensureSqliteDataDir(sqlitePath);
  const raw = new Database(sqlitePath);
  raw.pragma('foreign_keys = ON');
  if (sqlitePath !== ':memory:') {
    raw.pragma('journal_mode = WAL');
  }
  return new SqliteAdapter(raw);
}

export async function openTursoDatabase(url, token, options = {}) {
  const client = new TursoHttpClient(url, token, options);
  await client.pragma('foreign_keys = ON');
  return client;
}

export async function openDatabase(config = loadDbConfig()) {
  assertDeployableConfig(config);
  if (config.useTurso) {
    const db = await openTursoDatabase(config.tursoUrl, config.tursoAuthToken);
    await applySchema(db);
    return db;
  }
  const db = await openSqlite(config.sqlitePath);
  await applySchema(db);
  return db;
}

export async function createMemoryDatabase() {
  const db = await openSqlite(':memory:');
  await applySchema(db);
  return db;
}

export function resetDbCache() {
  cachedDb = undefined;
  cachedPromise = undefined;
}

export async function getDb() {
  if (cachedDb) return cachedDb;
  if (!cachedPromise) {
    cachedPromise = openDatabase().then((db) => {
      cachedDb = db;
      return db;
    }).catch((error) => {
      cachedPromise = undefined;
      throw error;
    });
  }
  return cachedPromise;
}

export function peekCachedDb() {
  return cachedDb;
}

export { defaultSqlitePath };
