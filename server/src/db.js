import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const schemaPath = path.join(__dirname, 'schema.sql');

const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = process.env.PROCUREMENT_DB_PATH || path.join(dataDir, 'procurement.db');
const db = new Database(dbPath);

// Enable foreign keys and WAL mode for reliability and performance
db.pragma('foreign_keys = ON');
if (dbPath !== ':memory:') {
  db.pragma('journal_mode = WAL');
}

export function applySchema(database = db) {
  const schema = fs.readFileSync(schemaPath, 'utf8');
  database.exec(schema);
  migrateApprovalRequestsWaitingStatus(database);
  migrateInvoiceNumberUniqueness(database);
  migrateLineTypesAndServiceEntrySheets(database);
}

/** Existing DBs created before sequential routing need CHECK to allow `waiting`. */
function migrateApprovalRequestsWaitingStatus(database) {
  const row = database.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'approval_requests'`
  ).get();
  if (!row?.sql || row.sql.includes("'waiting'")) return;

  database.exec(`
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
  `);
}

/** Existing DBs created before supplier+invoice uniqueness need a unique index. */
function migrateInvoiceNumberUniqueness(database) {
  const table = database.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'invoices'`
  ).get();
  if ((table?.sql || '').includes('UNIQUE(supplier_id, invoice_number)')) return;

  const indexes = database.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'invoices'`
  ).all();
  const hasUnique = indexes.some((idx) =>
    /supplier_id/i.test(idx.sql || '') && /invoice_number/i.test(idx.sql || '')
  );
  if (hasUnique) return;

  database.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS invoices_supplier_invoice_number ON invoices(supplier_id, invoice_number)`
  );
}

function tableHasColumn(database, table, column) {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
}

const SERVICE_CATEGORY_SQL = `'Consulting & Professional Services', 'Software & Cloud', 'Marketing & Events', 'Travel & Subscriptions'`;

/** Existing DBs need line_type / quantity_accepted columns; SES tables come from schema.sql. */
function migrateLineTypesAndServiceEntrySheets(database) {
  const tables = database.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table'`
  ).all().map((row) => row.name);

  if (tables.includes('catalog_items') && !tableHasColumn(database, 'catalog_items', 'line_type')) {
    database.exec(`ALTER TABLE catalog_items ADD COLUMN line_type TEXT NOT NULL DEFAULT 'goods'`);
  }
  if (tables.includes('requisition_items') && !tableHasColumn(database, 'requisition_items', 'line_type')) {
    database.exec(`ALTER TABLE requisition_items ADD COLUMN line_type TEXT NOT NULL DEFAULT 'goods'`);
  }
  if (tables.includes('po_items') && !tableHasColumn(database, 'po_items', 'line_type')) {
    database.exec(`ALTER TABLE po_items ADD COLUMN line_type TEXT NOT NULL DEFAULT 'goods'`);
  }
  if (tables.includes('po_items') && !tableHasColumn(database, 'po_items', 'quantity_accepted')) {
    database.exec(`ALTER TABLE po_items ADD COLUMN quantity_accepted INTEGER DEFAULT 0`);
  }

  if (tables.includes('catalog_items')) {
    database.exec(
      `UPDATE catalog_items SET line_type = 'service' WHERE category IN (${SERVICE_CATEGORY_SQL})`
    );
  }
  if (tables.includes('requisition_items')) {
    database.exec(
      `UPDATE requisition_items SET line_type = 'service' WHERE category IN (${SERVICE_CATEGORY_SQL})`
    );
  }
  if (tables.includes('po_items')) {
    database.exec(
      `UPDATE po_items SET line_type = 'service' WHERE category IN (${SERVICE_CATEGORY_SQL})`
    );
  }
}

applySchema(db);

export default db;
