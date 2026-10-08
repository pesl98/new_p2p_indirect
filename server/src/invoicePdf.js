import { createHash } from 'node:crypto';
import express from 'express';

/** Raw PDF cap. Base64 in a Turso pipeline body stays near 5.4 MiB, under a typical serverless request. */
export const DEFAULT_MAX_PDF_BYTES = 4 * 1024 * 1024;
const PDF_MAGIC = Buffer.from('%PDF-');

export function maxPdfBytes(env = process.env) {
  const raw = env.INVOICE_PDF_MAX_BYTES;
  if (raw == null || String(raw).trim() === '') return DEFAULT_MAX_PDF_BYTES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < PDF_MAGIC.length || n > DEFAULT_MAX_PDF_BYTES) {
    return DEFAULT_MAX_PDF_BYTES;
  }
  return n;
}

export function isPdfBuffer(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= PDF_MAGIC.length
    && buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

export function sha256Pdf(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function safePdfFilename(name) {
  const base = String(name || 'invoice.pdf').split(/[/\\]/).pop() || 'invoice.pdf';
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/["\\]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 180);
  return cleaned || 'invoice.pdf';
}

/** RFC 5987 filename* plus an ASCII fallback for the download response. */
export function contentDispositionInline(filename) {
  const safe = safePdfFilename(filename);
  const ascii = safe.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '') || 'invoice.pdf';
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

function decodeStar(value) {
  const text = String(value || '').trim().replace(/^"(.*)"$/, '$1');
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Prefer RFC 5987 filename* so a non-ASCII PDF name survives the header. */
export function filenameFromRequest(headers = {}) {
  const disposition = String(headers['content-disposition'] || '');
  const star = /filename\*\s*=\s*(?:UTF-8''|utf-8'')?([^;]+)/i.exec(disposition);
  if (star) return safePdfFilename(decodeStar(star[1]));
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(disposition);
  if (plain) return safePdfFilename(plain[1] || plain[2]);
  return safePdfFilename(headers['x-filename']);
}

function tooLarge(res, limit) {
  return res.status(413).json({
    error: `PDF exceeds the ${limit} byte limit`,
    code: 'file_too_large',
    max_bytes: limit
  });
}

/**
 * Read one raw PDF. Content-Type must be application/pdf.
 * The extension is ignored; magic bytes are checked by the caller.
 */
export function pdfUploadMiddleware(req, res, next) {
  const limit = maxPdfBytes();
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/pdf') {
    return res.status(400).json({
      error: 'Content-Type must be application/pdf',
      code: 'not_a_pdf'
    });
  }
  return express.raw({ type: 'application/pdf', limit })(req, res, (err) => {
    if (err && (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413)) {
      return tooLarge(res, limit);
    }
    if (err) return next(err);
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({
        error: 'The request body is not a PDF',
        code: 'not_a_pdf'
      });
    }
    if (req.body.length > limit) return tooLarge(res, limit);
    return next();
  });
}
