/** Shared fixtures for the Sprint 8c award tests. Not a test file. */
import http from 'node:http';
import { createApp } from './app.js';
import { createMemoryDatabase } from './db.js';
import { loadDbConfig } from './dbConfig.js';
import { withCookie } from './testSession.js';
import { currentFiscalYear } from './fiscalYear.js';
import { completeEvaluation, declareCoi } from './sourcingEvaluationService.js';

export const CAROL = { id: 3, name: 'Carol Zhang', role: 'procurement' };
export const FRANK = { id: 6, name: 'Frank Buyer', role: 'procurement' };
export const ELENA = { id: 5, name: 'Elena Rostova', role: 'admin' };
export const DAVID = { id: 4, name: 'David Miller', role: 'finance' };
export const BOB = { id: 2, name: 'Bob Approver', role: 'approver' };
export const NOW = new Date('2026-10-20T12:00:00Z');
export const FY = currentFiscalYear();

export async function seedWorld() {
  const db = await createMemoryDatabase();
  await db.prepare(`INSERT INTO departments (id, code, name) VALUES (1, 'MKT', 'Marketing'), (2, 'FIN', 'Finance')`).run();
  await db.prepare(`
    INSERT INTO users (id, name, email, role, department_id, title, status) VALUES
      (1, 'Alice Chen', 'alice@example.com', 'requester', 1, 'Specialist', 'active'),
      (2, 'Bob Approver', 'bob@example.com', 'approver', 1, 'Head', 'active'),
      (3, 'Carol Zhang', 'carol@example.com', 'procurement', 1, 'Buyer', 'active'),
      (4, 'David Miller', 'david@example.com', 'finance', 2, 'Controller', 'active'),
      (5, 'Elena Rostova', 'elena@example.com', 'admin', 2, 'CFO', 'active'),
      (6, 'Frank Buyer', 'frank@example.com', 'procurement', 1, 'Buyer', 'active')
  `).run();
  await db.prepare(`UPDATE departments SET approver_user_id = 2 WHERE id = 1`).run();
  await db.prepare(`
    INSERT INTO suppliers (id, name, code, contact_person, email, status) VALUES
      (2, 'Alpha Supply', 'ALP', 'A', 'a@a.test', 'active'),
      (3, 'Beta Supply', 'BET', 'B', 'b@b.test', 'active'),
      (4, 'Gamma Supply', 'GAM', 'G', 'g@g.test', 'active')
  `).run();
  await db.prepare(`
    INSERT INTO budgets (department_id, fiscal_year, total_budget, committed_amount, actual_spent)
    VALUES (1, ?, 100000000, 200000, 0)
  `).run(FY);
  return db;
}

/**
 * An evaluated-ready RFQ: 2 lines (qty 10 and 5), bids from suppliers 2, 3, 4.
 * Alpha is complete and cheapest in total; Beta wins line 2; Gamma is incomplete.
 */
