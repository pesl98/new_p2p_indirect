/**
 * RFQ attachment (PDF) upload, read and removal. Split from sourcingService.js.
 * Draft RFQs only; every write is audited. Re-exported from sourcingService.js.
 */

import {
  MAX_EVENT_FILES,
  MAX_EVENT_FILE_BYTES,
  isPdfBuffer,
  safePdfFilename,
  sha256Pdf,
  utcIso
} from './sourcingConfig.js';
import { BUYER_UPLOADS_PER_MINUTE, consumeRateWindow } from './sourcingRates.js';
import {
  assertDraft,
  assertOwner,
  closeDueEvents,
  fail,
  loadEventRow,
  writeAudit,
  writeCompliance
} from './sourcingService.js';

export async function addEventFile(db, actor, id, { buffer, filename } = {}) {
  const existing = await loadEventRow(db, id);
  if (!existing) fail('RFQ was not found.', 404, 'event_not_found');
  assertOwner(actor, existing);
  assertDraft(existing);
  if (!isPdfBuffer(buffer)) fail('The file is not a PDF.', 400, 'not_a_pdf');
  const safeName = safePdfFilename(filename);
  const now = utcIso();
  const active = await db.prepare(`
    SELECT COUNT(*) AS n FROM sourcing_files
    WHERE event_id = ? AND owner_kind = 'event' AND removed_at IS NULL
  `).get(existing.id);
  if (Number(active?.n || 0) >= MAX_EVENT_FILES) {
    fail(`An RFQ can have at most ${MAX_EVENT_FILES} files.`, 400, 'too_many_files');
  }
  const usedBytes = await db.prepare(`
    SELECT COALESCE(SUM(size_bytes), 0) AS n FROM sourcing_files
    WHERE event_id = ? AND owner_kind = 'event' AND removed_at IS NULL
  `).get(existing.id);
  if (Number(usedBytes?.n || 0) + buffer.length > MAX_EVENT_FILE_BYTES) {
    fail('The RFQ attachments exceed 40 MB.', 400, 'event_files_too_large');
  }
  const uploadRate = await consumeRateWindow(db, `buyer:${actor.id}:upload`, BUYER_UPLOADS_PER_MINUTE, new Date(now));
  if (uploadRate.limited) {
    fail('Too many uploads. Try again in a minute.', 429, 'rate_limited', { retryAfterSeconds: uploadRate.retryAfterSeconds });
  }
  const digest = sha256Pdf(buffer);
  const fileId = await db.immediateTransaction(async () => {
    const count = await db.prepare(`
      SELECT COUNT(*) AS n FROM sourcing_files
      WHERE event_id = ? AND owner_kind = 'event' AND removed_at IS NULL
    `).get(existing.id);
    if (Number(count?.n || 0) >= MAX_EVENT_FILES) {
      fail(`An RFQ can have at most ${MAX_EVENT_FILES} files.`, 400, 'too_many_files');
    }
    const used = await db.prepare(`
      SELECT COALESCE(SUM(size_bytes), 0) AS n FROM sourcing_files
      WHERE event_id = ? AND owner_kind = 'event' AND removed_at IS NULL
    `).get(existing.id);
    if (Number(used?.n || 0) + buffer.length > MAX_EVENT_FILE_BYTES) {
      fail('The RFQ attachments exceed 40 MB.', 400, 'event_files_too_large');
    }
    const result = await db.prepare(`
      INSERT INTO sourcing_files (
        event_id, owner_kind, filename, content_type, size_bytes, sha256, uploaded_by_user_id, created_at
      ) VALUES (?, 'event', ?, 'application/pdf', ?, ?, ?, ?)
    `).run(existing.id, safeName, buffer.length, digest, actor.id, now);
    let createdId = Number(result.lastInsertRowid);
    if (!createdId) {
      const created = await db.prepare(`
        SELECT id FROM sourcing_files WHERE event_id = ? AND sha256 = ? ORDER BY id DESC LIMIT 1
      `).get(existing.id, digest);
      createdId = Number(created?.id || 0);
    }
    if (!createdId) fail('Failed to store the PDF.', 500, 'sourcing_error');
    await db.prepare(`INSERT INTO sourcing_file_blobs (file_id, bytes) VALUES (?, ?)`).run(createdId, buffer);
    await writeAudit(
      db,
      'sourcing_event',
      existing.id,
      'FILE_UPLOADED',
      actor.name,
      `PDF ${safeName} uploaded (${buffer.length} bytes)`
    );
    await writeCompliance(db, actor, 'SOURCING_FILE_UPLOADED', 'sourcing_event', existing.id, {
      file_id: createdId,
      sha256: digest
    });
    return createdId;
  })();
  const file = await db.prepare(`
    SELECT id, event_id, filename, content_type, size_bytes, sha256, uploaded_by_user_id, removed_at, created_at
    FROM sourcing_files WHERE id = ?
  `).get(fileId);
  return file;
}

