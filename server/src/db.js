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
}

applySchema(db);

export default db;
