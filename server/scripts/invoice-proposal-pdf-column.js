#!/usr/bin/env node
/**
 * Report or repair a leftover invoice_proposals.pdf_bytes column.
 * Dry-run unless --confirm. Opens only the SQLite file you pass.
 * It does not read TURSO_DATABASE_URL and it does not rebuild the table.
 *
 *   node server/scripts/invoice-proposal-pdf-column.js --sqlite server/data/throwaway.db
 *   node server/scripts/invoice-proposal-pdf-column.js --sqlite server/data/throwaway.db --confirm
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { SqliteAdapter } from '../src/sqliteAdapter.js';
import {
  inspectInvoiceProposalPdfColumn,
  repairInvoiceProposalPdfColumn
} from '../src/invoiceProposalPdfColumn.js';

const args = process.argv.slice(2);
const confirm = args.includes('--confirm');
const flag = args.indexOf('--sqlite');
const fileArg = flag === -1 ? null : args[flag + 1];

if (!fileArg || fileArg.startsWith('--')) {
  console.error('Usage: node server/scripts/invoice-proposal-pdf-column.js --sqlite <file> [--confirm]');
  console.error('Dry-run is the default. --confirm copies bytes into invoice_proposal_files, then DROP COLUMN pdf_bytes.');
  console.error('This script never opens TURSO_DATABASE_URL.');
  process.exit(2);
}

const file = path.resolve(fileArg);
if (!fs.existsSync(file)) {
  console.error(`SQLite file not found: ${file}`);
  process.exit(2);
}

const raw = new Database(file);
raw.pragma('foreign_keys = ON');
const db = new SqliteAdapter(raw);
try {
  const report = confirm
    ? await repairInvoiceProposalPdfColumn(db, { confirm: true })
    : await inspectInvoiceProposalPdfColumn(db);
  console.log(JSON.stringify(report, null, 2));
  if (!confirm && report.needsRepair) {
    console.error('Dry-run only. Re-run with --confirm to copy bytes and drop pdf_bytes.');
  }
} finally {
  db.close();
}