export async function readEventFile(db, eventId, fileId, now = new Date()) {
  await closeDueEvents(db, now, { eventId });
  const meta = await db.prepare(`
    SELECT id, event_id, filename, content_type, size_bytes, removed_at
    FROM sourcing_files
    WHERE id = ? AND event_id = ? AND owner_kind = 'event'
  `).get(fileId, eventId);
  if (!meta || meta.removed_at) fail('File was not found.', 404, 'file_not_found');
  const blob = await db.prepare(`SELECT bytes FROM sourcing_file_blobs WHERE file_id = ?`).get(meta.id);
  if (!blob?.bytes) fail('File was not found.', 404, 'file_not_found');
  return { ...meta, bytes: blob.bytes };
}

export async function removeEventFile(db, actor, eventId, fileId) {
  const existing = await loadEventRow(db, eventId);
  if (!existing) fail('RFQ was not found.', 404, 'event_not_found');
  assertOwner(actor, existing);
  assertDraft(existing);
  const now = utcIso();
  const changed = await db.immediateTransaction(async () => {
    const result = await db.prepare(`
      UPDATE sourcing_files
      SET removed_at = ?
      WHERE id = ? AND event_id = ? AND owner_kind = 'event' AND removed_at IS NULL
        AND EXISTS (
          SELECT 1 FROM sourcing_events e
          WHERE e.id = sourcing_files.event_id AND e.status = 'draft'
        )
    `).run(now, fileId, existing.id);
    if (!result.changes) {
      const current = await db.prepare(`SELECT status FROM sourcing_events WHERE id = ?`).get(existing.id);
      if (!current || current.status !== 'draft') {
        fail('The RFQ is no longer a draft.', 409, 'event_state_changed');
      }
      return 0;
    }
    // Draft only. bytes is NOT NULL and the blob trigger rejects UPDATE, so the
    // row is deleted. Metadata and the audit line stay. The status check is
    // repeated on the DELETE so a publish that won the write lock keeps the blob.
    const removed = await db.prepare(`
      DELETE FROM sourcing_file_blobs
      WHERE file_id = ?
        AND EXISTS (
          SELECT 1 FROM sourcing_events e
          JOIN sourcing_files f ON f.event_id = e.id
          WHERE f.id = ? AND e.status = 'draft'
        )
    `).run(fileId, fileId);
    if (!removed.changes) {
      const current = await db.prepare(`SELECT status FROM sourcing_events WHERE id = ?`).get(existing.id);
      if (!current || current.status !== 'draft') {
        fail('The RFQ is no longer a draft.', 409, 'event_state_changed');
      }
    }
    await writeAudit(db, 'sourcing_event', existing.id, 'FILE_REMOVED', actor.name, `PDF file ${fileId} removed from the draft`);
    await writeCompliance(db, actor, 'SOURCING_FILE_REMOVED', 'sourcing_event', existing.id, {
      file_id: Number(fileId)
    });
    return result.changes;
  })();
  if (!changed) fail('File was not found.', 404, 'file_not_found');
  return { id: Number(fileId), removed_at: now };
}
