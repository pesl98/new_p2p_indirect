import express from 'express';
import { requireAdmin } from '../auth.js';
import { isIntegrationMachineRoute } from '../requestActor.js';
import {
  authenticateIntegrationKey,
  createApiKey,
  listApiKeys,
  revokeApiKey
} from '../apiKeys.js';
import { publicIntegrationConfig } from '../integrationConfig.js';
import { mailOverview } from '../sourcingMail.js';
import { requireSourcingEnabled } from '../sourcingConfig.js';
import {
  addSourcingInvitations,
  createSourcingDraft,
  listSourcingEvents,
  readSourcingAward,
  readSourcingEvent
} from '../sourcingIntegrations.js';
import {
  exportInvoices,
  exportPaymentRuns,
  replayIdempotentIfPresent,
  runIdempotent,
  postInboundInvoice,
  upsertCatalogItem,
  upsertVendor
} from '../integrationConnectors.js';
import { filenameFromRequest, pdfUploadMiddleware, sha256Pdf } from '../invoicePdf.js';
import {
  compileInvoiceProposal,
  integrationProposalActor,
  uploadInvoiceProposal
} from '../invoiceProposalsService.js';
import {
  dispatchWebhookOutbox,
  listWebhookOutbox,
  replayWebhook
} from '../webhookOutbox.js';

const router = express.Router();

function sendError(res, error) {
  const status = error.statusCode || 500;
  if (status >= 500) console.error(error);
  const body = { error: error.message || 'Integration request failed' };
  if (error.code) body.code = error.code;
  if (error.invoice_id != null) body.invoice_id = Number(error.invoice_id);
  if (error.invoice_status) body.status = error.invoice_status;
  if (error.retryAfterSeconds) {
    res.set('Retry-After', String(error.retryAfterSeconds));
    body.retry_after_seconds = error.retryAfterSeconds;
  }
  res.status(status).json(body);
}

function requireMachine(scope) {
  return async function requireMachineMiddleware(req, res, next) {
    try {
      req.integrationKey = await authenticateIntegrationKey(req, scope);
      return next();
    } catch (error) {
      return sendError(res, error);
    }
  };
}

router.use((req, res, next) => {
  if (isIntegrationMachineRoute(req)) return next();
  return requireAdmin(req, res, next);
});

router.get('/config', (req, res) => {
  res.json(publicIntegrationConfig(req.integrationConfig));
});

