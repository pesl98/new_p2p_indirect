import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { appendComplianceEvents, complianceRowHash, canonicalCompliancePayload, GENESIS_HASH } from './complianceAudit.js';
import { createMemoryDatabase } from './db.js';
import { loadDbConfig } from './dbConfig.js';
import { sendMail } from './mail/index.js';
import { smtpTextBody } from './mail/providers/smtp.js';
import { mintPortalToken } from './sourcingPortalTokens.js';
import { withCookie } from './testSession.js';

const SECRET = '0123456789abcdef0123456789abcdef';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const INVALID_LINK = {
  error: 'Deze link is ongeldig of verlopen. Neem contact op met de inkoper.',
  code: 'portal_link_invalid'
};

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', async () => {
      try {
        const { port } = server.address();
        await fn(`http://127.0.0.1:${port}`);
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
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body, headers: response.headers, text };
}

function authHeaders(userId, extra = {}) {
  return withCookie(userId, { headers: extra }).headers;
}

async function seedWorld(db) {
  await db.prepare(`
    INSERT INTO departments (id, code, name) VALUES
      (1, 'MKT', 'Marketing'),
      (2, 'FIN', 'Finance')
  `).run();
  await db.prepare(`
    INSERT INTO users (id, name, email, role, department_id, title, status) VALUES
      (1, 'Alice Chen', 'alice@example.com', 'requester', 1, 'Specialist', 'active'),
      (2, 'Bob Approver', 'bob@example.com', 'approver', 1, 'Head', 'active'),
      (3, 'Carol Zhang', 'carol@example.com', 'procurement', 1, 'Buyer', 'active'),
      (4, 'David Miller', 'david@example.com', 'finance', 2, 'Controller', 'active'),
      (5, 'Elena Rostova', 'elena@example.com', 'admin', 2, 'CFO', 'active'),
      (6, 'Frank Buyer', 'frank@example.com', 'procurement', 1, 'Buyer', 'active')
  `).run();
  await db.prepare(`
    INSERT INTO suppliers (id, name, code, contact_person, email, status) VALUES
      (1, 'Default Vendor', 'DEF', 'Pat', 'pat@default.test', 'active'),
      (2, 'Active Supply', 'ACT', 'Ann', 'ann@active.test', 'active'),
      (3, 'Paused Supply', 'PAU', 'Paul', 'paul@paused.test', 'inactive')
  `).run();
}

async function withPortalEnv(fn) {
  const prev = {
    SOURCING_ENABLED: process.env.SOURCING_ENABLED,
    PORTAL_TOKEN_SECRET: process.env.PORTAL_TOKEN_SECRET,
    APP_BASE_URL: process.env.APP_BASE_URL,
    MAIL_PROVIDER: process.env.MAIL_PROVIDER,
    MAIL_FROM: process.env.MAIL_FROM,
    MAIL_SMTP_URL: process.env.MAIL_SMTP_URL
  };
  process.env.SOURCING_ENABLED = '1';
  process.env.PORTAL_TOKEN_SECRET = SECRET;
  process.env.APP_BASE_URL = 'https://procure.example';
  process.env.MAIL_PROVIDER = 'none';
  delete process.env.MAIL_FROM;
  delete process.env.MAIL_SMTP_URL;
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function tokenFromUrl(url) {
  return new URLSearchParams(String(url || '').split('#')[1] || '').get('t');
}

function bearer(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

function walk(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      visit(key, child);
      walk(child, visit);
    }
  }
}

