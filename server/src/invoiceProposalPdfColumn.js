/**
 * Read-only check and guarded repair for a leftover invoice_proposals.pdf_bytes
 * column from an early Sprint 7b preview. The repair copies bytes into
 * invoice_proposal_files and then ALTER TABLE … DROP COLUMN. It does not
 * rebuild the table.
 */

export class InvoiceProposalPdfColumnError extends Error {
  constructor(message, { code, diagnostic } = {}) {
    super(message);
    this.name = 'InvoiceProposalPdfColumnError';
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

const FILES_SQL = `
  CREATE TABLE IF NOT EXISTS invoice_proposal_files (
    proposal_id INTEGER PRIMARY KEY,
    pdf_bytes BLOB NOT NULL,
    FOREIGN KEY (proposal_id) REFERENCES invoice_proposals(id)
  )
`;

function emptyReport() {
  return {
    tablePresent: false,
    columnPresent: false,
    notNull: false,
    proposalRows: 0,
    rowsWithBytes: 0,
    fileRows: 0,
    rowsAccounted: 0,
    rowsMissingFile: 0,
    rowsByteMismatch: 0,
    needsRepair: false
  };
}

function asBuffer(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(value);
}

function sameBytes(left, right) {
  const a = asBuffer(left);
  const b = asBuffer(right);
  if (a == null || b == null) return a == null && b == null;
  return a.equals(b);
}

async function tableNames(db) {
  const rows = await db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table'
     AND name IN ('invoice_proposals', 'invoice_proposal_files')`
  ).all();
  return new Set((rows || []).map((row) => row.name));
}

export async function inspectInvoiceProposalPdfColumn(db) {
  const names = await tableNames(db);
  if (!names.has('invoice_proposals')) return emptyReport();

  const cols = await db.prepare('PRAGMA table_info(invoice_proposals)').all();
  const column = (cols || []).find((col) => col.name === 'pdf_bytes');
  const count = await db.prepare('SELECT COUNT(*) AS n FROM invoice_proposals').get();
  const proposalRows = Number(count?.n || 0);
  const fileCount = names.has('invoice_proposal_files')
    ? await db.prepare('SELECT COUNT(*) AS n FROM invoice_proposal_files').get()
    : { n: 0 };

  if (!column) {
    return {
      ...emptyReport(),
      tablePresent: true,
      proposalRows,
      fileRows: Number(fileCount?.n || 0)
    };
  }

  const proposals = await db.prepare('SELECT id, pdf_bytes FROM invoice_proposals').all();
  let rowsWithBytes = 0;
  let rowsAccounted = 0;
  let rowsMissingFile = 0;
  let rowsByteMismatch = 0;
  for (const row of proposals || []) {
    if (row.pdf_bytes != null) rowsWithBytes += 1;
    if (!names.has('invoice_proposal_files')) {
      rowsMissingFile += 1;
      continue;
    }
    const file = await db.prepare(
      'SELECT pdf_bytes FROM invoice_proposal_files WHERE proposal_id = ?'
    ).get(row.id);
    if (!file) {
      rowsMissingFile += 1;
    } else if (!sameBytes(file.pdf_bytes, row.pdf_bytes)) {
      rowsByteMismatch += 1;
    } else {
      rowsAccounted += 1;
    }
  }

  return {
    tablePresent: true,
    columnPresent: true,
    notNull: Number(column.notnull) === 1,
    proposalRows,
    rowsWithBytes,
    fileRows: Number(fileCount?.n || 0),
    rowsAccounted,
    rowsMissingFile,
    rowsByteMismatch,
    needsRepair: true
  };
}

async function accounted(db) {
  const proposals = await db.prepare('SELECT id, pdf_bytes FROM invoice_proposals').all();
  let rowsAccounted = 0;
  let rowsMissingFile = 0;
  let rowsByteMismatch = 0;
  for (const row of proposals || []) {
    const file = await db.prepare(
      'SELECT pdf_bytes FROM invoice_proposal_files WHERE proposal_id = ?'
    ).get(row.id);
    if (!file) rowsMissingFile += 1;
    else if (!sameBytes(file.pdf_bytes, row.pdf_bytes)) rowsByteMismatch += 1;
    else rowsAccounted += 1;
  }
  return {
    proposalRows: (proposals || []).length,
    rowsAccounted,
    rowsMissingFile,
    rowsByteMismatch
  };
}

export async function repairInvoiceProposalPdfColumn(db, { confirm = false } = {}) {
  const before = await inspectInvoiceProposalPdfColumn(db);
  if (!before.tablePresent || !before.columnPresent) {
    return { dryRun: !confirm, action: 'noop', copied: 0, dropped: false, diagnostic: before };
  }
  if (!confirm) {
    return { dryRun: true, action: 'would_repair', copied: 0, dropped: false, diagnostic: before };
  }
  if (before.rowsByteMismatch > 0) {
    throw new InvoiceProposalPdfColumnError(
      'Aborting: invoice_proposal_files already has different bytes for a proposal. Nothing was written and the column was not dropped.',
      { code: 'pdf_bytes_mismatch', diagnostic: before }
    );
  }

  await db.exec(FILES_SQL);
  let copied = 0;
  try {
    await db.transaction(async () => {
      const rows = await db.prepare('SELECT id, pdf_bytes FROM invoice_proposals').all();
      for (const row of rows || []) {
        const file = await db.prepare(
          'SELECT pdf_bytes FROM invoice_proposal_files WHERE proposal_id = ?'
        ).get(row.id);
        if (file) {
          if (!sameBytes(file.pdf_bytes, row.pdf_bytes)) {
            throw new InvoiceProposalPdfColumnError(
              'Aborting: a file row changed while copying. The column was not dropped.',
              { code: 'pdf_bytes_mismatch' }
            );
          }
          continue;
        }
        if (row.pdf_bytes == null) {
          throw new InvoiceProposalPdfColumnError(
            'Aborting: a proposal has no pdf_bytes and no file row. The column was not dropped.',
            { code: 'pdf_bytes_unaccounted' }
          );
        }
        await db.prepare(
          'INSERT INTO invoice_proposal_files (proposal_id, pdf_bytes) VALUES (?, ?)'
        ).run(row.id, row.pdf_bytes);
        copied += 1;
      }
      const check = await accounted(db);
      if (check.rowsMissingFile > 0 || check.rowsByteMismatch > 0 || check.rowsAccounted !== check.proposalRows) {
        throw new InvoiceProposalPdfColumnError(
          'Aborting: the copy did not account for every invoice_proposals row. The column was not dropped.',
          { code: 'pdf_bytes_unaccounted' }
        );
      }
    })();
  } catch (error) {
    if (error instanceof InvoiceProposalPdfColumnError && !error.diagnostic) {
      error.diagnostic = await inspectInvoiceProposalPdfColumn(db);
    }
    throw error;
  }

  const ready = await inspectInvoiceProposalPdfColumn(db);
  if (ready.rowsMissingFile > 0 || ready.rowsByteMismatch > 0 || ready.rowsAccounted !== ready.proposalRows) {
    throw new InvoiceProposalPdfColumnError(
      'Aborting: after the copy, not every proposal row has matching bytes. The column was not dropped.',
      { code: 'pdf_bytes_unaccounted', diagnostic: ready }
    );
  }

  await db.exec('ALTER TABLE invoice_proposals DROP COLUMN pdf_bytes');
  const after = await inspectInvoiceProposalPdfColumn(db);
  if (after.columnPresent) {
    throw new InvoiceProposalPdfColumnError(
      'DROP COLUMN pdf_bytes did not remove the column.',
      { code: 'pdf_bytes_drop_failed', diagnostic: after }
    );
  }
  return { dryRun: false, action: 'repaired', copied, dropped: true, diagnostic: after };
}