export async function seedEvent(db, { sourcePr = false } = {}) {
  let sourcePrId = null;
  if (sourcePr) {
    await db.prepare(`
      INSERT INTO purchase_requisitions (pr_number, requester_id, department_id, status, total_amount, justification, needed_by_date)
      VALUES ('PR-SRC-001', 1, 1, 'approved', 200000, 'source', '2026-12-01')
    `).run();
    sourcePrId = Number((await db.prepare(`SELECT id FROM purchase_requisitions WHERE pr_number = 'PR-SRC-001'`).get()).id);
  }
  await db.prepare(`
    INSERT INTO sourcing_events (event_number, kind, title, department_id, owner_user_id, source_requisition_id,
      status, currency, deadline_at, row_version, created_at, updated_at)
    VALUES ('RFQ-2026-001', 'rfq', 'Office refresh', 1, 3, ?, 'published', 'EUR', '2999-01-01T00:00:00Z', 0,
      '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')
  `).run(sourcePrId);
  const event = await db.prepare(`SELECT id FROM sourcing_events WHERE event_number = 'RFQ-2026-001'`).get();
  const eventId = Number(event.id);
  for (const [no, desc, qty] of [[1, 'Desk', 10], [2, 'Chair', 5]]) {
    await db.prepare(`
      INSERT INTO sourcing_event_lines (event_id, line_no, description, category, quantity)
      VALUES (?, ?, ?, 'Office Supplies', ?)
    `).run(eventId, no, desc, qty);
  }
  const lines = await db.prepare(`SELECT id FROM sourcing_event_lines WHERE event_id = ? ORDER BY line_no`).all(eventId);
  const bids = [
    // supplier, lead, [unit price line 1, unit price line 2 | null], validity
    [2, 5, [10000, 5000], '2999-01-01'],
    [3, 10, [11000, 4500], '2999-01-01'],
    [4, 3, [9000, null], '2999-01-01']
  ];
  const ids = {};
  for (const [supplierId, lead, prices, validity] of bids) {
    await db.prepare(`
      INSERT INTO sourcing_invitations (event_id, supplier_id, contact_email, invited_by_user_id, created_at)
      VALUES (?, ?, 'x@x.test', 3, '2026-10-01T00:00:00Z')
    `).run(eventId, supplierId);
    const inv = await db.prepare(`SELECT id FROM sourcing_invitations WHERE event_id = ? AND supplier_id = ?`).get(eventId, supplierId);
    await db.prepare(`
      INSERT INTO sourcing_bids (event_id, invitation_id, supplier_id, status, current_revision, first_submitted_at, last_submitted_at)
      VALUES (?, ?, ?, 'submitted', 1, '2026-10-05T10:00:00Z', '2026-10-05T10:00:00Z')
    `).run(eventId, inv.id, supplierId);
    const bid = await db.prepare(`SELECT id FROM sourcing_bids WHERE invitation_id = ?`).get(inv.id);
    const quantities = [10, 5];
    const total = prices.reduce((sum, price, i) => sum + (price == null ? 0 : price * quantities[i]), 0);
    await db.prepare(`
      INSERT INTO sourcing_bid_revisions (bid_id, revision, submission_id, total_cents, quoted_line_count,
        validity_until, default_lead_time_days, content_sha256, submitted_at)
      VALUES (?, 1, ?, ?, ?, ?, ?, 'h', '2026-10-05T10:00:00Z')
    `).run(bid.id, `sub-${supplierId}`, total, prices.filter((p) => p != null).length, validity, lead);
    prices.forEach((price, i) => {
      db.prepare(`
        INSERT INTO sourcing_bid_lines (bid_id, revision, event_line_id, quoted, unit_price_cents, line_total_cents, lead_time_days)
        VALUES (?, 1, ?, ?, ?, ?, NULL)
      `).run(bid.id, lines[i].id, price == null ? 0 : 1, price, price == null ? null : price * quantities[i]);
    });
    ids[supplierId] = Number(bid.id);
  }
  await db.prepare(`
    UPDATE sourcing_events SET status = 'closed', deadline_at = '2026-10-10T00:00:00Z', closed_at = '2026-10-10T00:00:00Z' WHERE id = ?
  `).run(eventId);
  return { eventId, bids: ids, lines: lines.map((l) => Number(l.id)), sourcePrId };
}

export async function evaluate(db, ctx) {
  await declareCoi(db, CAROL, ctx.eventId, { status: 'none_declared' }, { now: NOW });
  await completeEvaluation(db, CAROL, ctx.eventId, { override_reason: 'scores skipped in test' }, { now: NOW });
}


/** Serve the app on a random port with SOURCING_ENABLED=1 for the duration of fn. */
export async function withApp(db, fn, appOptions = {}) {
  const prev = process.env.SOURCING_ENABLED;
  process.env.SOURCING_ENABLED = '1';
  const app = createApp({ db, config: loadDbConfig({}), now: () => NOW, ...appOptions });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (prev == null) delete process.env.SOURCING_ENABLED; else process.env.SOURCING_ENABLED = prev;
  }
}

export function call(base, userId, method, path, body) {
  return fetch(`${base}${path}`, withCookie(userId, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null), headers: res.headers }));
}

/**
 * An evaluated-ready RFQ at the plan's caps: `lines` lines and `suppliers`
 * bids, every bid complete at 30000 cents a line (so the total is above € 10.000
 * and the chain has three steps). Supplier 2 plus new suppliers from id 10 are used.
 */
