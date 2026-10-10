import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { requireSourcingEnabled } from '../sourcingConfig.js';
import { closeDueEvents } from '../sourcingService.js';
import { dispatchWebhookOutbox } from '../webhookOutbox.js';

const router = express.Router();

function secretMatches(header, secret) {
  const match = /^Bearer (.+)$/.exec(String(header || ''));
  if (!match || !secret) return false;
  const a = Buffer.from(match[1]);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Cron tick: close RFQs that are past their deadline and drain the webhook outbox.
 * Safe to run any number of times. Off unless CRON_SECRET is set; Vercel cron sends it
 * as a bearer token.
 */
async function tick(req, res) {
  if (!secretMatches(req.get('authorization'), process.env.CRON_SECRET)) {
    return res.status(401).json({ error: 'Authentication required', code: 'cron_secret_invalid' });
  }
  return requireSourcingEnabled(req, res, async () => {
    try {
      const now = req.now ? req.now() : new Date();
      const closed = await closeDueEvents(req.db, now, { limit: 50 });
      let delivered = null;
      if (req.integrationConfig?.ready) {
        const delivery = await dispatchWebhookOutbox(req.db, { config: req.integrationConfig });
        delivered = delivery?.delivered ?? delivery?.sent ?? null;
      }
      return res.json({ closed: Array.isArray(closed) ? closed.length : 0, webhooks_delivered: delivered });
    } catch (error) {
      console.error('sourcing tick failed', error?.code || 'error');
      return res.status(500).json({ error: 'Tick failed' });
    }
  });
}

router.get('/', tick);
router.post('/', tick);

export default router;
