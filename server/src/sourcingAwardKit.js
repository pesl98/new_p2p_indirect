/** Shared fixtures for the Sprint 8c sourcing award tests. Not a test file. */
import http from 'node:http';
import { createApp } from './app.js';
import { createMemoryDatabase } from './db.js';
import { loadDbConfig } from './dbConfig.js';
import { withCookie } from './testSession.js';

export function authHeaders(userId, extra = {}) {
  return withCookie(userId, { headers: extra }).headers;
}

export function withServer(app, fn) {
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

export async function json(response) {
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { status: response.status, body, headers: response.headers };
}

export async function withFlag(fn) {
  const prev = process.env.SOURCING_ENABLED;
  process.env.SOURCING_ENABLED = '1';
  try {
    return await fn();
  } finally {
    if (prev == null) delete process.env.SOURCING_ENABLED;
    else process.env.SOURCING_ENABLED = prev;
  }
}

export async function seedWorld(db) {
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

export async function boot() {
  const db = await createMemoryDatabase();
  await seedWorld(db);
  return { db, app: createApp({ db, config: loadDbConfig({}) }) };
}

export function watchTransactions(db) {
  const counts = [];
  let inTx = false;
  let current = 0;
  const origPrepare = db.prepare.bind(db);
  const origTransaction = db.transaction.bind(db);
  const origImmediate = db.immediateTransaction.bind(db);
  db.prepare = (sql) => {
    const stmt = origPrepare(sql);
    const count = (method) => (...args) => {
      if (inTx) current += 1;
      return stmt[method](...args);
    };
    return { run: count('run'), get: count('get'), all: count('all') };
  };
  const wrap = (factory) => (fn) => factory(async (...args) => {
    const outer = inTx;
    if (!outer) current = 0;
    inTx = true;
    try {
      return await fn(...args);
    } finally {
      inTx = outer;
      if (!outer) counts.push(current);
    }
  });
  db.transaction = wrap(origTransaction);
  db.immediateTransaction = wrap(origImmediate);
  return {
    counts,
    restore() {
      db.prepare = origPrepare;
      db.transaction = origTransaction;
      db.immediateTransaction = origImmediate;
    }
  };
}

/**
 * Insert a closed RFQ with complete quotes. Bids are written while the event
 * is still published, then the deadline is moved into the past.
 */
export async function seedClosedEvent(db, {
  number = 'RFQ-2026-100',
  lineCount = 2,
  supplierIds = [2],
  unitPrice = 1000,
  ownerId = 3,
  sourceRequisitionId = null,
  weightPrice = 100,
  weightLead = 0,
  weightQuality = 0,
  validity = null
} = {}) {
  const now = '2026-10-01T10:00:00.000Z';
  const deadline = '2026-10-08T12:00:00.000Z';
  await db.prepare(`
    INSERT INTO sourcing_events (
      event_number, title, category, department_id, owner_user_id, source_requisition_id,
      status, currency, deadline_at, weight_price, weight_lead_time, weight_quality,
      created_at, updated_at
    ) VALUES (?, 'Vergelijking', 'Office Supplies', 1, ?, ?, 'published', 'EUR', ?, ?, ?, ?, ?, ?)
  `).run(number, ownerId, sourceRequisitionId, deadline, weightPrice, weightLead, weightQuality, now, now);
  const event = await db.prepare(`SELECT * FROM sourcing_events WHERE event_number = ?`).get(number);
  for (let index = 0; index < lineCount; index += 1) {
    await db.prepare(`
      INSERT INTO sourcing_event_lines (event_id, line_no, description, category, quantity, line_type)
      VALUES (?, ?, ?, 'Office Supplies', 1, 'goods')
    `).run(event.id, index + 1, `Regel ${index + 1}`);
  }
  const lines = await db.prepare(`SELECT id, line_no FROM sourcing_event_lines WHERE event_id = ? ORDER BY line_no`).all(event.id);
  const bids = [];
  for (let index = 0; index < supplierIds.length; index += 1) {
    const supplierId = supplierIds[index];
    const price = Array.isArray(unitPrice) ? unitPrice[index] : unitPrice;
    const invite = await db.prepare(`
      INSERT INTO sourcing_invitations (event_id, supplier_id, contact_email, invited_by_user_id, created_at)
      VALUES (?, ?, ?, 3, ?)
    `).run(event.id, supplierId, `s${supplierId}@bid.test`, now);
    const invitationId = Number(invite.lastInsertRowid);
    const submitted = `2026-10-0${1 + (index % 7)}T09:00:00.000Z`;
    const bidInsert = await db.prepare(`
      INSERT INTO sourcing_bids (event_id, invitation_id, supplier_id, first_submitted_at, last_submitted_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(event.id, invitationId, supplierId, submitted, submitted);
    const bidId = Number(bidInsert.lastInsertRowid);
    const total = price * lineCount;
    await db.prepare(`
      INSERT INTO sourcing_bid_revisions (
        bid_id, revision, submission_id, total_cents, quoted_line_count, validity_until, content_sha256, submitted_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?)
    `).run(bidId, `sub-${bidId}`, total, lineCount, validity, `hash-${bidId}`, submitted);
    for (const line of lines) {
      await db.prepare(`
        INSERT INTO sourcing_bid_lines (
          bid_id, revision, event_line_id, quoted, unit_price_cents, line_total_cents, lead_time_days
        ) VALUES (?, 1, ?, 1, ?, ?, ?)
      `).run(bidId, line.id, price, price, index + 1);
    }
    bids.push({ bid_id: bidId, supplier_id: supplierId, total_cents: total });
  }
  await db.prepare(`
    UPDATE sourcing_events
    SET status = 'closed', closed_at = ?, deadline_at = ?
    WHERE id = ?
  `).run('2026-10-08T12:00:00.000Z', '2026-10-08T12:00:00.000Z', event.id);
  return { eventId: event.id, lines, bids };
}

export async function budget(db, committed = 0) {
  await db.prepare(`
    INSERT INTO budgets (department_id, fiscal_year, total_budget, committed_amount, actual_spent)
    VALUES (1, 2026, 100000000, ?, 0)
  `).run(committed);
}

export async function post(base, path, userId, body, extraHeaders = {}) {
  return json(await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { ...authHeaders(userId), 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body)
  }));
}

