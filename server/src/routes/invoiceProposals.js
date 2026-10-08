import express from 'express';
import { AP_ROLES, requireRole, sessionActor } from '../requestActor.js';
import { contentDispositionInline, filenameFromRequest, pdfUploadMiddleware } from '../invoicePdf.js';
import { maxPdfBytes } from '../invoicePdf.js';
import { LOW_CONFIDENCE_THRESHOLD } from '../../../shared/invoiceConfidence.js';
import {
  InvoiceProposalError,
  approveInvoiceProposal,
  editAndPostInvoiceProposal,
  getInvoiceProposal,
  invoiceProposalConfig,
  listInvoiceProposals,
  listProposalOptions,
  parseWorkingCopy,
  previewProposal,
  readProposalPdf,
  rejectInvoiceProposal,
  sessionProposalActor,
  uploadInvoiceProposal
} from '../invoiceProposalsService.js';

const router = express.Router();

router.use(requireRole(...AP_ROLES));

function sendError(res, error) {
  const status = error.statusCode || 500;
  if (status >= 500 && !['ocr_failed', 'ocr_not_configured', 'ocr_provider_unavailable'].includes(error.code)) {
    console.error(error);
  }
  const body = { error: error.message || 'Invoice proposal request failed' };
  if (error.code) body.code = error.code;
  if (error.blockers) body.blockers = error.blockers;
  if (error instanceof InvoiceProposalError && error.code === 'file_too_large') {
    body.max_bytes = maxPdfBytes();
  }
  res.status(status).json(body);
}

function actor(req) {
  return sessionProposalActor(sessionActor(req));
}

router.get('/config', (req, res) => {
  res.json({
    ...invoiceProposalConfig(),
    max_bytes: maxPdfBytes(),
    low_confidence_below: LOW_CONFIDENCE_THRESHOLD
  });
});

router.get('/options', async (req, res) => {
  try {
    res.json(await listProposalOptions(req.db));
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/', async (req, res) => {
  try {
    res.json(await listInvoiceProposals(req.db, {
      status: req.query.status ? String(req.query.status) : 'proposed',
      limit: req.query.limit,
      offset: req.query.offset
    }));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/', pdfUploadMiddleware, async (req, res) => {
  try {
    const proposal = await uploadInvoiceProposal(req.db, {
      pdf: req.body,
      filename: filenameFromRequest(req.headers),
      actor: actor(req)
    });
    res.status(201).json({ proposal });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/:id/pdf', async (req, res) => {
  try {
    const file = await readProposalPdf(req.db, req.params.id);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', contentDispositionInline(file.filename));
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(file.bytes);
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/:id', async (req, res) => {
  try {
    res.json({ proposal: await getInvoiceProposal(req.db, req.params.id) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/:id/preview', async (req, res) => {
  try {
    const working = parseWorkingCopy(req.body || {});
    const proposal = await getInvoiceProposal(req.db, req.params.id);
    if (proposal.status !== 'proposed') {
      throw new InvoiceProposalError('This proposal is already closed', 409, 'proposal_not_open');
    }
    res.json({
      preview: await previewProposal(req.db, proposal.id, working, {
        overrideReason: req.body?.override_reason
      })
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/:id/approve', async (req, res) => {
  try {
    const result = await approveInvoiceProposal(
      req.db,
      req.params.id,
      actor(req),
      new Date(),
      req.body?.override_reason
    );
    res.status(201).json(result);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/:id/post', async (req, res) => {
  try {
    const result = await editAndPostInvoiceProposal(req.db, req.params.id, actor(req), req.body || {});
    res.status(201).json(result);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/:id/reject', async (req, res) => {
  try {
    const proposal = await rejectInvoiceProposal(
      req.db,
      req.params.id,
      actor(req),
      req.body?.reason
    );
    res.json({ proposal });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
