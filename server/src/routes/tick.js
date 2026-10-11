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

const TICK_BUDGET_MS = 20_000;
const CLOSE_SHARE_MS = 8_000;
const CLOSE_BATCH = 20;
const SEND_TIMEOUT_MS = 5_000;

/**
 * Cron tick: close RFQs that are past their deadline and drain the webhook outbox.
 * Safe to run any number of times, also in parallel (the outbox claim is a lease).
 * Off unless CRON_SECRET is set; Vercel cron sends it as a bearer token.
 *
 * Bounded: at most 20 closes in about 8 seconds, then deliveries until a 20 second budget is
 * spent (each send times out inside what is left). One failing RFQ does not fail the others.
 * The closes do not start their own background send: the drain below is the only sender.
 */
async function tick(req, res) {
  if (!secretMatches(req.get('authorization'), process.env.CRON_SECRET)) {
    return res.status(401).json({ error: 'Authentication required', code: 'cron_secret_invalid' });
  }
  return requireSourcingEnabled(req, res, async () => {
    const startedAt = Date.now();
    const budgetMs = req.tickBudgetMs || TICK_BUDGET_MS;
    try {
      const now = req.now ? req.now() : new Date();
      const errors = [];
      const closed = await closeDueEvents(req.db, now, {
        limit: CLOSE_BATCH,
        kick: false,
        budgetMs: Math.min(CLOSE_SHARE_MS, budgetMs),
        errors
      });
      let delivery = null;
      if (req.integrationConfig?.ready) {
        delivery = await dispatchWebhookOutbox(req.db, {
          config: req.integrationConfig,
          now,
          timeoutMs: SEND_TIMEOUT_MS,
          budgetMs: Math.max(0, budgetMs - (Date.now() - startedAt)),
          ...(req.tickDispatchOptions || {})
        });
      }
      return res.json({
        closed: closed.length,
        close_errors: errors,
        webhooks_delivered: delivery ? delivery.delivered : null,
        webhooks_failed: delivery ? delivery.failed + delivery.dead : null,
        time_budget_hit: delivery?.skipped === 'time_budget'
      });
    } catch (error) {
      console.error('sourcing tick failed', error?.code || 'error');
      return res.status(500).json({ error: 'Tick failed' });
    }
  });
}

router.get('/', tick);
router.post('/', tick);

export default router;
