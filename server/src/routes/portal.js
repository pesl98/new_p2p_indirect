/**
 * Unauthenticated supplier portal. Bearer token only. pf_session is ignored.
 * Mounted before the global CORS middleware so a foreign Origin gets no
 * Access-Control-Allow-Origin header.
 */

import express from 'express';
import { filenameFromRequest, sourcingPdfUpload } from '../sourcingConfig.js';
import { portalLanguage, portalMessage } from '../sourcingPortalMessages.js';
import {
  addPortalFile,
  askPortalQuestion,
  bearerToken,
  declinePortalInvitation,
  loadPortalView,
  readPortalFile,
  removePortalFile,
  resolvePortalToken,
  submitPortalBid,
  withdrawPortalBid
} from '../sourcingPortalService.js';

const router = express.Router();

function sendError(req, res, error) {
  const status = error.statusCode || error.status || 500;
  const code = error.type === 'entity.too.large' || status === 413
    ? 'payload_too_large'
    : (error.code || (status >= 500 ? 'portal_error' : undefined));
  const lang = portalLanguage(req);
  if (error.retryAfterSeconds) res.set('Retry-After', String(error.retryAfterSeconds));
  if (status >= 500 && status !== 503) {
    console.error(error);
    return res.status(status).json({
      error: 'Portal request failed',
      code: code || 'portal_error'
    });
  }
  const translate = lang === 'en' || code === 'busy' || code === 'payload_too_large';
  const message = translate
    ? portalMessage(lang, code, error.portalParams, error.message || 'Portal request failed')
    : (error.message || 'Portal request failed');
  const body = { error: message };
  if (code) body.code = code;
  res.status(status === 413 ? 413 : status).json(body);
}

const bidJson = express.json({ limit: '1mb' });

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('X-Robots-Tag', 'noindex');
  res.removeHeader('Access-Control-Allow-Origin');
  res.removeHeader('Access-Control-Allow-Credentials');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
});

router.use(async (req, res, next) => {
  try {
    const now = typeof req.now === 'function' ? req.now() : new Date();
    req.portal = await resolvePortalToken(req.db, bearerToken(req), req, now);
    req.portalNow = now;
    return next();
  } catch (error) {
    return sendError(req, res, error);
  }
});

router.get('/', async (req, res) => {
  try {
    res.json(await loadPortalView(req.db, req.portal, req.portalNow));
  } catch (error) {
    sendError(req, res, error);
  }
});

router.post('/bids', bidJson, async (req, res) => {
  try {
    const result = await submitPortalBid(req.db, req.portal, req.body || {}, req.portalNow);
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) {
    sendError(req, res, error);
  }
});

router.post('/bids/withdraw', async (req, res) => {
  try {
    res.json(await withdrawPortalBid(req.db, req.portal, req.portalNow));
  } catch (error) {
    sendError(req, res, error);
  }
});

router.post('/decline', async (req, res) => {
  try {
    res.json(await declinePortalInvitation(req.db, req.portal, req.body || {}, req.portalNow));
  } catch (error) {
    sendError(req, res, error);
  }
});

router.post('/questions', async (req, res) => {
  try {
    res.status(201).json(await askPortalQuestion(req.db, req.portal, req.body || {}, req.portalNow));
  } catch (error) {
    sendError(req, res, error);
  }
});

router.post('/files', sourcingPdfUpload, async (req, res) => {
  try {
    const file = await addPortalFile(req.db, req.portal, {
      buffer: req.body,
      filename: filenameFromRequest(req.headers)
    }, req.portalNow);
    res.status(201).json(file);
  } catch (error) {
    sendError(req, res, error);
  }
});

router.post('/files/:fileId/remove', async (req, res) => {
  try {
    res.json(await removePortalFile(req.db, req.portal, req.params.fileId, req.portalNow));
  } catch (error) {
    sendError(req, res, error);
  }
});

router.get('/files/:fileId', async (req, res) => {
  try {
    const file = await readPortalFile(req.db, req.portal, req.params.fileId);
    const bytes = Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(file.bytes);
    const filename = file.filename || 'attachment.pdf';
    const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '') || 'attachment.pdf';
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "frame-ancestors 'none'");
    res.set('Cache-Control', 'no-store');
    res.send(bytes);
  } catch (error) {
    sendError(req, res, error);
  }
});

router.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.statusCode || error.status;
  if (!status) {
    error.statusCode = 500;
    error.code = error.code || 'portal_error';
  }
  return sendError(req, res, error);
});

export default router;