export async function seedCapsEvent(db, { lines = 50, suppliers = 20, number = 'RFQ-2026-180', sourcePr = false } = {}) {
  const supplierIds = [2];
  for (let id = 10; supplierIds.length < suppliers; id += 1) {
    await db.prepare(`INSERT INTO suppliers (id, name, code, email, status) VALUES (?, ?, ?, ?, 'active')`)
      .run(id, `Cap ${id}`, `CAP${id}`, `cap${id}@supply.test`);
    supplierIds.push(id);
  }
  let sourcePrId = null;
  if (sourcePr) {
    // An approved requisition whose commitment the award supersedes.
    await db.prepare(`
      INSERT INTO purchase_requisitions (pr_number, requester_id, department_id, status, total_amount, justification, needed_by_date)
      VALUES ('PR-SRC-CAPS', 1, 1, 'approved', ?, 'source', '2026-12-01')
    `).run(30000 * lines);
    sourcePrId = Number((await db.prepare(`SELECT id FROM purchase_requisitions WHERE pr_number = 'PR-SRC-CAPS'`).get()).id);
    await db.prepare(`UPDATE budgets SET committed_amount = committed_amount + ?`).run(30000 * lines);
  }
  await db.prepare(`
    INSERT INTO sourcing_events (event_number, kind, title, department_id, owner_user_id, source_requisition_id, status, currency,
      deadline_at, row_version, created_at, updated_at)
    VALUES (?, 'rfq', 'Caps', 1, 3, ?, 'published', 'EUR', '2999-01-01T00:00:00Z', 0, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')
  `).run(number, sourcePrId);
  const eventId = Number((await db.prepare(`SELECT id FROM sourcing_events WHERE event_number = ?`).get(number)).id);
  for (let n = 1; n <= lines; n += 1) {
    await db.prepare(`
      INSERT INTO sourcing_event_lines (event_id, line_no, description, category, quantity)
      VALUES (?, ?, ?, 'Office Supplies', 1)
    `).run(eventId, n, `Regel ${n}`);
  }
  const lineIds = (await db.prepare(`SELECT id FROM sourcing_event_lines WHERE event_id = ? ORDER BY line_no`).all(eventId)).map((r) => Number(r.id));
  const bids = [];
  for (const supplierId of supplierIds) {
    await db.prepare(`
      INSERT INTO sourcing_invitations (event_id, supplier_id, contact_email, invited_by_user_id, created_at)
      VALUES (?, ?, 'x@x.test', 3, '2026-10-01T00:00:00Z')
    `).run(eventId, supplierId);
    const inv = await db.prepare(`SELECT id FROM sourcing_invitations WHERE event_id = ? AND supplier_id = ?`).get(eventId, supplierId);
    await db.prepare(`
      INSERT INTO sourcing_bids (event_id, invitation_id, supplier_id, status, current_revision, first_submitted_at, last_submitted_at)
      VALUES (?, ?, ?, 'submitted', 1, '2026-10-05T10:00:00Z', '2026-10-05T10:00:00Z')
    `).run(eventId, inv.id, supplierId);
    const bid = await db.prepare(`SELECT id FROM sourcing_bids WHERE invitation_id = ?`).get(inv.id);
    await db.prepare(`
      INSERT INTO sourcing_bid_revisions (bid_id, revision, submission_id, total_cents, quoted_line_count,
        validity_until, default_lead_time_days, content_sha256, submitted_at)
      VALUES (?, 1, ?, ?, ?, '2999-01-01', 5, 'h', '2026-10-05T10:00:00Z')
    `).run(bid.id, `sub-${supplierId}`, 30000 * lines, lines);
    for (const lineId of lineIds) {
      await db.prepare(`
        INSERT INTO sourcing_bid_lines (bid_id, revision, event_line_id, quoted, unit_price_cents, line_total_cents)
        VALUES (?, 1, ?, 1, 30000, 30000)
      `).run(bid.id, lineId);
    }
    bids.push({ bidId: Number(bid.id), supplierId });
  }
  await db.prepare(`
    UPDATE sourcing_events SET status = 'closed', deadline_at = '2026-10-10T00:00:00Z', closed_at = '2026-10-10T00:00:00Z' WHERE id = ?
  `).run(eventId);
  return { eventId, lineIds, bids, sourcePrId };
}

/**
 * Counts what a Turso interactive transaction costs on the wire: every prepared
 * statement, one extra SELECT last_insert_rowid() per INSERT, and BEGIN + COMMIT.
 * The limit per transaction is 25 (plan §6.1).
 */
export function watchPipeline(db) {
  const results = [];
  let current = null;
  const originalPrepare = db.prepare.bind(db);
  const originals = {
    transaction: db.transaction.bind(db),
    immediateTransaction: db.immediateTransaction.bind(db)
  };
  db.prepare = (sql) => {
    const stmt = originalPrepare(sql);
    const isInsert = /^\s*INSERT/i.test(sql);
    const wrap = (method) => (...args) => {
      if (current) {
        current.prepared += 1;
        if (isInsert && method === 'run') current.inserts += 1;
      }
      return stmt[method](...args);
    };
    return { run: wrap('run'), get: wrap('get'), all: wrap('all') };
  };
  for (const name of Object.keys(originals)) {
    db[name] = (fn) => originals[name](async (...args) => {
      const outer = current;
      if (!outer) current = { prepared: 0, inserts: 0 };
      const mine = current;
      try {
        return await fn(...args);
      } finally {
        if (!outer) {
          results.push({ prepared: mine.prepared, pipeline: mine.prepared + mine.inserts + 2 });
          current = null;
        }
      }
    });
  }
  return {
    results,
    restore() {
      db.prepare = originalPrepare;
      db.transaction = originals.transaction;
      db.immediateTransaction = originals.immediateTransaction;
    }
  };
}
