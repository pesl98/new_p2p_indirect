import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { createApp } from './app.js';
import { createMemoryDatabase } from './db.js';
import { loadDbConfig } from './dbConfig.js';
import { loadMailConfig, mailIsConfigured } from './mail/index.js';
import { mailOverview, shouldAwaitMail } from './sourcingMail.js';
import { withCookie } from './testSession.js';

const SECRET = '0123456789abcdef0123456789abcdef';

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', async () => {
      try {
        await fn(`http://127.0.0.1:${server.address().port}`);
        server.close(() => resolve());
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

async function json(response) {
  const text = await response.text();
  let body = null;
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }
  return { status: response.status, body };
}

const buyer = (extra = {}) => withCookie(3, { headers: extra }).headers;
const bearer = (token, extra = {}) => ({ Authorization: `Bearer ${token}`, ...extra });
const tokenOf = (url) => new URLSearchParams(String(url || '').split('#')[1] || '').get('t');

async function seedWorld(db) {
  await db.prepare(`INSERT INTO departments (id, code, name) VALUES (1, 'MKT', 'Marketing')`).run();
  await db.prepare(`
    INSERT INTO users (id, name, email, role, department_id, title, status) VALUES
      (3, 'Carol Zhang', 'carol@example.com', 'procurement', 1, 'Buyer', 'active')
  `).run();
  await db.prepare(`
    INSERT INTO suppliers (id, name, code, contact_person, email, status) VALUES
      (2, 'Active Supply', 'ACT', 'Ann', 'ann@active.test', 'active'),
      (4, 'Other Supply', 'OTH', 'Otto', 'otto@other.test', 'active')
  `).run();
}

async function withEnv(vars, fn) {
  const keys = ['SOURCING_ENABLED', 'PORTAL_TOKEN_SECRET', 'APP_BASE_URL', 'MAIL_PROVIDER', 'MAIL_FROM', 'MAIL_SMTP_URL'];
  const prev = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.SOURCING_ENABLED = '1';
  process.env.PORTAL_TOKEN_SECRET = SECRET;
  process.env.APP_BASE_URL = 'https://procure.example';
  for (const key of ['MAIL_PROVIDER', 'MAIL_FROM', 'MAIL_SMTP_URL']) delete process.env[key];
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const key of keys) { if (prev[key] == null) delete process.env[key]; else process.env[key] = prev[key]; }
  }
}

const SMTP = { MAIL_PROVIDER: 'smtp', MAIL_FROM: 'inkoop@procure.example', MAIL_SMTP_URL: 'smtp://relay.invalid:25' };

