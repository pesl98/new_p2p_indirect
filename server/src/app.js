import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import usersRouter from './routes/users.js';
import suppliersRouter from './routes/suppliers.js';
import catalogRouter from './routes/catalog.js';
import budgetsRouter from './routes/budgets.js';
import requisitionsRouter from './routes/requisitions.js';
import approvalsRouter from './routes/approvals.js';
import purchaseOrdersRouter from './routes/purchaseOrders.js';
import goodsReceiptsRouter from './routes/goodsReceipts.js';
import consignmentRouter from './routes/consignment.js';
import utilitiesRouter from './routes/utilities.js';
import bulkVesselsRouter from './routes/bulkVessels.js';
import serviceEntrySheetsRouter from './routes/serviceEntrySheets.js';
import invoicesRouter from './routes/invoices.js';
import invoiceProposalsRouter from './routes/invoiceProposals.js';
import invoiceExceptionsRouter from './routes/invoiceExceptions.js';
import invoiceDuplicatesRouter from './routes/invoiceDuplicates.js';
import apAgingRouter from './routes/apAging.js';
import paymentRunsRouter from './routes/paymentRuns.js';
import analyticsRouter from './routes/analytics.js';
import documentTrailRouter from './routes/documentTrail.js';
import departmentsRouter from './routes/departments.js';
import delegationsRouter from './routes/delegations.js';
import contractsRouter from './routes/contracts.js';
import authRouter from './routes/auth.js';
import complianceRouter from './routes/compliance.js';
import integrationsRouter from './routes/integrations.js';
import invoiceProposalPdfColumnRouter from './routes/invoiceProposalPdfColumn.js';
import sourcingRouter from './routes/sourcing.js';
import portalRouter from './routes/portal.js';
import { loadIntegrationConfig } from './integrationConfig.js';
import { getDb, peekCachedDb, TURSO_REQUIRED_MSG, TursoConfigError } from './db.js';
import { loadDbConfig } from './dbConfig.js';
import { mountConfigErrorApp, sendConfigError } from './configError.js';
import { loadCurrencyConfig } from './currencyConfig.js';
import { attachSession, loadAuthConfig, warnIfInsecureSessionSecret } from './auth.js';
import { requireApiSession } from './requestActor.js';
import tickRouter from './routes/tick.js';
import { corsOptions, loginAttemptKey, originCheck, rateLimit, securityHeaders } from './security.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORTAL_DOCUMENT_CSP = "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const PORTAL_BID_JSON_LIMIT = '1mb';

function trustProxyEnabled(env, onVercel) {
  if (onVercel) return true;
  const flag = String(env?.TRUST_PROXY || '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes';
}

function setPortalDocumentHeaders(res) {
  res.set('Content-Security-Policy', PORTAL_DOCUMENT_CSP);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Frame-Options', 'DENY');
  res.set('Cache-Control', 'no-store');
}

function resolveClientDist() {
  const candidates = [
    path.join(__dirname, '../../client/dist'),
    path.join(__dirname, '../../public'),
    path.join(process.cwd(), 'client/dist'),
    path.join(process.cwd(), 'public')
  ];
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) || null;
}

export function startupErrorApp(error) {
  const app = express();
  const message = error?.message || TURSO_REQUIRED_MSG;
  const status = error?.statusCode || 503;
  mountConfigErrorApp(app, message, status, {
    name: error?.name || 'TursoConfigError',
    code: error?.code
  });
  return app;
}

