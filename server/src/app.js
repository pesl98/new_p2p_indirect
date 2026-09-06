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
import serviceEntrySheetsRouter from './routes/serviceEntrySheets.js';
import invoicesRouter from './routes/invoices.js';
import analyticsRouter from './routes/analytics.js';
import documentTrailRouter from './routes/documentTrail.js';
import { getDb, peekCachedDb, TURSO_REQUIRED_MSG, TursoConfigError } from './db.js';
import { loadDbConfig } from './dbConfig.js';
import { mountConfigErrorApp, sendConfigError } from './configError.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  mountConfigErrorApp(app, message, status);
  return app;
}

export function createApp(options = {}) {
  const config = options.config || loadDbConfig();
  if (config.onVercel && !config.useTurso) {
    return startupErrorApp(new TursoConfigError(TURSO_REQUIRED_MSG));
  }

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.use(async (req, res, next) => {
    try {
      req.db = options.db || await getDb();
      next();
    } catch (error) {
      if (config.onVercel || error instanceof TursoConfigError) {
        return sendConfigError(req, res, error);
      }
      next(error);
    }
  });

  app.use('/api/users', usersRouter);
  app.use('/api/suppliers', suppliersRouter);
  app.use('/api/catalog', catalogRouter);
  app.use('/api/budgets', budgetsRouter);
  app.use('/api/requisitions', requisitionsRouter);
  app.use('/api/approvals', approvalsRouter);
  app.use('/api/purchase-orders', purchaseOrdersRouter);
  app.use('/api/goods-receipts', goodsReceiptsRouter);
  app.use('/api/service-entry-sheets', serviceEntrySheetsRouter);
  app.use('/api/invoices', invoicesRouter);
  app.use('/api/analytics', analyticsRouter);
  app.use('/api/document-trail', documentTrailRouter);

  app.get('/api/health', (req, res) => {
    const db = req.db || peekCachedDb();
    res.json({
      status: 'ok',
      system: 'ProcureFlow Non-Production Procurement Engine',
      version: '1.0.0',
      db: db?.useTurso ? 'turso-http' : 'sqlite',
      timestamp: new Date().toISOString()
    });
  });

  const clientDistPath = resolveClientDist();
  if (clientDistPath && !process.env.VERCEL) {
    // express.static is ignored on Vercel — put the Vite build in /public instead.
    app.use(express.static(clientDistPath));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(path.join(clientDistPath, 'index.html'));
    });
  }

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (config.onVercel || error instanceof TursoConfigError) {
      return sendConfigError(req, res, error, error.statusCode || 500);
    }
    const status = error.statusCode || 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ error: error.message });
  });

  return app;
}
