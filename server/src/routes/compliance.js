import express from 'express';
import { requireRole } from '../requestActor.js';
import { recordComplianceExport } from '../complianceAudit.js';
import {
  APPROVAL_COMPLIANCE_COLUMNS,
  AUDIT_TRAIL_COLUMNS,
  PAYMENT_SUPPORT_COLUMNS,
  VERIFICATION_COLUMNS,
  parseAuditFilters,
  queryApprovalCompliance,
  queryAuditTrail,
  queryPaymentSupport,
  queryVerification,
  toCsv
} from '../complianceReports.js';

const router = express.Router();

router.use(requireRole('admin', 'finance'));

const REPORTS = {
  'audit-trail': {
    load: (db, filters) => queryAuditTrail(db, filters),
    columns: AUDIT_TRAIL_COLUMNS,
    rows: (report) => report.rows
  },
  'approval-policy': {
    load: (db) => queryApprovalCompliance(db),
    columns: APPROVAL_COMPLIANCE_COLUMNS,
    rows: (report) => report.findings
  },
  'payment-support': {
    load: (db) => queryPaymentSupport(db),
    columns: PAYMENT_SUPPORT_COLUMNS,
    rows: (report) => report.findings
  },
  verification: {
    load: (db) => queryVerification(db),
    columns: VERIFICATION_COLUMNS,
    rows: (report) => report.findings
  }
};

function sendError(res, error) {
  const status = error.statusCode || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: error.message });
}

router.get('/:report', async (req, res) => {
  try {
    const spec = REPORTS[req.params.report];
    if (!spec) {
      return res.status(404).json({ error: 'Unknown compliance report' });
    }
    const filters = req.params.report === 'audit-trail' ? parseAuditFilters(req.query) : null;
    const report = await spec.load(req.db, filters);
    const csv = req.query.format === 'csv';
    if (csv) {
      await recordComplianceExport(req.db, req.user, {
        report: req.params.report,
        filters: filters || undefined
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${req.params.report}.csv"`);
      return res.send(toCsv(spec.columns, spec.rows(report)));
    }
    return res.json(report);
  } catch (error) {
    return sendError(res, error);
  }
});

export default router;