export function createApp(options = {}) {
  let currencyConfig;
  try {
    currencyConfig = options.currencyConfig || loadCurrencyConfig(options.env || process.env);
  } catch (error) {
    console.error(error.message);
    return startupErrorApp(error);
  }

  const config = options.config || loadDbConfig(options.env || process.env);
  if (config.previewBlocked) {
    return startupErrorApp(new TursoConfigError(config.previewBlocked.message, {
      code: config.previewBlocked.code
    }));
  }
  if (config.onVercel && !config.useTurso) {
    return startupErrorApp(new TursoConfigError(TURSO_REQUIRED_MSG));
  }

  const authConfig = options.authConfig || loadAuthConfig();
  const integrationConfig = options.integrationConfig || loadIntegrationConfig();
  const runtimeEnv = options.env || process.env;
  try {
    warnIfInsecureSessionSecret(authConfig, runtimeEnv);
  } catch (error) {
    console.error(error.message);
    return startupErrorApp(error);
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  if (trustProxyEnabled(runtimeEnv, config.onVercel)) app.set('trust proxy', 1);
  // Bid JSON can hold 50 lines with 2000-character comments. Only that route
  // gets the larger parser. Everything else stays on the 100 kB default.
  app.use('/api/portal/bids', express.json({ limit: PORTAL_BID_JSON_LIMIT }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: false, limit: '512kb' }));

  app.use(async (req, res, next) => {
    try {
      req.db = options.db || await getDb();
      req.authConfig = authConfig;
      req.integrationConfig = integrationConfig;
      req.currency = currencyConfig.currency;
      req.now = typeof options.now === 'function' ? options.now : () => new Date();
      // Tests inject a fake mail transport here; production reads MAIL_PROVIDER from the environment.
      req.mailOptions = options.mailOptions || {};
      next();
    } catch (error) {
      if (config.onVercel || error instanceof TursoConfigError) {
        return sendConfigError(req, res, error);
      }
      next(error);
    }
  });

  app.use(attachSession);
  // Portal is bearer-only and must not inherit credentialed CORS.
  app.use('/api/portal', options.portalRateLimit || rateLimit({ max: 300 }), portalRouter);
  app.use(cors(corsOptions(runtimeEnv)));
  app.use('/api', originCheck(runtimeEnv));
  app.use(requireApiSession);

  // Per account and address (10 tries), plus a generous cap per address. With TRUST_PROXY off
  // every visitor shares the proxy's address, so the address alone must not be the lock.
  const loginLimiters = options.loginRateLimit
    ? [options.loginRateLimit]
    : [rateLimit({ max: 300 }), rateLimit({ max: 10, key: loginAttemptKey })];
  for (const limiter of loginLimiters) {
    app.use('/api/auth/login', limiter);
    app.use('/api/auth/bootstrap', limiter);
  }
  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/departments', departmentsRouter);
  app.use('/api/approval-delegations', delegationsRouter);
  app.use('/api/suppliers', suppliersRouter);
  app.use('/api/catalog', catalogRouter);
  app.use('/api/budgets', budgetsRouter);
  app.use('/api/requisitions', requisitionsRouter);
  app.use('/api/approvals', approvalsRouter);
  app.use('/api/purchase-orders', purchaseOrdersRouter);
  app.use('/api/goods-receipts', goodsReceiptsRouter);
  app.use('/api/consignment', consignmentRouter);
  app.use('/api/utilities', utilitiesRouter);
  app.use('/api/bulk-vessels', bulkVesselsRouter);
  app.use('/api/service-entry-sheets', serviceEntrySheetsRouter);
  app.use('/api/invoices', invoicesRouter);
  app.use('/api/invoice-proposals', invoiceProposalsRouter);
  app.use('/api/invoice-exceptions', invoiceExceptionsRouter);
  app.use('/api/invoice-duplicates', invoiceDuplicatesRouter);
  app.use('/api/ap-aging', apAgingRouter);
  app.use('/api/payment-queue', apAgingRouter);
  app.use('/api/payment-runs', paymentRunsRouter);
  app.use('/api/analytics', analyticsRouter);
  app.use('/api/document-trail', documentTrailRouter);
  app.use('/api/contracts', contractsRouter);
  app.use('/api/compliance', complianceRouter);
  app.use('/api/integrations', integrationsRouter);
  app.use('/api/admin/invoice-proposal-pdf-column', invoiceProposalPdfColumnRouter);
  app.use('/api/sourcing/tick', tickRouter);
  app.use('/api/sourcing', sourcingRouter);

  app.get('/api/health', (req, res) => {
    const db = req.db || peekCachedDb();
    res.json({
      status: 'ok',
      system: 'ProcureFlow Non-Production Procurement Engine',
      version: '1.0.0',
      db: db?.useTurso ? 'turso-http' : 'sqlite',
      currency: req.currency,
      timestamp: new Date().toISOString()
    });
  });

  const clientDistPath = options.clientDist || (!process.env.VERCEL ? resolveClientDist() : null);
  if (clientDistPath) {
    // vercel.json sets these on the CDN. Express has to set them itself
    // when it serves the file outside Vercel.
    app.get('/portal.html', (req, res) => {
      setPortalDocumentHeaders(res);
      const file = path.join(clientDistPath, 'portal.html');
      if (!fs.existsSync(file)) return res.status(404).type('text/plain').send('Not found');
      return res.sendFile(file);
    });
    // express.static is ignored on Vercel — put the Vite build in /public instead.
    app.use(express.static(clientDistPath));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      if (req.path === '/portal.html') return next();
      res.sendFile(path.join(clientDistPath, 'index.html'));
    });
  }

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (config.onVercel || error instanceof TursoConfigError) {
      return sendConfigError(req, res, error, error.statusCode || 500);
    }
    const status = error.statusCode || error.status || 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ error: error.message });
  });

  return app;
}
