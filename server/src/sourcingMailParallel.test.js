import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from './db.js';
import { runMailAfterCommit, sendSourcingMails } from './sourcingMail.js';

const ENV = { MAIL_PROVIDER: 'smtp', MAIL_FROM: 'a@b.test', MAIL_SMTP_URL: 'smtp://relay.invalid:25' };

async function world() {
  const db = await createMemoryDatabase();
  await db.prepare(`INSERT INTO departments (id, code, name) VALUES (1, 'MKT', 'Marketing')`).run();
  await db.prepare(`INSERT INTO users (id, name, email, role, department_id, status) VALUES (3, 'C', 'c@x.test', 'procurement', 1, 'active')`).run();
  await db.prepare(`
    INSERT INTO sourcing_events (event_number, kind, title, department_id, owner_user_id, status, currency,
      deadline_at, weight_price, weight_lead_time, weight_quality, row_version, created_at, updated_at)
    VALUES ('RFQ-2026-001', 'rfq', 'T', 1, 3, 'published', 'EUR', '2999-01-01T00:00:00Z', 70, 15, 15, 0, '2026-01-01', '2026-01-01')
  `).run();
  return db;
}

describe('mail sending', () => {
  test('messages go out in parallel and each result is logged as it settles', async () => {
    const db = await world();
    const logged = [];
    const messages = [1, 2, 3, 4].map((n) => ({ kind: 'qa_answer', to: `s${n}@x.test`, subject: 's', text: 't' }));
    const started = Date.now();
    const results = await sendSourcingMails(db, 1, messages, {
      env: ENV,
      mailTransport: async (message) => {
        await new Promise((r) => setTimeout(r, 150));
        logged.push((await db.prepare(`SELECT COUNT(*) AS n FROM sourcing_mail_log`).get()).n);
        if (message.to === 's2@x.test') throw new Error('relay said no');
      }
    });
    assert.ok(Date.now() - started < 450, 'sent in parallel, not one after another');
    assert.deepEqual(results.map((r) => r.status).sort(), ['failed', 'sent', 'sent', 'sent']);
    const rows = await db.prepare(`SELECT status FROM sourcing_mail_log`).all();
    assert.equal(rows.length, 4);
    // Rows were written before the last transport call returned, not in one insert at the end.
    assert.ok(Math.max(...logged) >= 1);
  });

  test('a failure while preparing mail after the commit is not an error for the caller', async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      const awaited = await runMailAfterCommit(async () => { throw new Error('read failed'); }, { awaitMail: true });
      assert.equal(awaited, null);
      const background = await runMailAfterCommit(async () => { throw new Error('read failed'); }, { awaitMail: false });
      assert.equal(background, null);
    } finally {
      console.error = quiet;
    }
  });
});
