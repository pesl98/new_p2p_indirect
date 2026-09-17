import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDatabase } from './db.js';
import {
  BOOTSTRAP_ORG_HELP,
  DEFAULT_BUDGET_CENTS,
  DEFAULT_FISCAL_YEAR,
  DEFAULT_ORG_DEPARTMENTS,
  parseBootstrapOrgArgs,
  runBootstrapOrgCli
} from './bootstrapOrg.js';
import {
  parseCustomerProvisionArgs,
  runCustomerProvisionCli
} from './provisionCustomer.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function tempSqlitePath(name = 'customer.db') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-bootstrap-org-'));
  return path.join(dir, name);
}

function captureStreams() {
  const stdout = { text: '', write(chunk) { this.text += chunk; } };
  const stderr = { text: '', write(chunk) { this.text += chunk; } };
  return { stdout, stderr };
}

function sqliteEnv(sqlitePath, extra = {}) {
  return {
    ...extra,
    PROCUREMENT_DB_PATH: sqlitePath,
    TURSO_DATABASE_URL: '',
    TURSO_AUTH_TOKEN: ''
  };
}

async function openSqlite(sqlitePath, { migrate = false } = {}) {
  return openDatabase({
    useTurso: false,
    sqlitePath,
    onVercel: false
  }, { migrate });
}

describe('bootstrap-org args', () => {
  test('parses fiscal year, budget cents, turso, json, force-budget', () => {
    const args = parseBootstrapOrgArgs([
      '--fiscal-year', '2026',
      '--budget-cents=10000000',
      '--turso',
      '--json',
      '--force-budget'
    ]);
    assert.equal(args.fiscalYear, '2026');
    assert.equal(args.budgetCents, '10000000');
    assert.equal(args.requireTurso, true);
    assert.equal(args.json, true);
    assert.equal(args.forceBudget, true);
    assert.equal(args.seed, false);
    assert.deepEqual(args.unknown, []);
  });

  test('unknown flags are collected; --seed is a dedicated refusal', () => {
    assert.deepEqual(parseBootstrapOrgArgs(['--wipe']).unknown, ['--wipe']);
    assert.equal(parseBootstrapOrgArgs(['--seed']).seed, true);
  });
});

