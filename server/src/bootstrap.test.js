import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import {
  BOOTSTRAP_HELP,
  BootstrapError,
  bootstrapCustomerOrg,
  loadOrgSpecFile,
  parseBootstrapArgs,
  parseOrgSpec,
  runBootstrapCli
} from './bootstrap.js';
import { createMemoryDatabase, openDatabase } from './db.js';
import { createApp } from './app.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const exampleFile = path.join(repoRoot, 'scripts/customer-org.example.json');

function tempSqlitePath(name = 'customer.db') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-bootstrap-'));
  return path.join(dir, name);
}

function sqliteEnv(sqlitePath) {
  return {
    PROCUREMENT_DB_PATH: sqlitePath,
    TURSO_DATABASE_URL: '',
    TURSO_AUTH_TOKEN: ''
  };
}

function captureStreams() {
  const stdout = { text: '', write(chunk) { this.text += chunk; } };
  const stderr = { text: '', write(chunk) { this.text += chunk; } };
  return { stdout, stderr };
}

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

const miniOrg = {
  customer: 'Acme',
  fiscal_year: 2026,
  departments: [
    {
      code: 'MKT',
      name: 'Marketing',
      approver_email: 'head@acme.test',
      total_budget_cents: 100000
    }
  ],
  users: [
    {
      name: 'Head',
      email: 'head@acme.test',
      role: 'approver',
      department_code: 'MKT',
      title: 'VP',
      approval_limit_cents: 50000
    },
    {
      name: 'Buyer',
      email: 'buyer@acme.test',
      role: 'requester',
      department_code: 'MKT',
      approval_limit_cents: 0
    }
  ]
};

describe('parseOrgSpec', () => {
  test('normalizes the committed example file', () => {
    const spec = loadOrgSpecFile(exampleFile);
    assert.equal(spec.customer, 'Example Customer');
    assert.equal(spec.fiscalYear, 2026);
    assert.equal(spec.departments.length, 3);
    assert.equal(spec.users.length, 6);
    assert.ok(spec.users.some((u) => u.role === 'admin'));
    assert.ok(spec.users.some((u) => u.role === 'requester'));
  });

  test('rejects empty departments or users', () => {
    assert.throws(() => parseOrgSpec({ departments: [], users: miniOrg.users }), BootstrapError);
    assert.throws(() => parseOrgSpec({ departments: miniOrg.departments, users: [] }), BootstrapError);
  });

  test('rejects unknown roles and missing department codes', () => {
    assert.throws(
      () => parseOrgSpec({
        ...miniOrg,
        users: [{ ...miniOrg.users[0], role: 'superuser' }]
      }),
      /role must be one of/
    );
    assert.throws(
      () => parseOrgSpec({
        ...miniOrg,
        users: [{ ...miniOrg.users[0], department_code: 'NOPE' }]
      }),
      /not in departments/
    );
  });

  test('rejects float cents and approver emails that are not in the file', () => {
    assert.throws(
      () => parseOrgSpec({
        ...miniOrg,
        departments: [{ ...miniOrg.departments[0], total_budget_cents: 10.5 }]
      }),
      /integer number of cents/
    );
    assert.throws(
      () => parseOrgSpec({
        ...miniOrg,
        departments: [{ ...miniOrg.departments[0], approver_email: 'missing@acme.test' }]
      }),
      /must match a user/
    );
  });
});

