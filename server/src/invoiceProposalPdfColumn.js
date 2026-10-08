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
    fileRows: 0,
    needsRepair: false
  };
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

  return {
    tablePresent: true,
    columnPresent: true,
    notNull: Number(column.notnull) === 1,
    proposalRows,
    fileRows: Number(fileCount?.n || 0),
    needsRepair: true
  };
}

/** Counts only. Blob bytes stay in the database. */
async function accountPdfRows(db) {
  const names = await tableNames(db);
  const proposalRows = Number(
    (await db.prepare('SELECT COUNT(*) AS n FROM invoice_proposals').get())?.n || 0
  );
  if (!names.has('invoice_proposal_files')) {
    return { proposalRows, rowsAccounted: 0, rowsMissingFile: proposalRows, rowsByteMismatch: 0 };
  }
  const row = await db.prepare(`
    SELECT
      SUM(CASE WHEN f.proposal_id IS NULL THEN 1 ELSE 0 END) AS rowsMissingFile,
      SUM(CASE WHEN f.proposal_id IS NOT NULL AND f.pdf_bytes IS NOT p.pdf_bytes THEN 1 ELSE 0 END) AS rowsByteMismatch,
      SUM(CASE WHEN f.proposal_id IS NOT NULL AND f.pdf_bytes IS p.pdf_bytes THEN 1 ELSE 0 END) AS rowsAccounted
    FROM invoice_proposals p
    LEFT JOIN invoice_proposal_files f ON f.proposal_id = p.id
  `).get();
  return {
    proposalRows,
    rowsMissingFile: Number(row?.rowsMissingFile || 0),
    rowsByteMismatch: Number(row?.rowsByteMismatch || 0),
    rowsAccounted: Number(row?.rowsAccounted || 0)
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
  const prior = await accountPdfRows(db);
  if (prior.rowsByteMismatch > 0) {
    throw new InvoiceProposalPdfColumnError(
      'Aborting: invoice_proposal_files already has different bytes for a proposal. Nothing was written and the column was not dropped.',
      { code: 'pdf_bytes_mismatch', diagnostic: before }
    );
  }

  let copied = 0;
  try {
    await db.transaction(async () => {
      await db.exec(FILES_SQL);
      const rows = await db.prepare(`
        SELECT p.id, p.pdf_bytes
        FROM invoice_proposals p
        LEFT JOIN invoice_proposal_files f ON f.proposal_id = p.id
        WHERE f.proposal_id IS NULL
      `).all();
      for (const row of rows || []) {
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
      const check = await accountPdfRows(db);
      if (check.rowsMissingFile > 0 || check.rowsByteMismatch > 0 || check.rowsAccounted !== check.proposalRows) {
        throw new InvoiceProposalPdfColumnError(
          'Aborting: the copy did not account for every invoice_proposals row. The column was not dropped.',
          { code: 'pdf_bytes_unaccounted' }
        );
      }
      await db.exec('ALTER TABLE invoice_proposals DROP COLUMN pdf_bytes');
    })();
  } catch (error) {
    if (error instanceof InvoiceProposalPdfColumnError && !error.diagnostic) {
      error.diagnostic = await inspectInvoiceProposalPdfColumn(db);
    }
    throw error;
  }

  const after = await inspectInvoiceProposalPdfColumn(db);
  if (after.columnPresent) {
    throw new InvoiceProposalPdfColumnError(
      'DROP COLUMN pdf_bytes did not remove the column.',
      { code: 'pdf_bytes_drop_failed', diagnostic: after }
    );
  }
  return { dryRun: false, action: 'repaired', copied, dropped: true, diagnostic: after };
}