describe('bootstrap-org CLI', () => {
  test('fresh DB inserts 5 departments and 5 FY 2026 budgets', async () => {
    const sqlitePath = tempSqlitePath('fresh.db');
    const { stdout, stderr } = captureStreams();
    const code = await runBootstrapOrgCli({
      argv: [],
      env: sqliteEnv(sqlitePath),
      stdout,
      stderr
    });
    assert.equal(code, 0, stderr.text);
    assert.match(stdout.text, /inserted MKT, ITE, FAC, HRP, ADM/);
    assert.match(stdout.text, /created {2}MKT, ITE, FAC, HRP, ADM/);
    assert.match(stdout.text, /users: {9}not modified/);

    const db = await openSqlite(sqlitePath);
    const depts = await db.prepare(
      `SELECT code, name, approver_user_id FROM departments ORDER BY code`
    ).all();
    assert.deepEqual(
      depts.map((d) => d.code),
      ['ADM', 'FAC', 'HRP', 'ITE', 'MKT']
    );
    assert.deepEqual(
      depts.map((d) => d.name),
      ['Finance', 'Facilities', 'HR', 'IT', 'Marketing']
    );
    assert.ok(depts.every((d) => d.approver_user_id == null));

    const budgets = await db.prepare(
      `SELECT d.code, b.fiscal_year, b.total_budget, b.committed_amount, b.actual_spent
       FROM budgets b JOIN departments d ON d.id = b.department_id
       ORDER BY d.code`
    ).all();
    assert.equal(budgets.length, 5);
    assert.ok(budgets.every((b) => Number(b.fiscal_year) === DEFAULT_FISCAL_YEAR));
    assert.ok(budgets.every((b) => Number(b.total_budget) === DEFAULT_BUDGET_CENTS));
    assert.ok(budgets.every((b) => Number(b.committed_amount) === 0));
    assert.ok(budgets.every((b) => Number(b.actual_spent) === 0));

    const users = await db.prepare(`SELECT COUNT(*) AS n FROM users`).get();
    const catalog = await db.prepare(`SELECT COUNT(*) AS n FROM catalog_items`).get();
    const suppliers = await db.prepare(`SELECT COUNT(*) AS n FROM suppliers`).get();
    const prs = await db.prepare(`SELECT COUNT(*) AS n FROM purchase_requisitions`).get();
    assert.equal(Number(users.n) || 0, 0);
    assert.equal(Number(catalog.n) || 0, 0);
    assert.equal(Number(suppliers.n) || 0, 0);
    assert.equal(Number(prs.n) || 0, 0);
    assert.equal(DEFAULT_ORG_DEPARTMENTS.length, 5);
  });

  test('second run is idempotent: no duplicate codes, exit 0', async () => {
    const sqlitePath = tempSqlitePath('again.db');
    const env = sqliteEnv(sqlitePath);
    const first = await runBootstrapOrgCli({
      argv: ['--json'],
      env,
      stdout: captureStreams().stdout,
      stderr: captureStreams().stderr
    });
    assert.equal(first, 0);

    const { stdout, stderr } = captureStreams();
    const second = await runBootstrapOrgCli({
      argv: ['--json'],
      env,
      stdout,
      stderr
    });
    assert.equal(second, 0, stderr.text);
    const summary = JSON.parse(stdout.text);
    assert.deepEqual(summary.departments.inserted, []);
    assert.deepEqual(summary.departments.skipped, ['MKT', 'ITE', 'FAC', 'HRP', 'ADM']);
    assert.deepEqual(summary.budgets.created, []);
    assert.deepEqual(summary.budgets.alreadyPresent, ['MKT', 'ITE', 'FAC', 'HRP', 'ADM']);
    assert.equal(summary.seeded, false);
    assert.equal(summary.usersTouched, false);
    assert.equal(summary.userCount, 0);

    const db = await openSqlite(sqlitePath);
    const deptCount = await db.prepare(`SELECT COUNT(*) AS n FROM departments`).get();
    const budgetCount = await db.prepare(`SELECT COUNT(*) AS n FROM budgets`).get();
    assert.equal(Number(deptCount.n), 5);
    assert.equal(Number(budgetCount.n), 5);
  });

  test('does not rename existing departments or overwrite live budgets', async () => {
    const sqlitePath = tempSqlitePath('live.db');
    const env = sqliteEnv(sqlitePath);
    await runBootstrapOrgCli({
      argv: [],
      env,
      stdout: captureStreams().stdout,
      stderr: captureStreams().stderr
    });

    const db = await openSqlite(sqlitePath);
    await db.prepare(`UPDATE departments SET name = ? WHERE code = ?`).run('Marketing & Brand', 'MKT');
    await db.prepare(
      `UPDATE budgets SET total_budget = ?, committed_amount = ?, actual_spent = ?
       WHERE department_id = (SELECT id FROM departments WHERE code = ?) AND fiscal_year = ?`
    ).run(15_000_000, 178_210, 24_350, 'MKT', 2026);
    await db.prepare(`INSERT INTO departments (code, name) VALUES (?, ?)`).run('OPS', 'Operations');

    const { stdout, stderr } = captureStreams();
    const code = await runBootstrapOrgCli({
      argv: ['--json'],
      env,
      stdout,
      stderr
    });
    assert.equal(code, 0, stderr.text);
    const summary = JSON.parse(stdout.text);
    assert.ok(summary.departments.skipped.includes('MKT'));
    assert.ok(summary.budgets.alreadyPresent.includes('MKT'));
    assert.deepEqual(summary.budgets.updated, []);

    const mkt = await db.prepare(`SELECT name FROM departments WHERE code = ?`).get('MKT');
    assert.equal(mkt.name, 'Marketing & Brand');
    const budget = await db.prepare(
      `SELECT total_budget, committed_amount, actual_spent FROM budgets
       WHERE department_id = (SELECT id FROM departments WHERE code = 'MKT') AND fiscal_year = 2026`
    ).get();
    assert.equal(Number(budget.total_budget), 15_000_000);
    assert.equal(Number(budget.committed_amount), 178_210);
    assert.equal(Number(budget.actual_spent), 24_350);
    const ops = await db.prepare(`SELECT name FROM departments WHERE code = ?`).get('OPS');
    assert.equal(ops.name, 'Operations');
    const deptCount = await db.prepare(`SELECT COUNT(*) AS n FROM departments`).get();
    assert.equal(Number(deptCount.n), 6);
  });

  test('--force-budget updates total_budget only', async () => {
    const sqlitePath = tempSqlitePath('force.db');
    const env = sqliteEnv(sqlitePath);
    await runBootstrapOrgCli({
      argv: [],
      env,
      stdout: captureStreams().stdout,
      stderr: captureStreams().stderr
    });
    const db = await openSqlite(sqlitePath);
    await db.prepare(
      `UPDATE budgets SET total_budget = ?, committed_amount = ?, actual_spent = ?`
    ).run(1, 50, 25);

    const { stdout, stderr } = captureStreams();
    const code = await runBootstrapOrgCli({
      argv: ['--force-budget', '--budget-cents', '20000000', '--json'],
      env,
      stdout,
      stderr
    });
    assert.equal(code, 0, stderr.text);
    const summary = JSON.parse(stdout.text);
    assert.deepEqual(summary.budgets.updated, ['MKT', 'ITE', 'FAC', 'HRP', 'ADM']);
    const rows = await db.prepare(
      `SELECT total_budget, committed_amount, actual_spent FROM budgets`
    ).all();
    assert.equal(rows.length, 5);
    assert.ok(rows.every((r) => Number(r.total_budget) === 20_000_000));
    assert.ok(rows.every((r) => Number(r.committed_amount) === 50));
    assert.ok(rows.every((r) => Number(r.actual_spent) === 25));
  });

  test('does not create users and --seed is refused without migrate', async () => {
    let migrated = false;
    const { stderr } = captureStreams();
    const code = await runBootstrapOrgCli({
      argv: ['--seed'],
      stdout: captureStreams().stdout,
      stderr,
      async runMigrateFn() {
        migrated = true;
        return 0;
      }
    });
    assert.equal(code, 1);
    assert.equal(migrated, false);
    assert.match(stderr.text, /never seeds/);
    assert.match(stderr.text, /npm run seed/);
  });

  test('--help prints the org-skeleton runbook', async () => {
    const { stdout } = captureStreams();
    const code = await runBootstrapOrgCli({
      argv: ['--help'],
      stdout,
      stderr: captureStreams().stderr
    });
    assert.equal(code, 0);
    assert.equal(stdout.text, BOOTSTRAP_ORG_HELP);
    assert.match(stdout.text, /never wipes/i);
    assert.match(stdout.text, /npm run seed/);
    assert.match(stdout.text, /--force-budget/);
  });

  test('invalid --fiscal-year fails closed', async () => {
    const { stderr } = captureStreams();
    const code = await runBootstrapOrgCli({
      argv: ['--fiscal-year', 'twenty'],
      stdout: captureStreams().stdout,
      stderr
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /--fiscal-year must be an integer/);
  });
});

describe('provision:customer --with-org', () => {
  test('parses --with-org and still refuses --seed', () => {
    const args = parseCustomerProvisionArgs(['--with-org', '--turso']);
    assert.equal(args.withOrg, true);
    assert.equal(args.requireTurso, true);
    const seeded = parseCustomerProvisionArgs(['--with-org', '--seed']);
    assert.equal(seeded.seed, true);
    assert.equal(seeded.withOrg, true);
  });

  test('migrate + org skeleton leaves 5 depts, 5 budgets, 0 users', async () => {
    const sqlitePath = tempSqlitePath('with-org.db');
    const { stdout, stderr } = captureStreams();
    const code = await runCustomerProvisionCli({
      argv: ['--with-org'],
      env: sqliteEnv(sqlitePath),
      stdout,
      stderr
    });
    assert.equal(code, 0, stderr.text);
    assert.match(stdout.text, /inserted MKT, ITE, FAC, HRP, ADM/);
    assert.match(stdout.text, /bootstrap-admin/);
    assert.match(stdout.text, /Department Approvers/);

    const db = await openSqlite(sqlitePath);
    const depts = await db.prepare(`SELECT COUNT(*) AS n FROM departments`).get();
    const budgets = await db.prepare(`SELECT COUNT(*) AS n FROM budgets`).get();
    const users = await db.prepare(`SELECT COUNT(*) AS n FROM users`).get();
    const catalog = await db.prepare(`SELECT COUNT(*) AS n FROM catalog_items`).get();
    assert.equal(Number(depts.n), 5);
    assert.equal(Number(budgets.n), 5);
    assert.equal(Number(users.n) || 0, 0);
    assert.equal(Number(catalog.n) || 0, 0);
  });

  test('with-org then first admin still never seeds', async () => {
    const sqlitePath = tempSqlitePath('org-admin.db');
    const { stdout, stderr } = captureStreams();
    const code = await runCustomerProvisionCli({
      argv: [
        '--with-org',
        '--email', 'admin@acme.test',
        '--password', 'choose-a-long-password',
        '--name', 'Ada Admin'
      ],
      env: sqliteEnv(sqlitePath),
      stdout,
      stderr
    });
    assert.equal(code, 0, stderr.text);
    assert.match(stdout.text, /Created first admin: Ada Admin <admin@acme.test>/);
    assert.match(stdout.text, /Org skeleton is in place/);

    const db = await openSqlite(sqlitePath);
    const users = await db.prepare(`SELECT email, role FROM users`).all();
    assert.equal(users.length, 1);
    assert.equal(users[0].email, 'admin@acme.test');
    const depts = await db.prepare(`SELECT COUNT(*) AS n FROM departments`).get();
    assert.equal(Number(depts.n), 5);
    const creds = await db.prepare(`SELECT COUNT(*) AS n FROM user_credentials`).get();
    assert.equal(Number(creds.n), 1);
    const suppliers = await db.prepare(`SELECT COUNT(*) AS n FROM suppliers`).get();
    assert.equal(Number(suppliers.n) || 0, 0);
  });

  test('--with-org --seed is refused and org is not called', async () => {
    let migrated = false;
    let orgRan = false;
    const { stderr } = captureStreams();
    const code = await runCustomerProvisionCli({
      argv: ['--with-org', '--seed'],
      stdout: captureStreams().stdout,
      stderr,
      async runMigrateFn() {
        migrated = true;
        return 0;
      },
      async runOrgFn() {
        orgRan = true;
        return 0;
      }
    });
    assert.equal(code, 1);
    assert.equal(migrated, false);
    assert.equal(orgRan, false);
    assert.match(stderr.text, /never seeds/);
  });
});

describe('scripts and docs mention bootstrap-org', () => {
  test('npm scripts and CLI entrypoint exist', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['bootstrap-org'], 'node server/scripts/bootstrap-org.js');
    assert.ok(fs.existsSync(path.join(repoRoot, 'server/scripts/bootstrap-org.js')));
    assert.ok(fs.existsSync(path.join(repoRoot, 'server/src/bootstrapOrg.js')));
    const serverPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'server/package.json'), 'utf8'));
    assert.equal(serverPkg.scripts['bootstrap-org'], 'node scripts/bootstrap-org.js');
  });
});
