/**
 * Deployment flag for the RFQ module. Default off.
 * `1`, `true`, and `yes` turn it on. Unset, `0`, `false`, `no`, and
 * anything else stay off, so a typo does not open sourcing.
 */

import express from 'express';
import {
  DEFAULT_MAX_PDF_BYTES,
  filenameFromRequest,
  isPdfBuffer,
  safePdfFilename,
  sha256Pdf
} from './invoicePdf.js';

export const MAX_EVENT_LINES = 50;
export const MAX_INVITATIONS = 20;
export const MAX_EVENT_FILES = 10;
export const SPEC_LINE_DESCRIPTION = 'Totaalprijs volgens specificatie';

export const SOURCING_CATEGORIES = Object.freeze([
  'IT Hardware',
  'Software & Cloud',
  'Office Supplies',
  'Facilities & MRO',
  'Consulting & Professional Services',
  'Marketing & Events',
  'Travel & Subscriptions'
]);

const PDF_MAGIC_LENGTH = Buffer.from('%PDF-').length;

export function sourcingEnabled(env = process.env) {
  const flag = String(env.SOURCING_ENABLED ?? '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes';
}

/** Optional cap, never above the 7b 4 MiB ceiling. Invalid values use 4 MiB. */
export function sourcingPdfMaxBytes(env = process.env) {
  const raw = env.SOURCING_PDF_MAX_BYTES;
  if (raw == null || String(raw).trim() === '') return DEFAULT_MAX_PDF_BYTES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < PDF_MAGIC_LENGTH || n > DEFAULT_MAX_PDF_BYTES) {
    return DEFAULT_MAX_PDF_BYTES;
  }
  return n;
}

export function requireSourcingEnabled(req, res, next) {
  if (!sourcingEnabled()) {
    return res.status(503).json({
      error: 'Sourcing is not enabled for this deployment.',
      code: 'sourcing_disabled'
    });
  }
  return next();
}

function tooLarge(res, limit) {
  return res.status(413).json({
    error: `PDF exceeds the ${limit} byte limit`,
    code: 'file_too_large',
    max_bytes: limit
  });
}

/**
 * One raw PDF, same checks as invoice upload: application/pdf, size cap,
 * non-empty body. Magic bytes are checked by the route with isPdfBuffer.
 */
export function sourcingPdfUpload(req, res, next) {
  const limit = sourcingPdfMaxBytes();
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

export { filenameFromRequest, isPdfBuffer, safePdfFilename, sha256Pdf };

/** UTC ISO-8601 with milliseconds, so text comparison matches time order. */
export function utcIso(date = new Date()) {
  return date.toISOString();
}

function tzOffsetMs(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(date).map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - date.getTime();
}

/**
 * A value with Z or a numeric offset is already absolute.
 * A naive `YYYY-MM-DDTHH:mm` is Europe/Amsterdam wall time, which is what
 * the buyer screen collects.
 */
export function parseDeadline(value, timeZone = 'Europe/Amsterdam') {
  if (value == null || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (/[zZ]$/.test(text) || /[+-]\d{2}:\d{2}$/.test(text)) {
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) return undefined;
    return parsed.toISOString();
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] || 0);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return undefined;
  }
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = tzOffsetMs(new Date(utcGuess), timeZone);
  const corrected = new Date(utcGuess - offset);
  const offset2 = tzOffsetMs(corrected, timeZone);
  const finalDate = new Date(utcGuess - offset2);
  if (Number.isNaN(finalDate.getTime())) return undefined;
  return finalDate.toISOString();
}
