import express from 'express';
import cors from 'cors';
import usersRouter from './routes/users.js';
import suppliersRouter from './routes/suppliers.js';
import catalogRouter from './routes/catalog.js';
import budgetsRouter from './routes/budgets.js';
import requisitionsRouter from './routes/requisitions.js';
import approvalsRouter from './routes/approvals.js';
import purchaseOrdersRouter from './routes/purchaseOrders.js';
import goodsReceiptsRouter from './routes/goodsReceipts.js';
import invoicesRouter from './routes/invoices.js';
import analyticsRouter from './routes/analytics.js';
import './db.js'; // Ensure DB is initialized

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// API Routes
app.use('/api/users', usersRouter);
app.use('/api/suppliers', suppliersRouter);
app.use('/api/catalog', catalogRouter);
app.use('/api/budgets', budgetsRouter);
app.use('/api/requisitions', requisitionsRouter);
app.use('/api/approvals', approvalsRouter);
app.use('/api/purchase-orders', purchaseOrdersRouter);
app.use('/api/goods-receipts', goodsReceiptsRouter);
app.use('/api/invoices', invoicesRouter);
app.use('/api/analytics', analyticsRouter);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    system: 'ProcureFlow Non-Production Procurement Engine',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve frontend static build if present
const clientDistPath = path.join(__dirname, '../../client/dist');
if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`🚀 ProcureFlow running on http://localhost:${PORT}`);
});
