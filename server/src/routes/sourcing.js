import express from 'express';
import { requireRole, sessionActor } from '../requestActor.js';
import { filenameFromRequest, requireSourcingEnabled, sourcingPdfUpload } from '../sourcingConfig.js';
import {
  SourcingError,
  addEventFile,
  cancelEvent,
  createEvent,
  createEventFromRequisition,
  getEvent,
  listEvents,
  readEventFile,
  removeEventFile,
  sourcingAccess,
  updateEvent
} from '../sourcingService.js';
import { SourcingStatusError } from '../sourcingStatus.js';

const router = express.Router();

router.use(requireSourcingEnabled);
router.use(requireRole('procurement', 'admin', 'finance'));

router.use((req, res, next) => {
  if (req.user?.role === 'finance' && req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(403).json({
      error: 'Insufficient role for this action',
      code: 'read_only'
    });
  }
  return next();
});

function sendError(res, error) {
  const status = error.statusCode || 500;
  if (status >= 500) {
    console.error(error);
    return res.status(status).json({
      error: 'Sourcing request failed',
      code: error.code || 'sourcing_error'
    });
  }
  const body = { error: error.message || 'Sourcing request failed' };
  if (error.code) body.code = error.code;
  res.status(status).json(body);
}

function actor(req) {
  return sessionActor(req);
}

router.get('/me', async (req, res) => {
  try {
    res.json(await sourcingAccess(req.db, actor(req)));
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/events', async (req, res) => {
  try {
    res.json(await listEvents(req.db, req.query));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/events/from-requisition', async (req, res) => {
  try {
    const created = await createEventFromRequisition(
      req.db,
      actor(req),
      req.body?.requisition_id,
      req.body || {},
      { currency: req.currency }
    );
    res.status(201).json(created);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/events', async (req, res) => {
  try {
    const created = await createEvent(req.db, actor(req), req.body || {}, { currency: req.currency });
    res.status(201).json(created);
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/events/:id', async (req, res) => {
  try {
    res.json(await getEvent(req.db, req.params.id));
  } catch (error) {
    sendError(res, error);
  }
});

router.patch('/events/:id', async (req, res) => {
  try {
    res.json(await updateEvent(req.db, actor(req), req.params.id, req.body || {}));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/events/:id/cancel', async (req, res) => {
  try {
    res.json(await cancelEvent(req.db, actor(req), req.params.id, req.body || {}));
  } catch (error) {
    sendError(res, error);
  }
});

router.delete('/events/:id', (_req, res) => {
  res.status(405).json({
    error: 'Hard delete is not allowed. Cancel the RFQ instead.',
    code: 'method_not_allowed'
  });
});

router.post('/events/:id/files', sourcingPdfUpload, async (req, res) => {
  try {
    const file = await addEventFile(req.db, actor(req), req.params.id, {
      buffer: req.body,
      filename: filenameFromRequest(req.headers)
    });
    res.status(201).json(file);
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/events/:id/files/:fileId', async (req, res) => {
  try {
    const file = await readEventFile(req.db, req.params.id, req.params.fileId);
    const bytes = Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(file.bytes);
    const filename = file.filename || 'attachment.pdf';
    const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '') || 'attachment.pdf';
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "frame-ancestors 'none'");
    res.set('Cache-Control', 'private, no-store');
    res.send(bytes);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/events/:id/files/:fileId/remove', async (req, res) => {
  try {
    res.json(await removeEventFile(req.db, actor(req), req.params.id, req.params.fileId));
  } catch (error) {
    sendError(res, error);
  }
});

router.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof SourcingError || error instanceof SourcingStatusError || error.statusCode) {
    return sendError(res, error);
  }
  return next(error);
});

export default router;
