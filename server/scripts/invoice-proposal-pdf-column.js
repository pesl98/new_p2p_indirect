#!/usr/bin/env node
/**
 * Report or repair a leftover invoice_proposals.pdf_bytes column.
 * Read-only unless --apply (or --confirm). Never rebuilds the table.
 *
 *   node server/scripts/invoice-proposal-pdf-column.js --sqlite server/data/throwaway.db
 *   node server/scripts/invoice-proposal-pdf-column.js --sqlite server/data/throwaway.db --apply
 *   node server/scripts/invoice-proposal-pdf-column.js --turso
 *   node server/scripts/invoice-proposal-pdf-column.js --turso --apply
 *
 * --turso opens TURSO_DATABASE_URL and TURSO_AUTH_TOKEN only. It does not
 * migrate, and it does not fall through to a local SQLite file.
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { SqliteAdapter } from '../src/sqliteAdapter.js';
import { openDatabase } from '../src/db.js';
import {
  inspectInvoiceProposalPdfColumn,
  repairInvoiceProposalPdfColumn
} from '../src/invoiceProposalPdfColumn.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply') || args.includes('--confirm');
const useTurso = args.includes('--turso');
const flag = args.indexOf('--sqlite');
const fileArg = flag === -1 ? null : args[flag + 1];
const hasSqlite = Boolean(fileArg && !fileArg.startsWith('--'));

function usage() {
  console.error('Usage: node server/scripts/invoice-proposal-pdf-column.js (--sqlite <file> | --turso) [--apply]');
  console.error('Read-only is the default. --apply copies bytes into invoice_proposal_files, then DROP COLUMN pdf_bytes.');
  console.error('--confirm is an alias of --apply. --turso reads TURSO_DATABASE_URL and TURSO_AUTH_TOKEN and does not open a local file.');
}

if (useTurso === hasSqlite) {
  usage();
  process.exit(2);
}

let db;
if (useTurso) {
  const tursoUrl = String(process.env.TURSO_DATABASE_URL || '').trim();
  const tursoAuthToken = String(process.env.TURSO_AUTH_TOKEN || '').trim();
  if (!tursoUrl || !tursoAuthToken) {
    console.error('Refusing --turso: set both TURSO_DATABASE_URL and TURSO_AUTH_TOKEN. No local SQLite file was opened.');
    process.exit(2);
  }
  db = await openDatabase({
    onVercel: false,
    useTurso: true,
    tursoUrl,
    tursoAuthToken,
    previewBlocked: null
  }, { migrate: false });
} else {
  const file = path.resolve(fileArg);
  if (!fs.existsSync(file)) {
    console.error(`SQLite file not found: ${file}`);
    process.exit(2);
  }
  const raw = new Database(file);
  raw.pragma('foreign_keys = ON');
  db = new SqliteAdapter(raw);
}

try {
  const report = apply
    ? await repairInvoiceProposalPdfColumn(db, { confirm: true })
    : await inspectInvoiceProposalPdfColumn(db);
  console.log(JSON.stringify(report, null, 2));
  if (!apply && report.needsRepair) {
    console.error('Dry-run only. Re-run with --apply to copy bytes and drop pdf_bytes.');
  }
} finally {
  db.close();
}
