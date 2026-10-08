import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createApp } from './app.js';
import { createMemoryDatabase } from './db.js';
import { loadDbConfig } from './dbConfig.js';
import { SqliteAdapter } from './sqliteAdapter.js';
import { withCookie } from './testSession.js';
import {
  InvoiceProposalPdfColumnError,
  inspectInvoiceProposalPdfColumn,
  repairInvoiceProposalPdfColumn
} from './invoiceProposalPdfColumn.js';

const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../scripts/invoice-proposal-pdf-column.js'
);

const PDF_A = Buffer.from('%PDF-a');
const PDF_B = Buffer.from('%PDF-b');

function openThrowaway() {
  const file = path.join(os.tmpdir(), `pf-pdf-bytes-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  const raw = new Database(file);
  raw.exec(`
    CREATE TABLE invoice_proposals (
      id INTEGER PRIMARY KEY,
      pdf_filename TEXT NOT NULL,
      pdf_bytes BLOB NOT NULL
    );
    CREATE TABLE invoice_proposal_files (
      proposal_id INTEGER PRIMARY KEY,
      pdf_bytes BLOB NOT NULL
    );
  `);
  raw.prepare('INSERT INTO invoice_proposals (id, pdf_filename, pdf_bytes) VALUES (?, ?, ?)').run(7, 'a.pdf', PDF_A);
  raw.prepare('INSERT INTO invoice_proposals (id, pdf_filename, pdf_bytes) VALUES (?, ?, ?)').run(8, 'b.pdf', PDF_B);
  raw.prepare('INSERT INTO invoice_proposal_files (proposal_id, pdf_bytes) VALUES (?, ?)').run(7, PDF_A);
  return { file, db: new SqliteAdapter(raw) };
}

async function columnNames(db) {
  const rows = await db.prepare('PRAGMA table_info(invoice_proposals)').all();
  return rows.map((row) => row.name);
}

describe('leftover invoice_proposals.pdf_bytes', () => {
  test('diagnostic reports the NOT NULL column and dry-run writes nothing', async () => {
    const { file, db } = openThrowaway();
    try {
      const report = await inspectInvoiceProposalPdfColumn(db);
      assert.equal(report.columnPresent, true);
      assert.equal(report.notNull, true);
      assert.equal(report.proposalRows, 2);
      assert.equal(report.fileRows, 1);
      assert.equal(report.needsRepair, true);
      assert.equal(report.rowsAccounted, undefined);
      assert.equal(JSON.stringify(report).includes('%PDF'), false);
      const dry = await repairInvoiceProposalPdfColumn(db, { confirm: false });
      assert.equal(dry.dryRun, true);
      assert.equal(dry.action, 'would_repair');
      assert.equal(dry.dropped, false);
      assert.deepEqual(await columnNames(db), ['id', 'pdf_filename', 'pdf_bytes']);
      assert.equal(
        (await db.prepare('SELECT COUNT(*) AS n FROM invoice_proposal_files').get()).n,
        1
      );
    } finally {
      db.close();
      fs.unlinkSync(file);
    }
  });

  test('confirm copies every row and drops the column without rebuilding', async () => {
    const { file, db } = openThrowaway();
    try {
      const repaired = await repairInvoiceProposalPdfColumn(db, { confirm: true });
      assert.equal(repaired.action, 'repaired');
      assert.equal(repaired.copied, 1);
      assert.equal(repaired.dropped, true);
      assert.equal(repaired.diagnostic.columnPresent, false);
      const names = await columnNames(db);
      assert.deepEqual(names, ['id', 'pdf_filename']);
      const kept = await db.prepare('SELECT id, pdf_filename FROM invoice_proposals ORDER BY id').all();
      assert.deepEqual(kept, [
        { id: 7, pdf_filename: 'a.pdf' },
        { id: 8, pdf_filename: 'b.pdf' }
      ]);
      const files = await db.prepare(
        'SELECT proposal_id, pdf_bytes FROM invoice_proposal_files ORDER BY proposal_id'
      ).all();
      assert.equal(files.length, 2);
      assert.equal(Buffer.from(files[0].pdf_bytes).toString(), '%PDF-a');
      assert.equal(Buffer.from(files[1].pdf_bytes).toString(), '%PDF-b');
      const again = await repairInvoiceProposalPdfColumn(db, { confirm: true });
      assert.equal(again.action, 'noop');
      assert.equal(again.dropped, false);
    } finally {
      db.close();
      fs.unlinkSync(file);
    }
  });

  test('a byte mismatch aborts before any copy or drop', async () => {
    const { file, db } = openThrowaway();
    try {
      await db.prepare(
        'INSERT INTO invoice_proposal_files (proposal_id, pdf_bytes) VALUES (?, ?)'
      ).run(8, Buffer.from('%PDF-other'));
      await assert.rejects(
        () => repairInvoiceProposalPdfColumn(db, { confirm: true }),
        (error) => error instanceof InvoiceProposalPdfColumnError && error.code === 'pdf_bytes_mismatch'
      );
      assert.ok((await columnNames(db)).includes('pdf_bytes'));
      const files = await db.prepare('SELECT proposal_id FROM invoice_proposal_files ORDER BY proposal_id').all();
      assert.deepEqual(files, [{ proposal_id: 7 }, { proposal_id: 8 }]);
    } finally {
      db.close();
      fs.unlinkSync(file);
    }
  });

  test('a copy that does not account for every row does not drop the column', async () => {
    const { file, db } = openThrowaway();
    try {
      await db.exec(`
        CREATE TRIGGER wipe_copied_file AFTER INSERT ON invoice_proposal_files
        BEGIN
          DELETE FROM invoice_proposal_files WHERE proposal_id = NEW.proposal_id;
        END;
      `);
      await assert.rejects(
        () => repairInvoiceProposalPdfColumn(db, { confirm: true }),
        (error) => error instanceof InvoiceProposalPdfColumnError && error.code === 'pdf_bytes_unaccounted'
      );
      assert.ok((await columnNames(db)).includes('pdf_bytes'));
      const stored = await db.prepare('SELECT pdf_bytes FROM invoice_proposals WHERE id = 8').get();
      assert.equal(Buffer.from(stored.pdf_bytes).toString(), '%PDF-b');
      assert.equal(
        await db.prepare('SELECT proposal_id FROM invoice_proposal_files WHERE proposal_id = 8').get(),
        undefined
      );
    } finally {
      db.close();
      fs.unlinkSync(file);
    }
  });

  test('the script defaults to dry-run and never opens Turso from the environment', async () => {
    const { code } = await runNode(scriptPath, [], process.env);
    assert.equal(code, 2);

    const { file, db } = openThrowaway();
    db.close();
    const env = { ...process.env, TURSO_DATABASE_URL: 'libsql://should-not-open.turso.io', TURSO_AUTH_TOKEN: 'secret' };
    const dry = await runNode(scriptPath, ['--sqlite', file], env);
    assert.equal(dry.code, 0);
    assert.match(dry.stdout, /"columnPresent": true/);
    assert.match(dry.stderr, /Dry-run only/);
    const still = new Database(file);
    const names = still.prepare('PRAGMA table_info(invoice_proposals)').all().map((row) => row.name);
    assert.ok(names.includes('pdf_bytes'));
    still.close();

    const applied = await runNode(scriptPath, ['--sqlite', file, '--apply'], env);
    assert.equal(applied.code, 0);
    assert.match(applied.stdout, /"dropped": true/);
    const after = new Database(file);
    const afterNames = after.prepare('PRAGMA table_info(invoice_proposals)').all().map((row) => row.name);
    assert.equal(afterNames.includes('pdf_bytes'), false);
    assert.equal(after.prepare('SELECT COUNT(*) AS n FROM invoice_proposal_files').get().n, 2);
    after.close();
    fs.unlinkSync(file);

    const tursoEnv = { ...process.env };
    for (const key of ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'TURSO_PREVIEW_DATABASE_URL', 'TURSO_PREVIEW_AUTH_TOKEN']) {
      delete tursoEnv[key];
    }
    const refused = await runNode(scriptPath, ['--turso'], tursoEnv);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /TURSO_DATABASE_URL/);
    assert.match(refused.stderr, /No local SQLite file was opened/);
    const refusedApply = await runNode(scriptPath, ['--turso', '--apply'], tursoEnv);
    assert.equal(refusedApply.code, 2);
  });
});

describe('admin diagnostic endpoint', () => {
  test('admin can read the report and it does not change the table', async () => {
    const db = await createMemoryDatabase();
    await db.exec(`
      INSERT INTO users (id, name, email, role, status) VALUES
        (4, 'David Miller', 'david@example.com', 'finance', 'active'),
        (5, 'Elena Rostova', 'elena@example.com', 'admin', 'active');
      ALTER TABLE invoice_proposals ADD COLUMN pdf_bytes BLOB NOT NULL DEFAULT X'255044462d';
    `);
    const app = createApp({ db, config: loadDbConfig({}) });
    await withServer(app, async (base) => {
      const anon = await fetch(`${base}/api/admin/invoice-proposal-pdf-column`);
      assert.equal(anon.status, 401);
      const finance = await fetch(`${base}/api/admin/invoice-proposal-pdf-column`, withCookie(4));
      assert.equal(finance.status, 403);
      const admin = await fetch(`${base}/api/admin/invoice-proposal-pdf-column`, withCookie(5));
      const body = await admin.json();
      assert.equal(admin.status, 200);
      assert.equal(body.columnPresent, true);
      assert.equal(body.notNull, true);
      assert.equal(body.needsRepair, true);
    });
    const names = (await db.prepare('PRAGMA table_info(invoice_proposals)').all()).map((row) => row.name);
    assert.ok(names.includes('pdf_bytes'));
    db.close();
  });
});

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

function runNode(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}
