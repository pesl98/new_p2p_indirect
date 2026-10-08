/**
 * PDF upload entry. vercel.json sends application/pdf posts here so
 * maxDuration: 60 applies only to OCR uploads, not the rest of /api.
 * The Express app is the same one; the rewrite keeps the original URL.
 */
export { default } from './index.js';
