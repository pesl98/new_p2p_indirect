import express from 'express';
import { requireAdmin } from '../auth.js';
import { inspectInvoiceProposalPdfColumn } from '../invoiceProposalPdfColumn.js';

const router = express.Router();

router.get('/', requireAdmin, async (req, res, next) => {
  try {
    const report = await inspectInvoiceProposalPdfColumn(req.db);
    res.json(report);
  } catch (error) {
    next(error);
  }
});

export default router;