describe('bootstrapCustomerOrg (non-destructive)', () => {
  test('creates departments, users, budgets, and step-1 approver mapping', async () => {
    const db = await createMemoryDatabase();
    const summary = await bootstrapCustomerOrg(db, miniOrg);
    assert.equal(summary.created.departments, 1);
    assert.equal(summary.created.users, 2);
    assert.equal(summary.created.budgets, 1);
    assert.equal(summary.created.approverMappings, 1);
    assert.equal(summary.destructive, false);

    const users = await db.prepare(`SELECT name, email, role FROM users ORDER BY id`).all();
    assert.equal(users.length, 2);
    const dept = await db.prepare(`SELECT code, approver_user_id FROM departments`).get();
    assert.equal(dept.code, 'MKT');
    assert.ok(dept.approver_user_id);
    const budget = await db.prepare(`SELECT total_budget, fiscal_year FROM budgets`).get();
    assert.equal(budget.total_budget, 100000);
    assert.equal(budget.fiscal_year, 2026);
  });

  test('second run skips existing unique keys and does not wipe extra rows', async () => {
    const db = await createMemoryDatabase();
    await bootstrapCustomerOrg(db, miniOrg);
    await db.prepare(
      `INSERT INTO users (name, email, role, department_id, title, approval_limit)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('Extra', 'extra@acme.test', 'finance', 1, 'Controller', 0);

    const second = await bootstrapCustomerOrg(db, miniOrg);
    assert.equal(second.created.users, 0);
    assert.equal(second.skipped.users, 2);
    assert.equal(second.skipped.departments, 1);
    assert.equal(second.userCount, 3);

    const extra = await db.prepare(`SELECT email FROM users WHERE email = ?`).get('extra@acme.test');
    assert.equal(extra.email, 'extra@acme.test');
  });

  test('does not overwrite an existing department-head mapping', async () => {
    const db = await createMemoryDatabase();
    await bootstrapCustomerOrg(db, miniOrg);
    const buyer = await db.prepare(`SELECT id FROM users WHERE email = ?`).get('buyer@acme.test');
    await db.prepare(`UPDATE departments SET approver_user_id = ? WHERE code = ?`).run(buyer.id, 'MKT');

    await bootstrapCustomerOrg(db, miniOrg);
    const dept = await db.prepare(`SELECT approver_user_id FROM departments WHERE code = ?`).get('MKT');
    assert.equal(dept.approver_user_id, buyer.id);
  });
});

describe('db:bootstrap CLI', () => {
  test('parses --file and flags', () => {
    const args = parseBootstrapArgs(['--file', 'acme.json', '--json', '--turso']);
    assert.equal(args.file, 'acme.json');
    assert.equal(args.json, true);
    assert.equal(args.requireTurso, true);
  });

  test('imports the example file onto an empty SQLite customer DB', async () => {
    const sqlitePath = tempSqlitePath('acme.db');
    const { stdout, stderr } = captureStreams();
    const code = await runBootstrapCli({
      argv: ['--file', exampleFile, '--json'],
      env: sqliteEnv(sqlitePath),
      stdout,
      stderr
    });
    assert.equal(code, 0, stderr.text);
    const payload = JSON.parse(stdout.text);
    assert.equal(payload.created.users, 6);
    assert.equal(payload.created.departments, 3);
    assert.equal(payload.health.userCount, 6);
    assert.equal(payload.destructive, false);
  });

  test('refuses missing --file and partial Turso', async () => {
    const missing = captureStreams();
    const missingCode = await runBootstrapCli({
      argv: [],
      env: sqliteEnv(tempSqlitePath()),
      stdout: missing.stdout,
      stderr: missing.stderr
    });
    assert.equal(missingCode, 1);
    assert.match(missing.stderr.text, /--file is required/);

    const sqlitePath = tempSqlitePath('must-not-create.db');
    fs.rmSync(sqlitePath, { force: true });
    const partial = captureStreams();
    const partialCode = await runBootstrapCli({
      argv: ['--file', exampleFile],
      env: {
        PROCUREMENT_DB_PATH: sqlitePath,
        TURSO_DATABASE_URL: 'libsql://x.turso.io',
        TURSO_AUTH_TOKEN: ''
      },
      stdout: partial.stdout,
      stderr: partial.stderr
    });
    assert.equal(partialCode, 1);
    assert.match(partial.stderr.text, /both be set/);
    assert.equal(fs.existsSync(sqlitePath), false);
  });

  test('--help prints the GET-only caveat', async () => {
    const { stdout } = captureStreams();
    const code = await runBootstrapCli({
      argv: ['--help'],
      stdout,
      stderr: captureStreams().stderr
    });
    assert.equal(code, 0);
    assert.equal(stdout.text, BOOTSTRAP_HELP);
    assert.match(stdout.text, /GET \/api\/users/);
  });
});

describe('users/departments HTTP stays read-only; bootstrap fills GET', () => {
  test('POST /api/users is not implemented; GET lists bootstrapped people', async () => {
    const db = await createMemoryDatabase();
    await bootstrapCustomerOrg(db, miniOrg);
    const app = createApp({
      db,
      config: { onVercel: false, useTurso: false, sqlitePath: ':memory:' }
    });
    await withServer(app, async (base) => {
      const created = await fetch(`${base}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Nope', email: 'nope@x.test', role: 'admin' })
      });
      assert.equal(created.status, 404);

      const listed = await fetch(`${base}/api/users`);
      assert.equal(listed.status, 200);
      const users = await listed.json();
      assert.equal(users.length, 2);
      assert.ok(users.some((u) => u.email === 'buyer@acme.test'));

      const depts = await fetch(`${base}/api/departments`);
      const body = await depts.json();
      assert.equal(depts.status, 200);
      assert.equal(body.length, 1);
      assert.equal(body[0].code, 'MKT');
      assert.equal(body[0].approver_email, 'head@acme.test');
    });
  });
});

describe('openDatabase migrate still used by bootstrap', () => {
  test('bootstrap CLI applies schema if the file is empty', async () => {
    const sqlitePath = tempSqlitePath('empty-then-bootstrap.db');
    const dbBefore = await openDatabase({
      useTurso: false,
      sqlitePath,
      onVercel: false
    }, { migrate: false });
    const tables = await dbBefore.prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
    ).get();
    assert.equal(Number(tables.n), 0);

    const { stderr } = captureStreams();
    const code = await runBootstrapCli({
      argv: ['--file', exampleFile, '--json'],
      env: sqliteEnv(sqlitePath),
      stdout: captureStreams().stdout,
      stderr
    });
    assert.equal(code, 0, stderr.text);
  });
});
