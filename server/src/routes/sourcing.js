import express from 'express';
import { sessionActor } from '../requestActor.js';
import { filenameFromRequest, requireSourcingEnabled, sourcingPdfUpload } from '../sourcingConfig.js';
import {
  SourcingError,
  addEventFile,
  answerQuestion,
  buyerBidFile,
  buyerComparison,
  cancelEvent,
  createEvent,
  createEventFromRequisition,
  extendDeadline,
  getEvent,
  listEvents,
  listQuestions,
  publishEvent,
  readEventFile,
  removeEventFile,
  revokeInvitationLink,
  rotateInvitationLink,
  sourcingAccess,
  updateEvent
} from '../sourcingService.js';
import { SourcingStatusError } from '../sourcingStatus.js';
import {
  clearCoi,
  createAwardPurchaseOrders,
  declareCoi,
  evaluateEvent,
  proposeAward,
  reassignOwner,
  recordScores
} from '../sourcingAwardService.js';

const router = express.Router();
const STAFF = new Set(['procurement', 'admin', 'finance']);

router.use(requireSourcingEnabled);
router.use(async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (STAFF.has(req.user.role)) return next();
    const evaluatorRoute = req.method === 'GET'
      || req.method === 'HEAD'
      || /\/coi$/.test(req.path)
      || /\/scores$/.test(req.path);
    if (!evaluatorRoute) {
      return res.status(403).json({ error: 'Insufficient role for this action' });
    }
    const named = await req.db.prepare(`
      SELECT 1 AS ok FROM sourcing_evaluators WHERE user_id = ? LIMIT 1
    `).get(req.user.id);
    if (!named) return res.status(403).json({ error: 'Insufficient role for this action' });
    return next();
  } catch (error) {
    return next(error);
  }
});

router.use((req, res, next) => {
  if (req.user?.role === 'finance' && req.method !== 'GET' && req.method !== 'HEAD') {
    if (!/\/(coi|scores)$/.test(req.path)) {
      return res.status(403).json({
        error: 'Insufficient role for this action',
        code: 'read_only'
      });
    }
  }
  return next();
});

function sendError(res, error) {
  const status = error.statusCode || 500;
  if (error.retryAfterSeconds) res.set('Retry-After', String(error.retryAfterSeconds));
  if (status >= 500) {
    console.error(error);
    return res.status(status).json({
      error: 'Sourcing request failed',
      code: error.code || 'sourcing_error'
    });
  }
  const body = { error: error.message || 'Sourcing request failed' };
  if (error.code) body.code = error.code;
  if (Array.isArray(error.blockers)) body.blockers = error.blockers;
  res.status(status).json(body);
}

function actor(req) {
  return sessionActor(req);
}

function now(req) {
  return typeof req.now === 'function' ? req.now() : new Date();
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
    res.json(await listEvents(req.db, req.query, now(req), actor(req)));
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
    res.json(await getEvent(req.db, req.params.id, now(req), actor(req)));
  } catch (error) {
    sendError(res, error);
  }
});

router.patch('/events/:id', async (req, res) => {
  try {
    res.json(await updateEvent(req.db, actor(req), req.params.id, req.body || {}, { now: now(req) }));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/events/:id/cancel', async (req, res) => {
  try {
    res.json(await cancelEvent(req.db, actor(req), req.params.id, req.body || {}, { now: now(req) }));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/events/:id/publish', async (req, res) => {
  try {
    res.json(await publishEvent(req.db, actor(req), req.params.id, req.body || {}, { now: now(req) }));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/events/:id/deadline', async (req, res) => {
  try {
    res.json(await extendDeadline(req.db, actor(req), req.params.id, req.body || {}, { now: now(req) }));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/events/:id/invitations/:invitationId/rotate', async (req, res) => {
  try {
    res.json(await rotateInvitationLink(req.db, actor(req), req.params.id, req.params.invitationId, { now: now(req) }));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/events/:id/invitations/:invitationId/revoke', async (req, res) => {
  try {
    res.json(await revokeInvitationLink(req.db, actor(req), req.params.id, req.params.invitationId, req.body || {}, { now: now(req) }));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/events/:id/coi', async (req, res) => {
  try {
    res.json(await declareCoi(req.db, actor(req), req.params.id, req.body || {}, { now: now(req) }));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/events/:id/coi/clear', async (req, res) => {
  try {
    res.json(await clearCoi(req.db, actor(req), req.params.id, req.body || {}, { now: now(req) }));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/events/:id/scores', async (req, res) => {
  try {
    res.json(await recordScores(req.db, actor(req), req.params.id, req.body || {}, { now: now(req) }));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/events/:id/evaluate', async (req, res) => {
  try {
    res.json(await evaluateEvent(req.db, actor(req), req.params.id, req.body || {}, { now: now(req) }));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/events/:id/awards', async (req, res) => {
  try {
    const result = await proposeAward(req.db, actor(req), req.params.id, req.body || {}, {
      now: now(req),
      idempotencyKey: req.get('Idempotency-Key')
    });
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/events/:id/purchase-orders', async (req, res) => {
  try {
    const result = await createAwardPurchaseOrders(req.db, actor(req), req.params.id, { now: now(req) });
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/events/:id/owner', async (req, res) => {
  try {
    res.json(await reassignOwner(req.db, actor(req), req.params.id, req.body || {}, { now: now(req) }));
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/events/:id/comparison', async (req, res) => {
  try {
    res.json(await buyerComparison(req.db, actor(req), req.params.id, now(req)));
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/events/:id/questions', async (req, res) => {
  try {
    res.json(await listQuestions(req.db, req.params.id, now(req), actor(req)));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/events/:id/questions/:questionId/answer', async (req, res) => {
  try {
    res.json(await answerQuestion(req.db, actor(req), req.params.id, req.params.questionId, req.body || {}, { now: now(req) }));
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/events/:id/bid-files/:fileId', async (req, res) => {
  try {
    const file = await buyerBidFile(req.db, actor(req), req.params.id, req.params.fileId, now(req));
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
    const file = await readEventFile(req.db, req.params.id, req.params.fileId, now(req), actor(req));
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