// Mail status for admins: provider, whether it is configured, delivery counts, recent failures.
// Addresses and message texts are not stored, so they cannot be shown.
router.get('/mail-status', async (req, res) => {
  try {
    res.json(await mailOverview(req.db));
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/keys', async (req, res) => {
  try {
    res.json(await listApiKeys(req.db));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/keys', async (req, res) => {
  try {
    const created = await createApiKey(req.db, req.user, req.body || {});
    res.status(201).json(created);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/keys/:id/revoke', async (req, res) => {
  try {
    const revoked = await revokeApiKey(req.db, req.user, req.params.id);
    res.json(revoked);
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/outbox', async (req, res) => {
  try {
    const events = await listWebhookOutbox(req.db, {
      status: req.query.status ? String(req.query.status) : 'all'
    });
    res.json({ events });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/outbox/dispatch', async (req, res) => {
  try {
    const delivery = await dispatchWebhookOutbox(req.db, { config: req.integrationConfig });
    res.json(delivery);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/outbox/:id/replay', async (req, res) => {
  try {
    const result = await replayWebhook(req.db, req.params.id, req.user, {
      config: req.integrationConfig
    });
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

async function sendIdempotent(req, res, work) {
  const result = await runIdempotent(
    req.db,
    req.integrationKey,
    req.headers['idempotency-key'],
    req.body,
    work
  );
  if (result.replay) res.set('Idempotent-Replayed', 'true');
  res.status(result.status).json(result.body);
}

router.post('/vendors', requireMachine('vendors:write'), async (req, res) => {
  try {
    await sendIdempotent(req, res, () => upsertVendor(req.db, req.body || {}, req.integrationKey));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/catalog', requireMachine('catalog:write'), async (req, res) => {
  try {
    await sendIdempotent(req, res, () => upsertCatalogItem(req.db, req.body || {}, req.integrationKey));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/invoices', requireMachine('invoices:write'), async (req, res) => {
  try {
    await sendIdempotent(req, res, () => postInboundInvoice(req.db, req.body || {}, req.integrationKey));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/invoice-proposals', requireMachine('invoices:write'), pdfUploadMiddleware, async (req, res) => {
  try {
    const filename = filenameFromRequest(req.headers);
    const fingerprint = {
      pdf_sha256: sha256Pdf(req.body),
      filename,
      byte_length: req.body.length
    };
    const existing = await replayIdempotentIfPresent(
      req.db,
      req.integrationKey,
      req.headers['idempotency-key'],
      fingerprint
    );
    if (existing) {
      if (existing.replay) res.set('Idempotent-Replayed', 'true');
      return res.status(existing.status).json(existing.body);
    }
    // Extract before the idempotent write so the model call does not hold
    // the database transaction. The insert stays inside runIdempotent.
    const draft = await compileInvoiceProposal(req.db, { pdf: req.body, filename });
    const result = await runIdempotent(
      req.db,
      req.integrationKey,
      req.headers['idempotency-key'],
      fingerprint,
      async () => {
        const proposal = await uploadInvoiceProposal(req.db, {
          pdf: req.body,
          filename,
          actor: integrationProposalActor(req.integrationKey),
          draft
        });
        return { status: 201, body: { proposal } };
      }
    );
    if (result.replay) res.set('Idempotent-Replayed', 'true');
    res.status(result.status).json(result.body);
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/exports/invoices', requireMachine('export:read'), async (req, res) => {
  try {
    const exported = await exportInvoices(req.db, req.integrationKey, req);
    if (exported.format === 'csv') {
      res.set('Content-Type', exported.contentType);
      res.set('Content-Disposition', `attachment; filename="${exported.filename}"`);
      return res.send(exported.body);
    }
    return res.json(exported.body);
  } catch (error) {
    return sendError(res, error);
  }
});

router.get('/exports/payment-runs', requireMachine('export:read'), async (req, res) => {
  try {
    const exported = await exportPaymentRuns(req.db, req.integrationKey, req);
    if (exported.format === 'csv') {
      res.set('Content-Type', exported.contentType);
      res.set('Content-Disposition', `attachment; filename="${exported.filename}"`);
      return res.send(exported.body);
    }
    return res.json(exported.body);
  } catch (error) {
    return sendError(res, error);
  }
});

const sourcingRead = [requireMachine('sourcing:read'), requireSourcingEnabled];
const sourcingWrite = [requireMachine('sourcing:write'), requireSourcingEnabled];

router.get('/sourcing/events', ...sourcingRead, async (req, res) => {
  try {
    res.json(await listSourcingEvents(req.db, req.query));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/sourcing/events', ...sourcingWrite, async (req, res) => {
  try {
    await sendIdempotent(req, res, () => createSourcingDraft(req.db, req.integrationKey, req.body, {
      currency: req.currency
    }));
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/sourcing/events/:number', ...sourcingRead, async (req, res) => {
  try {
    res.json(await readSourcingEvent(req.db, req.params.number));
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/sourcing/events/:number/award', ...sourcingRead, async (req, res) => {
  try {
    res.json(await readSourcingAward(req.db, req.params.number));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/sourcing/events/:number/invitations', ...sourcingWrite, async (req, res) => {
  try {
    await sendIdempotent(req, res, () => addSourcingInvitations(req.db, req.integrationKey, req.params.number, req.body));
  } catch (error) {
    sendError(res, error);
  }
});

function methodNotAllowed(req, res) {
  res.status(405).json({ error: 'Method not allowed', code: 'method_not_allowed' });
}

router.all('/vendors', requireMachine('vendors:write'), methodNotAllowed);
router.all('/catalog', requireMachine('catalog:write'), methodNotAllowed);
router.all('/invoices', requireMachine('invoices:write'), methodNotAllowed);
router.all('/invoice-proposals', requireMachine('invoices:write'), methodNotAllowed);
router.all('/exports/invoices', requireMachine('export:read'), methodNotAllowed);
router.all('/exports/payment-runs', requireMachine('export:read'), methodNotAllowed);

export default router;
