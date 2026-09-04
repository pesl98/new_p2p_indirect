/**
 * Sequential document numbers (PR-/PO-/GRN-/SES-YYYY-NNN).
 *
 * Uses MAX of the numeric suffix for the current year, not COUNT(*)+1.
 * COUNT(*)+1 collides after deletes or when numbers are not dense (seed gaps).
 * Call inside a write transaction so SQLite's single-writer lock serializes allocation.
 */

const DOC_KINDS = {
  pr: { table: 'purchase_requisitions', column: 'pr_number', prefix: 'PR' },
  po: { table: 'purchase_orders', column: 'po_number', prefix: 'PO' },
  grn: { table: 'goods_receipts', column: 'grn_number', prefix: 'GRN' },
  ses: { table: 'service_entry_sheets', column: 'ses_number', prefix: 'SES' }
};

export function nextDocumentNumber(db, kind, year = new Date().getFullYear()) {
  const spec = DOC_KINDS[kind];
  if (!spec) {
    throw new Error(`Unknown document kind: ${kind}`);
  }

  const yearPrefix = `${spec.prefix}-${year}-`;
  // column/table names come only from DOC_KINDS, never from request input.
  const row = db.prepare(
    `SELECT COALESCE(MAX(CAST(substr(${spec.column}, ?) AS INTEGER)), 0) AS max_n
     FROM ${spec.table}
     WHERE ${spec.column} LIKE ?`
  ).get(yearPrefix.length + 1, `${yearPrefix}%`);

  const next = Number(row?.max_n || 0) + 1;
  return `${yearPrefix}${String(next).padStart(3, '0')}`;
}