describe('sourcing portal', () => {
  test('a multi-row compliance insert stays on the hash chain', async () => {
    const db = await createMemoryDatabase();
    await db.immediateTransaction(async () => {
      await appendComplianceEvents(db, [1, 2, 3].map((n) => ({
        actor_user_id: 3,
        actor_name: 'Carol Zhang',
        actor_role: 'procurement',
        action: 'SOURCING_INVITATION_SENT',
        entity_type: 'sourcing_invitation',
        entity_id: n,
        details: JSON.stringify({ invitation_id: n }),
        created_at: '2026-10-08 12:00:00'
      })));
    })();
    const rows = await db.prepare(`
      SELECT action, actor_user_id, actor_name, actor_role, entity_type, entity_id, details, created_at, prev_hash, row_hash
      FROM compliance_audit_events ORDER BY id ASC
    `).all();
    assert.equal(rows.length, 3);
    let prev = GENESIS_HASH;
    for (const row of rows) {
      assert.equal(row.prev_hash, prev);
      prev = complianceRowHash(prev, canonicalCompliancePayload(row));
      assert.equal(row.row_hash, prev);
    }
  });

  test('publish, bids, sealing, isolation, and link states', async () => {
    const db = await createMemoryDatabase();
    await seedWorld(db);
    const clock = { ms: Date.parse('2026-10-08T12:00:00.000Z') };
    const app = createApp({
      db,
      config: loadDbConfig({}),
      now: () => new Date(clock.ms)
    });
    await withPortalEnv(() => withServer(app, async (base) => {
      const past = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Te laat',
          deadline_at: '2026-10-08T11:00:00.000Z',
          lines: [{ description: 'Stoel', category: 'Office Supplies', quantity: 1 }],
          invitations: [{ supplier_id: 2, contact_email: 'ann@active.test' }]
        })
      }));
      assert.equal(past.status, 201, JSON.stringify(past.body));
      const refused = await json(await fetch(`${base}/api/sourcing/events/${past.body.id}/publish`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_version: past.body.row_version })
      }));
      assert.equal(refused.status, 409);
      assert.equal(refused.body.code, 'deadline_in_the_past');
      assert.ok(refused.body.blockers.includes('deadline_in_the_past'));

      const created = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Bureaustoelen',
          description: 'Specificatie voor de leverancier',
          deadline_at: '2026-10-08T14:00:00.000Z',
          qa_enabled: true,
          lines: [{
            description: 'Stoel',
            category: 'Office Supplies',
            quantity: 1,
            target_unit_price_cents: 1_000_000,
            notes: 'intern niet delen'
          }],
          invitations: [
            { supplier_id: 2, contact_name: 'Ann', contact_email: 'ann@active.test' },
            { supplier_id: 1, contact_name: 'Pat', contact_email: 'pat@default.test' }
          ],
          evaluators: [6]
        })
      }));
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const invitationIds = created.body.invitations.map((row) => row.id);

      const published = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}/publish`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_version: created.body.row_version })
      }));
      assert.equal(published.status, 200, JSON.stringify(published.body));
      assert.equal(published.body.status, 'published');
      assert.deepEqual(published.body.invitations.map((row) => row.id), invitationIds);
      assert.ok(published.body.warnings.includes('few_invitations'));
      const links = new Map(published.body.invitations.map((row) => [row.contact_email, tokenFromUrl(row.portal_url)]));
      const tokenA = links.get('ann@active.test');
      const tokenB = links.get('pat@default.test');
      assert.ok(tokenA && tokenB && tokenA !== tokenB);
      assert.match(published.body.invitations[0].portal_url, /^https:\/\/procure\.example\/portal\.html#t=/);

      const stored = JSON.stringify(await db.prepare(`SELECT * FROM sourcing_invitations`).all());
      const ledger = JSON.stringify(await db.prepare(`SELECT details FROM compliance_audit_events`).all());
      const audits = JSON.stringify(await db.prepare(`SELECT details FROM audit_logs WHERE entity_type = 'sourcing_event'`).all());
      assert.equal(stored.includes(tokenA), false);
      assert.equal(stored.includes(tokenB), false);
      assert.equal(ledger.includes(tokenA), false);
      assert.equal(audits.includes(tokenA), false);
      const sent = await db.prepare(`
        SELECT COUNT(*) AS n FROM compliance_audit_events WHERE action = 'SOURCING_INVITATION_SENT'
      `).get();
      assert.equal(Number(sent.n), 2);
      const copied = await db.prepare(`SELECT delivery_status FROM sourcing_invitations WHERE event_id = ?`).all(created.body.id);
      assert.deepEqual(copied.map((row) => row.delivery_status), ['copied', 'copied']);

      const again = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}`, { headers: authHeaders(3) }));
      assert.equal(JSON.stringify(again.body).includes(tokenA), false);
      assert.equal(again.body.invitations.some((row) => row.portal_url), false);
      assert.equal(again.body.invitations.some((row) => row.token_hash), false);

      const viewA = await json(await fetch(`${base}/api/portal`, { headers: bearer(tokenA) }));
      assert.equal(viewA.status, 200, JSON.stringify(viewA.body));
      assert.equal(viewA.headers.get('cache-control'), 'no-store');
      assert.equal(viewA.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(viewA.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(viewA.headers.get('x-frame-options'), 'DENY');
      assert.equal(viewA.headers.get('access-control-allow-origin'), null);
      const forbidden = [];
      walk(viewA.body, (key) => forbidden.push(key));
      for (const key of ['supplier_id', 'event_id', 'invitation_id', 'token_hash', 'row_version', 'target_unit_price_cents', 'owner_user_id', 'notes']) {
        assert.equal(forbidden.includes(key), false, key);
      }
      assert.equal(JSON.stringify(viewA.body).includes('intern niet delen'), false);
      assert.equal(JSON.stringify(viewA.body).includes('pat@default.test'), false);
      assert.equal(viewA.body.event.event_number, published.body.event_number);
      assert.equal(viewA.body.bid, null);
      const opened = await db.prepare(`
        SELECT COUNT(*) AS n FROM compliance_audit_events WHERE action = 'SOURCING_INVITATION_OPENED'
      `).get();
      assert.equal(Number(opened.n), 1);
      await json(await fetch(`${base}/api/portal`, { headers: bearer(tokenA) }));
      const openedAgain = await db.prepare(`
        SELECT COUNT(*) AS n FROM compliance_audit_events WHERE action = 'SOURCING_INVITATION_OPENED'
      `).get();
      assert.equal(Number(openedAgain.n), 1);

      const cookieOnly = await json(await fetch(`${base}/api/portal`, { headers: authHeaders(3) }));
      assert.equal(cookieOnly.status, 401);
      assert.deepEqual(cookieOnly.body, INVALID_LINK);

      const forged = `pfi_${'a'.repeat(43)}.${'b'.repeat(22)}`;
      const badMac = await json(await fetch(`${base}/api/portal`, { headers: bearer(forged) }));
      assert.equal(badMac.status, 401);
      assert.deepEqual(badMac.body, INVALID_LINK);

      const lineId = viewA.body.event.lines[0].id;
      const offer = (price, id = randomUUID()) => ({
        submission_id: id,
        validity_until: '2026-12-31',
        default_lead_time_days: 4,
        supplier_note: 'Graag',
        lines: [{
          event_line_id: lineId,
          quoted: true,
          unit_price_cents: price,
          lead_time_days: 6,
          comment: 'snel'
        }]
      });
      const firstId = randomUUID();
      clock.ms = Date.parse('2026-10-08T13:59:59.999Z');
      const submitted = await json(await fetch(`${base}/api/portal/bids`, {
        method: 'POST',
        headers: { ...bearer(tokenA), 'Content-Type': 'application/json' },
        body: JSON.stringify(offer(424242, firstId))
      }));
      assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
      assert.equal(submitted.body.revision, 1);
      assert.equal(submitted.body.replayed, false);
      assert.match(submitted.body.content_sha256, /^[a-f0-9]{64}$/);

      const replay = await json(await fetch(`${base}/api/portal/bids`, {
        method: 'POST',
        headers: { ...bearer(tokenA), 'Content-Type': 'application/json' },
        body: JSON.stringify(offer(1, firstId))
      }));
      assert.equal(replay.status, 200);
      assert.equal(replay.body.replayed, true);
      assert.equal(replay.body.revision, 1);
      assert.equal(replay.body.content_sha256, submitted.body.content_sha256);

      const revised = await json(await fetch(`${base}/api/portal/bids`, {
        method: 'POST',
        headers: { ...bearer(tokenA), 'Content-Type': 'application/json' },
        body: JSON.stringify(offer(424242))
      }));
      assert.equal(revised.status, 201, JSON.stringify(revised.body));
      assert.equal(revised.body.revision, 2);

      const uploaded = await json(await fetch(`${base}/api/portal/files`, {
        method: 'POST',
        headers: { ...bearer(tokenA), 'Content-Type': 'application/pdf', 'X-Filename': 'offerte.pdf' },
        body: PDF
      }));
      assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
      const download = await fetch(`${base}/api/portal/files/${uploaded.body.id}`, { headers: bearer(tokenA) });
      assert.equal(download.status, 200);
      assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
      assert.match(download.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      assert.match(download.headers.get('content-disposition'), /attachment/);
      const asked = await json(await fetch(`${base}/api/portal/questions`, {
        method: 'POST',
        headers: { ...bearer(tokenA), 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'Alleen voor Ann' })
      }));
      assert.equal(asked.status, 201, JSON.stringify(asked.body));

      const buyerBodies = [];
      for (const path of [
        '/api/sourcing/events',
        `/api/sourcing/events/${created.body.id}`,
        `/api/sourcing/events/${created.body.id}/comparison`,
        `/api/sourcing/events/${created.body.id}/questions`
      ]) {
        const response = await json(await fetch(`${base}${path}`, { headers: authHeaders(3) }));
        assert.equal(response.status, 200, `${path} ${JSON.stringify(response.body)}`);
        buyerBodies.push(JSON.stringify(response.body));
      }
      const sealedFile = await json(await fetch(
        `${base}/api/sourcing/events/${created.body.id}/bid-files/${uploaded.body.id}`,
        { headers: authHeaders(3) }
      ));
      assert.equal(sealedFile.status, 404);
      assert.equal(sealedFile.body.code, 'file_not_found');
      buyerBodies.push(JSON.stringify(sealedFile.body));
      const joined = buyerBodies.join('\n');
      assert.equal(joined.includes('424242'), false);
      assert.equal(joined.includes(submitted.body.content_sha256), false);
      assert.equal(joined.includes('"lead_time_days"'), false);
      assert.equal(joined.includes('"default_lead_time_days"'), false);
      assert.equal(joined.includes('"unit_price_cents"'), false);
      assert.equal(joined.includes('"total_cents"'), false);
      const comparison = JSON.parse(buyerBodies[2]);
      assert.equal(comparison.sealed, true);
      assert.equal(Object.hasOwn(comparison, 'bids'), false);
      const detail = JSON.parse(buyerBodies[1]);
      const ann = detail.invitations.find((row) => row.contact_email === 'ann@active.test');
      assert.equal(ann.portal_status, 'submitted');
      assert.equal(ann.revision_count, 3);
      assert.equal(ann.attachment_count, 1);
      assert.ok(ann.submitted_at);

      const viewB = await json(await fetch(`${base}/api/portal`, { headers: bearer(tokenB) }));
      assert.equal(viewB.status, 200, JSON.stringify(viewB.body));
      const textB = JSON.stringify(viewB.body);
      assert.equal(textB.includes('424242'), false);
      assert.equal(textB.includes('Alleen voor Ann'), false);
      assert.equal(textB.includes('ann@active.test'), false);
      assert.equal(textB.includes(submitted.body.content_sha256), false);
      assert.equal(viewB.body.bid, null);
      const foreignFile = await json(await fetch(`${base}/api/portal/files/${uploaded.body.id}`, { headers: bearer(tokenB) }));
      assert.equal(foreignFile.status, 404);
      assert.equal(foreignFile.body.code, 'file_not_found');

      const answered = await json(await fetch(
        `${base}/api/sourcing/events/${created.body.id}/questions/${asked.body.id}/answer`,
        {
          method: 'POST',
          headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
          body: JSON.stringify({ answer: 'Voor iedereen', visibility: 'all' })
        }
      ));
      assert.equal(answered.status, 200, JSON.stringify(answered.body));
      const afterAnswer = await json(await fetch(`${base}/api/portal`, { headers: bearer(tokenB) }));
      const shared = afterAnswer.body.questions.find((row) => row.answer === 'Voor iedereen');
      assert.ok(shared);
      assert.equal(shared.own, false);
      assert.equal(JSON.stringify(shared).includes('ann@'), false);

      const withdrawn = await json(await fetch(`${base}/api/portal/bids/withdraw`, {
        method: 'POST',
        headers: bearer(tokenA)
      }));
      assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
      assert.equal(withdrawn.body.status, 'withdrawn');
      const resubmitted = await json(await fetch(`${base}/api/portal/bids`, {
        method: 'POST',
        headers: { ...bearer(tokenA), 'Content-Type': 'application/json' },
        body: JSON.stringify(offer(424242))
      }));
      assert.equal(resubmitted.status, 201, JSON.stringify(resubmitted.body));
      assert.equal(resubmitted.body.revision, 4);

      clock.ms = Date.parse('2026-10-08T14:00:00.000Z');
      const late = await json(await fetch(`${base}/api/portal/bids`, {
        method: 'POST',
        headers: { ...bearer(tokenA), 'Content-Type': 'application/json' },
        body: JSON.stringify(offer(9))
      }));
      assert.equal(late.status, 409);
      assert.equal(late.body.code, 'deadline_passed');
      assert.match(late.body.error, /gesloten om/);
      const revisions = await db.prepare(`
        SELECT COUNT(*) AS n FROM sourcing_bid_revisions r
        JOIN sourcing_bids b ON b.id = r.bid_id
        WHERE b.event_id = ?
      `).get(created.body.id);
      assert.equal(Number(revisions.n), 4);
      const lateAudit = await db.prepare(`
        SELECT COUNT(*) AS n FROM compliance_audit_events WHERE action = 'SOURCING_BID_REJECTED_LATE'
      `).get();
      assert.equal(Number(lateAudit.n), 1);
      let blocked = false;
      try {
        await db.prepare(`
          INSERT INTO sourcing_bid_revisions (
            bid_id, revision, submission_id, total_cents, quoted_line_count, content_sha256, submitted_at
          ) VALUES (
            (SELECT id FROM sourcing_bids WHERE event_id = ?),
            9, 'direct-late', 1, 1, 'abc', '2026-10-08T14:00:00.000Z'
          )
        `).run(created.body.id);
      } catch (error) {
        blocked = /deadline/i.test(String(error?.message || error));
        if (!blocked) throw error;
      }
      assert.equal(blocked, true);

      const openedBids = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}/comparison`, {
        headers: authHeaders(3)
      }));
      assert.equal(openedBids.body.sealed, false);
      assert.equal(JSON.stringify(openedBids.body).includes('424242'), true);
      const frank = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}/comparison`, {
        headers: authHeaders(6)
      }));
      assert.equal(frank.body.sealed, true);
      assert.equal(frank.body.prices_hidden, true);
      assert.equal(JSON.stringify(frank.body).includes('424242'), false);
      const openedTwice = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}/comparison`, {
        headers: authHeaders(3)
      }));
      assert.equal(openedTwice.body.sealed, false);
      const openedRows = await db.prepare(`
        SELECT COUNT(*) AS n FROM compliance_audit_events
        WHERE action = 'SOURCING_BIDS_OPENED' AND entity_id = ? AND actor_user_id = 3
      `).get(created.body.id);
      assert.equal(Number(openedRows.n), 1);
      const buyerFile = await fetch(
        `${base}/api/sourcing/events/${created.body.id}/bid-files/${uploaded.body.id}`,
        { headers: authHeaders(3) }
      );
      assert.equal(buyerFile.status, 200);
      assert.equal(buyerFile.headers.get('x-content-type-options'), 'nosniff');
      assert.match(buyerFile.headers.get('content-security-policy'), /frame-ancestors 'none'/);

      const webhook = await db.prepare(`
        SELECT payload FROM webhook_outbox WHERE event_type = 'sourcing_bid.submitted' ORDER BY id DESC LIMIT 1
      `).get();
      const payload = JSON.parse(webhook.payload);
      assert.deepEqual(Object.keys(payload).sort(), [
        'content_sha256', 'event_number', 'revision', 'submitted_at', 'supplier_code', 'supplier_external_id'
      ]);
      assert.equal(JSON.stringify(payload).includes('424242'), false);

      const actions = await db.prepare(`
        SELECT action FROM compliance_audit_events
        WHERE action IN (
          'SOURCING_BID_SUBMITTED', 'SOURCING_BID_REVISED', 'SOURCING_BID_WITHDRAWN', 'SOURCING_INVITATION_OPENED'
        )
      `).all();
      assert.equal(actions.filter((row) => row.action === 'SOURCING_BID_SUBMITTED').length, 1);
      assert.equal(actions.filter((row) => row.action === 'SOURCING_BID_REVISED').length, 3);
      assert.equal(actions.filter((row) => row.action === 'SOURCING_BID_WITHDRAWN').length, 1);
    }));
  });

  test('revoked, expired, rotated, and unknown tokens share one 401 body', async () => {
    const db = await createMemoryDatabase();
    await seedWorld(db);
    const clock = { ms: Date.parse('2026-10-08T12:00:00.000Z') };
    const app = createApp({ db, config: loadDbConfig({}), now: () => new Date(clock.ms) });
    await withPortalEnv(() => withServer(app, async (base) => {
      const created = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Links',
          deadline_at: '2026-10-08T14:00:00.000Z',
          lines: [{ description: 'Stoel', category: 'Office Supplies', quantity: 1 }],
          invitations: [{ supplier_id: 2, contact_email: 'ann@active.test' }]
        })
      }));
      const published = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}/publish`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_version: created.body.row_version })
      }));
      assert.equal(published.status, 200, JSON.stringify(published.body));
      const invitationId = published.body.invitations[0].id;
      const token = tokenFromUrl(published.body.invitations[0].portal_url);

      const rotated = await json(await fetch(
        `${base}/api/sourcing/events/${created.body.id}/invitations/${invitationId}/rotate`,
        { method: 'POST', headers: authHeaders(3) }
      ));
      assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
      const nextToken = tokenFromUrl(rotated.body.portal_url);
      assert.notEqual(nextToken, token);
      const oldLink = await json(await fetch(`${base}/api/portal`, { headers: bearer(token) }));
      assert.deepEqual(oldLink.body, INVALID_LINK);
      const fresh = await json(await fetch(`${base}/api/portal`, { headers: bearer(nextToken) }));
      assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
      const afterRotate = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}`, { headers: authHeaders(3) }));
      assert.equal(JSON.stringify(afterRotate.body).includes(nextToken), false);

      const revoked = await json(await fetch(
        `${base}/api/sourcing/events/${created.body.id}/invitations/${invitationId}/revoke`,
        {
          method: 'POST',
          headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'Verkeerde contactpersoon' })
        }
      ));
      assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
      const dead = await json(await fetch(`${base}/api/portal`, { headers: bearer(nextToken) }));
      assert.equal(dead.status, 401);
      assert.deepEqual(dead.body, INVALID_LINK);
      const revokedAudit = await db.prepare(`
        SELECT COUNT(*) AS n FROM compliance_audit_events WHERE action = 'SOURCING_LINK_REVOKED'
      `).get();
      assert.equal(Number(revokedAudit.n), 1);

      await db.prepare(`
        UPDATE sourcing_invitations SET revoked_at = NULL, expires_at = ? WHERE id = ?
      `).run('2026-10-01T00:00:00.000Z', invitationId);
      const expired = await json(await fetch(`${base}/api/portal`, {
        headers: bearer(nextToken, { 'X-Forwarded-For': '203.0.113.8' })
      }));
      assert.deepEqual(expired.body, INVALID_LINK);
      const forged = await json(await fetch(`${base}/api/portal`, {
        headers: bearer(`pfi_${'c'.repeat(43)}.${'d'.repeat(22)}`)
      }));
      assert.deepEqual(forged.body, expired.body);
    }));
  });

  test('cancel notifies invitees and the portal shows the cancelled state', async () => {
    const db = await createMemoryDatabase();
    await seedWorld(db);
    const clock = { ms: Date.parse('2026-10-08T12:00:00.000Z') };
    const app = createApp({ db, config: loadDbConfig({}), now: () => new Date(clock.ms) });
    await withPortalEnv(() => withServer(app, async (base) => {
      const created = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Wordt geannuleerd',
          deadline_at: '2026-10-08T14:00:00.000Z',
          lines: [{ description: 'Stoel', category: 'Office Supplies', quantity: 1 }],
          invitations: [{ supplier_id: 2, contact_email: 'ann@active.test' }]
        })
      }));
      const published = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}/publish`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_version: created.body.row_version })
      }));
      const token = tokenFromUrl(published.body.invitations[0].portal_url);
      const cancelled = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}/cancel`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'De behoefte is vervallen' })
      }));
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
      assert.equal(cancelled.body.status, 'cancelled');
      assert.equal(cancelled.body.notice.delivery_status, 'copied');
      assert.equal(JSON.stringify(cancelled.body.notice).includes(token), false);
      const portal = await json(await fetch(`${base}/api/portal`, { headers: bearer(token) }));
      assert.equal(portal.status, 200, JSON.stringify(portal.body));
      assert.equal(portal.body.event.status, 'cancelled');
      assert.match(portal.body.event.cancel_reason, /vervallen/);
      const late = await json(await fetch(`${base}/api/portal/bids`, {
        method: 'POST',
        headers: { ...bearer(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          submission_id: randomUUID(),
          lines: [{ event_line_id: portal.body.event.lines[0].id, quoted: true, unit_price_cents: 10 }]
        })
      }));
      assert.equal(late.status, 409);
      assert.equal(late.body.code, 'event_cancelled');
      const bids = await db.prepare(`SELECT COUNT(*) AS n FROM sourcing_bids`).get();
      assert.equal(Number(bids.n), 0);
    }));
  });

  test('portal rate limits, headers, and a hidden server error', async () => {
    const db = await createMemoryDatabase();
    await seedWorld(db);
    const clock = { ms: Date.parse('2026-10-08T12:00:00.000Z') };
    const app = createApp({ db, config: loadDbConfig({}), now: () => new Date(clock.ms) });
    await withPortalEnv(() => withServer(app, async (base) => {
      const options = await fetch(`${base}/api/portal`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.example' }
      });
      assert.equal(options.status, 204);
      assert.equal(options.headers.get('access-control-allow-origin'), null);

      const created = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Limiet',
          deadline_at: '2026-10-08T14:00:00.000Z',
          lines: [{ description: 'Stoel', category: 'Office Supplies', quantity: 1 }],
          invitations: [{ supplier_id: 2, contact_email: 'ann@active.test' }]
        })
      }));
      const published = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}/publish`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_version: created.body.row_version })
      }));
      const token = tokenFromUrl(published.body.invitations[0].portal_url);
      let limited = null;
      for (let n = 0; n < 61; n += 1) {
        limited = await json(await fetch(`${base}/api/portal`, { headers: bearer(token) }));
      }
      assert.equal(limited.status, 429);
      assert.equal(limited.body.code, 'rate_limited');
      assert.equal(JSON.stringify(limited.body).toLowerCase().includes('sqlite'), false);

      let unknown = null;
      for (let n = 0; n < 21; n += 1) {
        const minted = mintPortalToken(SECRET);
        unknown = await json(await fetch(`${base}/api/portal`, {
          headers: bearer(minted.token, { 'X-Forwarded-For': '203.0.113.20' })
        }));
      }
      assert.equal(unknown.status, 429);
      assert.equal(unknown.body.code, 'rate_limited');
      const spoofed = await json(await fetch(`${base}/api/portal`, {
        headers: bearer(mintPortalToken(SECRET).token, { 'X-Forwarded-For': '198.51.100.9' })
      }));
      assert.equal(spoofed.status, 429);
      assert.equal(spoofed.body.code, 'rate_limited');

      const original = db.prepare.bind(db);
      db.prepare = (sql) => {
        if (/FROM sourcing_invitations i/i.test(String(sql))) {
          throw new Error('secret turso pipeline detail');
        }
        return original(sql);
      };
      try {
        const broken = await json(await fetch(`${base}/api/portal`, { headers: bearer(token) }));
        assert.equal(broken.status, 500);
        assert.equal(broken.body.error, 'Portal request failed');
        assert.equal(JSON.stringify(broken.body).includes('secret turso'), false);
      } finally {
        db.prepare = original;
      }
    }));
  });

  test('bid files stay at 10 PDFs and 10 uploads a minute', async () => {
    const db = await createMemoryDatabase();
    await seedWorld(db);
    const clock = { ms: Date.parse('2026-10-08T12:00:00.000Z') };
    const app = createApp({ db, config: loadDbConfig({}), now: () => new Date(clock.ms) });
    await withPortalEnv(() => withServer(app, async (base) => {
      const created = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Bijlagen',
          deadline_at: '2026-10-08T14:00:00.000Z',
          lines: [{ description: 'Stoel', category: 'Office Supplies', quantity: 1 }],
          invitations: [{ supplier_id: 2, contact_email: 'ann@active.test' }]
        })
      }));
      const published = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}/publish`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_version: created.body.row_version })
      }));
      const token = tokenFromUrl(published.body.invitations[0].portal_url);
      const upload = (body, name = 'offerte.pdf') => fetch(`${base}/api/portal/files`, {
        method: 'POST',
        headers: { ...bearer(token), 'Content-Type': 'application/pdf', 'X-Filename': name },
        body
      });
      const fake = await json(await upload(Buffer.from('not a pdf')));
      assert.equal(fake.status, 400);
      assert.equal(fake.body.code, 'not_a_pdf');
      const ids = [];
      for (let n = 0; n < 10; n += 1) {
        const saved = await json(await upload(PDF, `offerte-${n}.pdf`));
        assert.equal(saved.status, 201, JSON.stringify(saved.body));
        ids.push(saved.body.id);
      }
      const eleventh = await json(await upload(PDF, 'extra.pdf'));
      assert.equal(eleventh.status, 400);
      assert.equal(eleventh.body.code, 'too_many_files');
      const removed = await json(await fetch(`${base}/api/portal/files/${ids[0]}/remove`, {
        method: 'POST',
        headers: bearer(token)
      }));
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
      const limited = await json(await upload(PDF, 'opnieuw.pdf'));
      assert.equal(limited.status, 429);
      assert.equal(limited.body.code, 'rate_limited');
    }));
  });

  test('a first submit at the deadline writes no bid rows', async () => {
    const db = await createMemoryDatabase();
    await seedWorld(db);
    const clock = { ms: Date.parse('2026-10-08T12:00:00.000Z') };
    const app = createApp({ db, config: loadDbConfig({}), now: () => new Date(clock.ms) });
    await withPortalEnv(() => withServer(app, async (base) => {
      const created = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Op de sluitingstijd',
          deadline_at: '2026-10-08T14:00:00.000Z',
          lines: [{ description: 'Stoel', category: 'Office Supplies', quantity: 1 }],
          invitations: [{ supplier_id: 2, contact_email: 'ann@active.test' }]
        })
      }));
      const published = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}/publish`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_version: created.body.row_version })
      }));
      const token = tokenFromUrl(published.body.invitations[0].portal_url);
      const view = await json(await fetch(`${base}/api/portal`, { headers: bearer(token) }));
      clock.ms = Date.parse('2026-10-08T14:00:00.000Z');
      const late = await json(await fetch(`${base}/api/portal/bids`, {
        method: 'POST',
        headers: { ...bearer(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          submission_id: randomUUID(),
          lines: [{ event_line_id: view.body.event.lines[0].id, quoted: true, unit_price_cents: 50 }]
        })
      }));
      assert.equal(late.status, 409);
      assert.equal(late.body.code, 'deadline_passed');
      const bids = await db.prepare(`SELECT COUNT(*) AS n FROM sourcing_bids`).get();
      const lines = await db.prepare(`SELECT COUNT(*) AS n FROM sourcing_bid_lines`).get();
      assert.equal(Number(bids.n), 0);
      assert.equal(Number(lines.n), 0);
      const audit = await db.prepare(`
        SELECT COUNT(*) AS n FROM compliance_audit_events WHERE action = 'SOURCING_BID_REJECTED_LATE'
      `).get();
      assert.equal(Number(audit.n), 1);
      const closed = await db.prepare(`SELECT status FROM sourcing_events WHERE id = ?`).get(created.body.id);
      assert.equal(closed.status, 'closed');
    }));
  });

  test('smtp delivery is recorded after publish and a failure keeps the link', async () => {
    const db = await createMemoryDatabase();
    await seedWorld(db);
    process.env.SOURCING_ENABLED = '1';
    process.env.PORTAL_TOKEN_SECRET = SECRET;
    process.env.APP_BASE_URL = 'https://procure.example';
    const sent = [];
    const { publishEvent } = await import('./sourcingService.js');
    const createdId = await db.immediateTransaction(async () => {
      const now = '2026-10-08T12:00:00.000Z';
      const result = await db.prepare(`
        INSERT INTO sourcing_events (
          event_number, title, owner_user_id, department_id, status, currency, deadline_at,
          weight_price, weight_lead_time, weight_quality, row_version, created_at, updated_at
        ) VALUES ('RFQ-2026-090', 'Post', 3, 1, 'draft', 'EUR', '2026-10-08T14:00:00.000Z', 70, 15, 15, 1, ?, ?)
      `).run(now, now);
      const eventId = Number(result.lastInsertRowid);
      await db.prepare(`
        INSERT INTO sourcing_event_lines (
          event_id, line_no, description, category, quantity, unit_of_measure, line_type
        ) VALUES (?, 1, 'Stoel', 'Office Supplies', 1, 'each', 'goods')
      `).run(eventId);
      await db.prepare(`
        INSERT INTO sourcing_invitations (
          event_id, supplier_id, contact_email, invited_by_user_id, created_at
        ) VALUES (?, 2, 'ann@active.test', 3, ?)
      `).run(eventId, now);
      return eventId;
    })();
    const view = await publishEvent(db, { id: 3, name: 'Carol Zhang', role: 'procurement' }, createdId, { row_version: 1 }, {
      now: new Date('2026-10-08T12:00:00.000Z'),
      awaitMail: true,
      env: {
        ...process.env,
        MAIL_PROVIDER: 'smtp',
        MAIL_FROM: 'inkoop@procure.example',
        MAIL_SMTP_URL: 'smtp://example.invalid'
      },
      mailTransport: async (message) => {
        sent.push(message);
      }
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /portal\.html#t=/);
    assert.equal(view.invitations[0].delivery_status, 'sent');
    const stored = JSON.stringify(await db.prepare(`SELECT * FROM sourcing_invitations`).all());
    assert.equal(stored.includes(tokenFromUrl(view.invitations[0].portal_url)), false);
    const failed = await sendMail({ to: 'a@b.c', subject: 'x', text: 'y' }, {
      env: { MAIL_PROVIDER: 'smtp', MAIL_FROM: 'a@b.c', MAIL_SMTP_URL: 'smtp://example.invalid' },
      transport: async () => {
        throw new Error('secret smtp dialogue');
      }
    });
    assert.equal(failed.status, 'failed');
    assert.equal(JSON.stringify(failed).includes('secret smtp'), false);
  });

  test('buyer and portal modules are the only readers of bid contents', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
    const allowed = new Set([
      'sourcingBidReadModel.js',
      'sourcingPortalService.js',
      'provision.js',
      // The demo seed only drops the tables and writes demo rows.
      'seed.js',
      // Sprint 8c detective check reads submitted_at only, never prices.
      'complianceReports.js',
      'sourcingAwardFixtures.js',
      'sourcingDemoSeed.js'
    ]);
    const hits = [];
    const walkJs = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) {
          walkJs(full);
          continue;
        }
        if (!name.endsWith('.js') || name.endsWith('.test.js') || allowed.has(name)) continue;
        const src = fs.readFileSync(full, 'utf8');
        if (/sourcing_bid_lines|sourcing_bid_revisions|owner_kind\s*=\s*'bid'/.test(src)) {
          hits.push(path.relative(root, full));
        }
      }
    };
    walkJs(root);
    assert.deepEqual(hits, []);
  });

  test('portal.html is a separate entry and declines a foreign frame', () => {
    const vercel = JSON.parse(fs.readFileSync(path.resolve('vercel.json'), 'utf8'));
    const header = (vercel.headers || []).find((row) => row.source === '/portal.html');
    assert.ok(header, 'portal.html headers');
    const csp = header.headers.find((row) => row.key === 'Content-Security-Policy')?.value || '';
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /fonts\.googleapis/);
    const html = fs.readFileSync(path.resolve('client/portal.html'), 'utf8');
    assert.match(html, /portal\/main\.jsx/);
    assert.doesNotMatch(html, /fonts\.googleapis/);
    assert.doesNotMatch(html, /src\/main\.jsx/);
  });

  test('extending after the deadline does not reopen bidding', async () => {
    const db = await createMemoryDatabase();
    await seedWorld(db);
    const clock = { ms: Date.parse('2026-10-08T15:00:00.000Z') };
    const app = createApp({ db, config: loadDbConfig({}), now: () => new Date(clock.ms) });
    await withPortalEnv(() => withServer(app, async (base) => {
      const created = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Na sluiting',
          deadline_at: '2026-10-08T16:00:00.000Z',
          lines: [{ description: 'Stoel', category: 'Office Supplies', quantity: 1 }],
          invitations: [{ supplier_id: 2, contact_email: 'ann@active.test' }]
        })
      }));
      const published = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}/publish`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_version: created.body.row_version })
      }));
      assert.equal(published.status, 200, JSON.stringify(published.body));
      const token = tokenFromUrl(published.body.invitations[0].portal_url);
      clock.ms = Date.parse('2026-10-08T16:05:00.000Z');
      const extended = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}/deadline`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          row_version: published.body.row_version,
          deadline_at: '2026-10-08T18:00:00.000Z'
        })
      }));
      assert.equal(extended.status, 409, JSON.stringify(extended.body));
      assert.equal(extended.body.code, 'deadline_passed');
      const status = await db.prepare(`SELECT status FROM sourcing_events WHERE id = ?`).get(created.body.id);
      assert.equal(status.status, 'closed');
      const portal = await json(await fetch(`${base}/api/portal`, { headers: bearer(token) }));
      const late = await json(await fetch(`${base}/api/portal/bids`, {
        method: 'POST',
        headers: { ...bearer(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          submission_id: randomUUID(),
          lines: [{ event_line_id: portal.body.event.lines[0].id, quoted: true, unit_price_cents: 10 }]
        })
      }));
      assert.equal(late.status, 409);
      assert.equal(late.body.code, 'deadline_passed');
      const bids = await db.prepare(`SELECT COUNT(*) AS n FROM sourcing_bids`).get();
      assert.equal(Number(bids.n), 0);
    }));
  });

  test('a named overdue RFQ closes even when 21 older ones fill the batch', async () => {
    const db = await createMemoryDatabase();
    await seedWorld(db);
    const clock = { ms: Date.parse('2026-10-08T12:00:00.000Z') };
    const app = createApp({ db, config: loadDbConfig({}), now: () => new Date(clock.ms) });
    await withPortalEnv(() => withServer(app, async (base) => {
      const created = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'De 22e',
          deadline_at: '2026-10-08T14:00:00.000Z',
          lines: [{ description: 'Stoel', category: 'Office Supplies', quantity: 1 }],
          invitations: [
            { supplier_id: 2, contact_email: 'ann@active.test' },
            { supplier_id: 1, contact_email: 'pat@default.test' }
          ]
        })
      }));
      const published = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}/publish`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_version: created.body.row_version })
      }));
      assert.equal(published.status, 200, JSON.stringify(published.body));
      const ann = published.body.invitations.find((row) => row.contact_email === 'ann@active.test');
      const pat = published.body.invitations.find((row) => row.contact_email === 'pat@default.test');
      const portal = await json(await fetch(`${base}/api/portal`, { headers: bearer(tokenFromUrl(ann.portal_url)) }));
      const submitted = await json(await fetch(`${base}/api/portal/bids`, {
        method: 'POST',
        headers: { ...bearer(tokenFromUrl(ann.portal_url)), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          submission_id: randomUUID(),
          lines: [{ event_line_id: portal.body.event.lines[0].id, quoted: true, unit_price_cents: 424242 }]
        })
      }));
      assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
      const stamp = '2026-10-08T12:00:00.000Z';
      for (let n = 1; n <= 21; n += 1) {
        await db.prepare(`
          INSERT INTO sourcing_events (
            event_number, title, department_id, owner_user_id, status, currency, deadline_at,
            weight_price, weight_lead_time, weight_quality, row_version, created_at, updated_at
          ) VALUES (?, 'Ouder', 1, 3, 'published', 'EUR', '2026-10-08T13:00:00.000Z', 70, 15, 15, 1, ?, ?)
        `).run(`RFQ-OLD-${String(n).padStart(3, '0')}`, stamp, stamp);
      }
      clock.ms = Date.parse('2026-10-08T14:01:00.000Z');
      const comparison = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}/comparison`, {
        headers: authHeaders(3)
      }));
      assert.equal(comparison.status, 200, JSON.stringify(comparison.body));
      assert.equal(comparison.body.sealed, false);
      assert.equal(JSON.stringify(comparison.body).includes('424242'), true);
      const target = await db.prepare(`SELECT status FROM sourcing_events WHERE id = ?`).get(created.body.id);
      assert.equal(target.status, 'closed');
      const older = await db.prepare(`
        SELECT COUNT(*) AS n FROM sourcing_events WHERE event_number LIKE 'RFQ-OLD-%' AND status = 'published'
      `).get();
      assert.equal(Number(older.n), 21);
      const extended = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}/deadline`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          row_version: comparison.body.row_version || published.body.row_version,
          deadline_at: '2026-10-08T18:00:00.000Z'
        })
      }));
      assert.equal(extended.status, 409, JSON.stringify(extended.body));
      assert.equal(extended.body.code, 'deadline_passed');
      const competitor = await json(await fetch(`${base}/api/portal/bids`, {
        method: 'POST',
        headers: { ...bearer(tokenFromUrl(pat.portal_url)), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          submission_id: randomUUID(),
          lines: [{ event_line_id: portal.body.event.lines[0].id, quoted: true, unit_price_cents: 10 }]
        })
      }));
      assert.equal(competitor.status, 409);
      assert.notEqual(competitor.status, 201);
      const patBids = await db.prepare(`
        SELECT COUNT(*) AS n FROM sourcing_bids WHERE invitation_id = ?
      `).get(pat.id);
      assert.equal(Number(patBids.n), 0);
    }));
  });

  test('a file added or removed after submit starts a new revision', async () => {
    const db = await createMemoryDatabase();
    await seedWorld(db);
    const clock = { ms: Date.parse('2026-10-08T12:00:00.000Z') };
    const app = createApp({ db, config: loadDbConfig({}), now: () => new Date(clock.ms) });
    await withPortalEnv(() => withServer(app, async (base) => {
      const created = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Bijlage',
          deadline_at: '2026-10-08T14:00:00.000Z',
          lines: [{ description: 'Stoel', category: 'Office Supplies', quantity: 1 }],
          invitations: [{ supplier_id: 2, contact_email: 'ann@active.test' }]
        })
      }));
      const published = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}/publish`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_version: created.body.row_version })
      }));
      const token = tokenFromUrl(published.body.invitations[0].portal_url);
      const early = await json(await fetch(`${base}/api/portal/files`, {
        method: 'POST',
        headers: { ...bearer(token), 'Content-Type': 'application/pdf', 'X-Filename': 'vroeg.pdf' },
        body: PDF
      }));
      assert.equal(early.status, 201, JSON.stringify(early.body));
      const removedEarly = await json(await fetch(`${base}/api/portal/files/${early.body.id}/remove`, {
        method: 'POST',
        headers: bearer(token)
      }));
      assert.equal(removedEarly.status, 200, JSON.stringify(removedEarly.body));
      const beforeBid = await db.prepare(`SELECT COUNT(*) AS n FROM sourcing_bid_revisions`).get();
      assert.equal(Number(beforeBid.n), 0);
      const removedAudit = await db.prepare(`
        SELECT COUNT(*) AS n FROM compliance_audit_events WHERE action = 'SOURCING_BID_FILE_REMOVED'
      `).get();
      assert.equal(Number(removedAudit.n), 1);
      const portal = await json(await fetch(`${base}/api/portal`, { headers: bearer(token) }));
      const submitted = await json(await fetch(`${base}/api/portal/bids`, {
        method: 'POST',
        headers: { ...bearer(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          submission_id: randomUUID(),
          lines: [{ event_line_id: portal.body.event.lines[0].id, quoted: true, unit_price_cents: 100 }]
        })
      }));
      assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
      const uploaded = await json(await fetch(`${base}/api/portal/files`, {
        method: 'POST',
        headers: { ...bearer(token), 'Content-Type': 'application/pdf', 'X-Filename': 'offerte.pdf' },
        body: PDF
      }));
      assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
      const afterAdd = await db.prepare(`
        SELECT revision, content_sha256 FROM sourcing_bid_revisions ORDER BY revision ASC
      `).all();
      assert.equal(afterAdd.length, 2);
      assert.notEqual(afterAdd[1].content_sha256, afterAdd[0].content_sha256);
      const removed = await json(await fetch(`${base}/api/portal/files/${uploaded.body.id}/remove`, {
        method: 'POST',
        headers: bearer(token)
      }));
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
      const afterRemove = await db.prepare(`
        SELECT revision, content_sha256 FROM sourcing_bid_revisions ORDER BY revision ASC
      `).all();
      assert.equal(afterRemove.length, 3);
      assert.equal(afterRemove[2].content_sha256, afterRemove[0].content_sha256);
      const audits = await db.prepare(`
        SELECT COUNT(*) AS n FROM compliance_audit_events WHERE action = 'SOURCING_BID_FILE_REMOVED'
      `).get();
      assert.equal(Number(audits.n), 2);
    }));
  });

  test('declining after a bid withdraws it', async () => {
    const db = await createMemoryDatabase();
    await seedWorld(db);
    const clock = { ms: Date.parse('2026-10-08T12:00:00.000Z') };
    const app = createApp({ db, config: loadDbConfig({}), now: () => new Date(clock.ms) });
    await withPortalEnv(() => withServer(app, async (base) => {
      const created = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Afzien',
          deadline_at: '2026-10-08T14:00:00.000Z',
          lines: [{ description: 'Stoel', category: 'Office Supplies', quantity: 1 }],
          invitations: [{ supplier_id: 2, contact_email: 'ann@active.test' }]
        })
      }));
      const published = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}/publish`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_version: created.body.row_version })
      }));
      const token = tokenFromUrl(published.body.invitations[0].portal_url);
      const portal = await json(await fetch(`${base}/api/portal`, { headers: bearer(token) }));
      const submitted = await json(await fetch(`${base}/api/portal/bids`, {
        method: 'POST',
        headers: { ...bearer(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          submission_id: randomUUID(),
          lines: [{ event_line_id: portal.body.event.lines[0].id, quoted: true, unit_price_cents: 80 }]
        })
      }));
      assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
      const declined = await json(await fetch(`${base}/api/portal/decline`, {
        method: 'POST',
        headers: { ...bearer(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Geen capaciteit' })
      }));
      assert.equal(declined.status, 200, JSON.stringify(declined.body));
      const bid = await db.prepare(`SELECT status FROM sourcing_bids`).get();
      assert.equal(bid.status, 'withdrawn');
      const again = await json(await fetch(`${base}/api/portal/bids`, {
        method: 'POST',
        headers: { ...bearer(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          submission_id: randomUUID(),
          lines: [{ event_line_id: portal.body.event.lines[0].id, quoted: true, unit_price_cents: 90 }]
        })
      }));
      assert.equal(again.status, 409);
      assert.equal(again.body.code, 'invitation_declined');
    }));
  });

  test('parallel submits retry a BUSY begin instead of returning 500', async () => {
    const db = await createMemoryDatabase();
    await seedWorld(db);
    const clock = { ms: Date.parse('2026-10-08T12:00:00.000Z') };
    const app = createApp({ db, config: loadDbConfig({}), now: () => new Date(clock.ms) });
    await withPortalEnv(() => withServer(app, async (base) => {
      const created = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Druk',
          deadline_at: '2026-10-08T14:00:00.000Z',
          lines: [{ description: 'Stoel', category: 'Office Supplies', quantity: 1 }],
          invitations: [{ supplier_id: 2, contact_email: 'ann@active.test' }]
        })
      }));
      const published = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}/publish`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_version: created.body.row_version })
      }));
      const token = tokenFromUrl(published.body.invitations[0].portal_url);
      const portal = await json(await fetch(`${base}/api/portal`, { headers: bearer(token) }));
      const orig = db.immediateTransaction.bind(db);
      let busyLeft = 7;
      db.immediateTransaction = (fn) => {
        const run = orig(fn);
        return async (...args) => {
          if (busyLeft > 0) {
            busyLeft -= 1;
            const error = new Error('SQLITE_BUSY: database is locked');
            error.code = 'SQLITE_BUSY';
            throw error;
          }
          return run(...args);
        };
      };
      try {
        const responses = await Promise.all(Array.from({ length: 8 }, async () => json(await fetch(`${base}/api/portal/bids`, {
          method: 'POST',
          headers: { ...bearer(token), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            submission_id: randomUUID(),
            lines: [{ event_line_id: portal.body.event.lines[0].id, quoted: true, unit_price_cents: 15 }]
          })
        }))));
        assert.equal(busyLeft, 0);
        for (const response of responses) {
          assert.equal(response.status, 201, JSON.stringify(response.body));
          assert.equal(JSON.stringify(response.body).includes('SQLITE_BUSY'), false);
        }
      } finally {
        db.immediateTransaction = orig;
      }
    }));
  });

  test('portal bid JSON above 100 kB is accepted and other routes stay limited', async () => {
    const db = await createMemoryDatabase();
    await seedWorld(db);
    const clock = { ms: Date.parse('2026-10-08T12:00:00.000Z') };
    const app = createApp({ db, config: loadDbConfig({}), now: () => new Date(clock.ms) });
    await withPortalEnv(() => withServer(app, async (base) => {
      const bulky = JSON.stringify({ title: 'x'.repeat(150 * 1024) });
      const buyer = await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: bulky
      });
      assert.equal(buyer.status, 413);
      const created = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Groot',
          deadline_at: '2026-10-08T14:00:00.000Z',
          lines: [{ description: 'Stoel', category: 'Office Supplies', quantity: 1 }],
          invitations: [{ supplier_id: 2, contact_email: 'ann@active.test' }]
        })
      }));
      const published = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}/publish`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_version: created.body.row_version })
      }));
      const token = tokenFromUrl(published.body.invitations[0].portal_url);
      const portal = await json(await fetch(`${base}/api/portal`, { headers: bearer(token) }));
      const bid = await json(await fetch(`${base}/api/portal/bids`, {
        method: 'POST',
        headers: { ...bearer(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          submission_id: randomUUID(),
          lines: [{
            event_line_id: portal.body.event.lines[0].id,
            quoted: true,
            unit_price_cents: 10,
            comment: 'a'.repeat(120 * 1024)
          }]
        })
      }));
      assert.notEqual(bid.status, 413);
      assert.equal(bid.status, 400);
      assert.equal(bid.body.code, 'text_too_long');
    }));
  });

  test('a hung SMTP relay times out and publish still returns the links', async () => {
    assert.equal(smtpTextBody('een\ntwee\n.drie'), 'een\r\ntwee\r\n..drie');
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const started = Date.now();
      const failed = await sendMail({ to: 'a@b.c', subject: 'x', text: 'een\ntwee' }, {
        env: {
          MAIL_PROVIDER: 'smtp',
          MAIL_FROM: 'inkoop@procure.example',
          MAIL_SMTP_URL: `smtp://127.0.0.1:${port}`
        },
        timeoutMs: 200
      });
      assert.equal(failed.status, 'failed');
      assert.ok(Date.now() - started < 2000, `hung relay took ${Date.now() - started}ms`);
      assert.equal(JSON.stringify(failed).includes('SMTP'), false);
    } finally {
      server.close();
    }

    const db = await createMemoryDatabase();
    await seedWorld(db);
    process.env.SOURCING_ENABLED = '1';
    process.env.PORTAL_TOKEN_SECRET = SECRET;
    process.env.APP_BASE_URL = 'https://procure.example';
    const { publishEvent } = await import('./sourcingService.js');
    const createdId = await db.immediateTransaction(async () => {
      const now = '2026-10-08T12:00:00.000Z';
      const result = await db.prepare(`
        INSERT INTO sourcing_events (
          event_number, title, owner_user_id, department_id, status, currency, deadline_at,
          weight_price, weight_lead_time, weight_quality, row_version, created_at, updated_at
        ) VALUES ('RFQ-2026-091', 'Hangt', 3, 1, 'draft', 'EUR', '2026-10-08T14:00:00.000Z', 70, 15, 15, 1, ?, ?)
      `).run(now, now);
      const eventId = Number(result.lastInsertRowid);
      await db.prepare(`
        INSERT INTO sourcing_event_lines (
          event_id, line_no, description, category, quantity, unit_of_measure, line_type
        ) VALUES (?, 1, 'Stoel', 'Office Supplies', 1, 'each', 'goods')
      `).run(eventId);
      await db.prepare(`
        INSERT INTO sourcing_invitations (
          event_id, supplier_id, contact_email, invited_by_user_id, created_at
        ) VALUES (?, 2, 'ann@active.test', 3, ?)
      `).run(eventId, now);
      return eventId;
    })();
    const started = Date.now();
    const view = await publishEvent(db, { id: 3, name: 'Carol Zhang', role: 'procurement' }, createdId, { row_version: 1 }, {
      now: new Date('2026-10-08T12:00:00.000Z'),
      env: {
        ...process.env,
        MAIL_PROVIDER: 'smtp',
        MAIL_FROM: 'inkoop@procure.example',
        MAIL_SMTP_URL: 'smtp://127.0.0.1:9'
      },
      mailTransport: () => new Promise(() => {})
    });
    assert.ok(Date.now() - started < 500);
    assert.match(view.invitations[0].portal_url, /portal\.html#t=/);
    assert.equal(JSON.stringify(await db.prepare(`SELECT token_hash FROM sourcing_invitations`).all()).includes(tokenFromUrl(view.invitations[0].portal_url)), false);
  });

  test('revoked lookups stop writing an audit row after the rate limit', async () => {
    const db = await createMemoryDatabase();
    await seedWorld(db);
    const clock = { ms: Date.parse('2026-10-08T12:00:00.000Z') };
    const app = createApp({ db, config: loadDbConfig({}), now: () => new Date(clock.ms) });
    await withPortalEnv(() => withServer(app, async (base) => {
      const created = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Ingetrokken',
          deadline_at: '2026-10-08T14:00:00.000Z',
          lines: [{ description: 'Stoel', category: 'Office Supplies', quantity: 1 }],
          invitations: [{ supplier_id: 2, contact_email: 'ann@active.test' }]
        })
      }));
      const published = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}/publish`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_version: created.body.row_version })
      }));
      const invitationId = published.body.invitations[0].id;
      const token = tokenFromUrl(published.body.invitations[0].portal_url);
      await json(await fetch(`${base}/api/sourcing/events/${created.body.id}/invitations/${invitationId}/revoke`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Verkeerd adres' })
      }));
      for (let n = 0; n < 25; n += 1) {
        await json(await fetch(`${base}/api/portal`, { headers: bearer(token) }));
      }
      const rows = await db.prepare(`
        SELECT details FROM compliance_audit_events WHERE action = 'SOURCING_LINK_REJECTED_REVOKED'
      `).all();
      assert.equal(rows.length, 21);
      assert.equal(rows.filter((row) => String(row.details).includes('"aggregated":true')).length, 1);
    }));
  });

  test('express sets frame-ancestors none on portal.html', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-portal-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>app</title>');
    fs.writeFileSync(path.join(dir, 'portal.html'), '<!doctype html><title>portal</title>');
    const db = await createMemoryDatabase();
    const app = createApp({ db, config: loadDbConfig({}), clientDist: dir });
    await withServer(app, async (base) => {
      const response = await fetch(`${base}/portal.html`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
    });
  });
});