/** Create and publish one RFQ with two invitees; returns tokens and ids. */
async function publishTwo(base, extraHeaders = {}) {
  const created = await json(await fetch(`${base}/api/sourcing/events`, {
    method: 'POST',
    headers: { ...buyer(extraHeaders), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Stoelen',
      deadline_at: '2026-10-08T14:00:00.000Z',
      qa_enabled: true,
      lines: [{ description: 'Stoel', category: 'Office Supplies', quantity: 1 }],
      invitations: [
        { supplier_id: 2, contact_email: 'ann@active.test' },
        { supplier_id: 4, contact_email: 'otto@other.test' }
      ]
    })
  }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const published = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}/publish`, {
    method: 'POST',
    headers: { ...buyer(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ row_version: created.body.row_version })
  }));
  assert.equal(published.status, 200, JSON.stringify(published.body));
  return {
    eventId: created.body.id,
    published: published.body,
    tokens: published.body.invitations.map((row) => ({ id: row.id, token: tokenOf(row.portal_url), url: row.portal_url }))
  };
}

async function everyRowText(db) {
  const tables = (await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()).map((row) => row.name);
  const parts = [];
  for (const table of tables) {
    const rows = await db.prepare(`SELECT * FROM ${table}`).all();
    parts.push(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? String(v) : (Buffer.isBuffer(v) ? v.toString('latin1') : v))));
  }
  return parts.join('\n');
}

describe('mail provider selection', () => {
  test('none is the default; smtp needs a sender and a URL; anything else is invalid and skipped', () => {
    assert.equal(loadMailConfig({}).provider, 'none');
    assert.equal(mailIsConfigured(loadMailConfig({})), false);
    assert.equal(mailIsConfigured(loadMailConfig({ MAIL_PROVIDER: 'smtp' })), false, 'no sender or URL');
    assert.equal(mailIsConfigured(loadMailConfig(SMTP)), true);
    const odd = loadMailConfig({ MAIL_PROVIDER: 'sendgrid' });
    assert.equal(odd.provider, 'none');
    assert.equal(odd.invalid, true);
    // Nothing leaves the process with none, so the work is awaited; with smtp it runs in the background.
    assert.equal(shouldAwaitMail({ env: {} }), true);
    assert.equal(shouldAwaitMail({ env: SMTP }), false);
    assert.equal(shouldAwaitMail({ env: SMTP, awaitMail: true }), true);
  });
});

describe('sourcing mail', () => {
  test('with MAIL_PROVIDER unset every flow works through copy link, and the log says skipped', async () => {
    const db = await createMemoryDatabase();
    await seedWorld(db);
    const clock = { ms: Date.parse('2026-10-08T12:00:00.000Z') };
    const app = createApp({ db, config: loadDbConfig({}), now: () => new Date(clock.ms) });
    await withEnv({}, () => withServer(app, async (base) => {
      const { published, eventId, tokens } = await publishTwo(base);
      assert.ok(tokens.every((row) => row.url.startsWith('https://procure.example/portal.html#t=pfi_')));
      assert.deepEqual(published.invitations.map((row) => row.delivery_status), ['copied', 'copied']);
      const q = await json(await fetch(`${base}/api/portal/questions`, {
        method: 'POST',
        headers: { ...bearer(tokens[0].token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'Welke kleur?' })
      }));
      assert.equal(q.status, 201, JSON.stringify(q.body));
      const answered = await json(await fetch(`${base}/api/sourcing/events/${eventId}/questions/${q.body.id}/answer`, {
        method: 'POST',
        headers: { ...buyer(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: 'Zwart', visibility: 'all' })
      }));
      assert.equal(answered.status, 200, JSON.stringify(answered.body));
      const log = await db.prepare(`SELECT kind, status FROM sourcing_mail_log ORDER BY id`).all();
      assert.ok(log.length >= 4);
      assert.ok(log.every((row) => row.status === 'skipped'), JSON.stringify(log));
      assert.deepEqual([...new Set(log.map((row) => row.kind))].sort(), ['invitation', 'qa_answer']);
      const overview = await mailOverview(db, {});
      assert.equal(overview.provider, 'none');
      assert.equal(overview.configured, false);
      assert.equal(overview.copy_link_fallback, true);
    }));
  });

  test('with a fake provider mail goes out after the commit, and a failure is recorded without rolling back', async () => {
    const db = await createMemoryDatabase();
    await seedWorld(db);
    const clock = { ms: Date.parse('2026-10-08T12:00:00.000Z') };
    const sent = [];
    const seenAtSend = [];
    let failNext = false;
    const mailOptions = {
      awaitMail: true,
      mailTransport: async (message) => {
        // The RFQ must already be published and committed when the mail leaves.
        seenAtSend.push((await db.prepare(`SELECT status FROM sourcing_events ORDER BY id DESC LIMIT 1`).get())?.status);
        if (failNext) throw Object.assign(new Error('relay said no'), { code: 'smtp_refused' });
        sent.push(message);
      }
    };
    const app = createApp({ db, config: loadDbConfig({}), now: () => new Date(clock.ms), mailOptions });
    await withEnv(SMTP, () => withServer(app, async (base) => {
      const { published, tokens } = await publishTwo(base);
      assert.deepEqual(published.invitations.map((row) => row.delivery_status), ['sent', 'sent']);
      assert.equal(sent.length, 2);
      assert.ok(seenAtSend.every((status) => status === 'published'));
      for (const message of sent) {
        assert.match(message.text, /https:\/\/procure\.example\/portal\.html#t=pfi_/);
        assert.equal(message.from, 'inkoop@procure.example');
      }

      // A bid receipt: no amounts, no link.
      sent.length = 0;
      const lineId = (await json(await fetch(`${base}/api/portal`, { headers: bearer(tokens[0].token) }))).body.event.lines[0].id;
      const offer = {
        submission_id: randomUUID(),
        validity_until: '2026-12-31',
        default_lead_time_days: 4,
        lines: [{ event_line_id: lineId, quoted: true, unit_price_cents: 123457, lead_time_days: 6 }]
      };
      const submitted = await json(await fetch(`${base}/api/portal/bids`, {
        method: 'POST',
        headers: { ...bearer(tokens[0].token), 'Content-Type': 'application/json' },
        body: JSON.stringify(offer)
      }));
      assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
      assert.equal(sent.length, 1);
      assert.equal(sent[0].to, 'ann@active.test');
      assert.match(sent[0].subject, /Ontvangstbevestiging/);
      assert.doesNotMatch(sent[0].text, /1234|12\.34|12,34|https?:|pfi_/);
      assert.match(sent[0].text, /Revisie: 1/);

      // A replay of the same submission sends nothing more.
      await fetch(`${base}/api/portal/bids`, {
        method: 'POST',
        headers: { ...bearer(tokens[0].token), 'Content-Type': 'application/json' },
        body: JSON.stringify(offer)
      });
      assert.equal(sent.length, 1);

      // The relay fails: the bid is still stored, the answer is still 201, the failure is logged.
      failNext = true;
      const revised = await json(await fetch(`${base}/api/portal/bids`, {
        method: 'POST',
        headers: { ...bearer(tokens[0].token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...offer, submission_id: randomUUID() })
      }));
      assert.equal(revised.status, 201);
      assert.equal(revised.body.revision, 2);
      const failed = await db.prepare(`SELECT kind, status FROM sourcing_mail_log WHERE status = 'failed'`).all();
      assert.deepEqual(failed.map((row) => row.kind), ['bid_receipt']);

      // Publish with a broken relay: the RFQ is published, deliveries are 'failed'.
      const created = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...buyer(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Tafels', deadline_at: '2026-10-08T15:00:00.000Z',
          lines: [{ description: 'Tafel', category: 'Office Supplies', quantity: 1 }],
          invitations: [{ supplier_id: 2, contact_email: 'ann@active.test' }]
        })
      }));
      const second = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}/publish`, {
        method: 'POST',
        headers: { ...buyer(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_version: created.body.row_version })
      }));
      assert.equal(second.status, 200, JSON.stringify(second.body));
      assert.equal(second.body.status, 'published');
      assert.equal(second.body.invitations[0].delivery_status, 'failed');
      const overview = await mailOverview(db, SMTP);
      assert.equal(overview.configured, true);
      assert.ok(overview.by_kind.some((row) => row.kind === 'invitation' && row.status === 'failed'));
      assert.ok(overview.recent_failures.length >= 2);
      assert.doesNotMatch(JSON.stringify(overview), /@|pfi_/, 'no addresses and no links in the admin overview');
    }));
  });

  test('Q&A answers: a private answer goes to the asker, a shared answer to every live invitee', async () => {
    const db = await createMemoryDatabase();
    await seedWorld(db);
    const clock = { ms: Date.parse('2026-10-08T12:00:00.000Z') };
    const sent = [];
    const app = createApp({
      db, config: loadDbConfig({}), now: () => new Date(clock.ms),
      mailOptions: { awaitMail: true, mailTransport: async (message) => { sent.push(message); } }
    });
    await withEnv(SMTP, () => withServer(app, async (base) => {
      const { eventId, tokens } = await publishTwo(base);
      const ask = async (text) => (await json(await fetch(`${base}/api/portal/questions`, {
        method: 'POST',
        headers: { ...bearer(tokens[0].token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: text })
      }))).body;
      const answer = async (id, visibility) => json(await fetch(`${base}/api/sourcing/events/${eventId}/questions/${id}/answer`, {
        method: 'POST',
        headers: { ...buyer(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: 'Zie bijlage', visibility })
      }));
      sent.length = 0;
      await answer((await ask('Privé vraag?')).id, 'private');
      assert.deepEqual(sent.map((m) => m.to), ['ann@active.test']);
      sent.length = 0;
      await answer((await ask('Gedeelde vraag?')).id, 'all');
      assert.deepEqual(sent.map((m) => m.to).sort(), ['ann@active.test', 'otto@other.test']);
      assert.ok(sent.every((m) => /Gedeelde vraag/.test(m.text) && !/pfi_|https?:/.test(m.text)));
    }));
  });

  test('the plaintext link is in no table and in no log line', async () => {
    const db = await createMemoryDatabase();
    await seedWorld(db);
    const clock = { ms: Date.parse('2026-10-08T12:00:00.000Z') };
    const app = createApp({
      db, config: loadDbConfig({}), now: () => new Date(clock.ms),
      mailOptions: { awaitMail: true, mailTransport: async () => { throw Object.assign(new Error('relay said no: pfi_SECRET'), { code: 'smtp_refused' }); } }
    });
    const logged = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    for (const level of Object.keys(original)) console[level] = (...args) => logged.push(args.map(String).join(' '));
    try {
      await withEnv(SMTP, () => withServer(app, async (base) => {
        const { tokens, eventId } = await publishTwo(base);
        const rotated = await json(await fetch(`${base}/api/sourcing/events/${eventId}/invitations/${tokens[0].id}/rotate`, {
          method: 'POST', headers: buyer()
        }));
        const links = [...tokens.map((row) => row.token), tokenOf(rotated.body.portal_url)];
        assert.ok(links.every(Boolean));
        const everything = await everyRowText(db);
        for (const token of links) {
          assert.equal(everything.includes(token), false, 'a token is in a table');
          assert.equal(logged.join('\n').includes(token), false, 'a token is in a log line');
        }
        assert.equal(logged.join('\n').includes('pfi_SECRET'), false, 'the relay dialogue is not logged');
        assert.ok(logged.some((line) => /mail: send failed/.test(line)), 'the failure is logged by code');
      }));
    } finally {
      Object.assign(console, original);
    }
  });
});
