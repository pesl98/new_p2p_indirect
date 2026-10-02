import express from 'express';
import { listApAging } from '../apAgingService.js';
import { AP_ROLES, requireRole } from '../requestActor.js';

const router = express.Router();
router.use(requireRole(...AP_ROLES));

function httpError(res, error) {
  const status = error.statusCode || 500;
  if (status >= 500) console.error(error);
  return res.status(status).json({ error: error.message });
}

// AP payment aging / payables queue. Finance or admin session.
router.get('/', async (req, res) => {
  try {
    const payload = await listApAging(req.db, {
      bucket: req.query.bucket,
      days: req.query.days,
      today: req.query.today
    });
    res.json(payload);
  } catch (error) {
    httpError(res, error);
  }
});

export default router;
