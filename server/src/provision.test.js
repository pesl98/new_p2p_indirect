import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';
import {
  EXPECTED_TABLES,
  MIGRATE_HELP,
  PARTIAL_TURSO_MSG,
  TursoConfigError,
  assertCustomerDbConfig,
  collectDbHealth,
  defaultSeedScriptPath,
  formatDbHealth,
  parseProvisionArgs,
  redactTursoUrl,
  runProvisionCli,
  runSeedProcess,
  tursoCredentialState
} from './provision.js';
import { openDatabase } from './db.js';
import { schemaPath } from './dbConfig.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function tempSqlitePath(name = 'customer.db') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-provision-'));
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

describe('customer provision config (fail-closed Turso)', () => {
  test('absent Turso credentials select local SQLite', () => {
    assert.equal(tursoCredentialState({}), 'absent');
    const config = assertCustomerDbConfig({});
    assert.equal(config.useTurso, false);
  });

  test('complete Turso pair is accepted', () => {
    const env = {
      TURSO_DATABASE_URL: 'libsql://customer-a.turso.io',
      TURSO_AUTH_TOKEN: 'tok_test'
    };
    assert.equal(tursoCredentialState(env), 'complete');
    const config = assertCustomerDbConfig(env);
    assert.equal(config.useTurso, true);
  });

  test('URL without token is refused (no silent SQLite)', () => {
    assert.equal(tursoCredentialState({ TURSO_DATABASE_URL: 'libsql://x.turso.io' }), 'partial');
    assert.throws(
      () => assertCustomerDbConfig({ TURSO_DATABASE_URL: 'libsql://x.turso.io' }),
      (err) => err instanceof TursoConfigError && err.message === PARTIAL_TURSO_MSG
    );
  });

  test('token without URL is refused', () => {
    assert.throws(
      () => assertCustomerDbConfig({ TURSO_AUTH_TOKEN: 'tok_only' }),
      (err) => err instanceof TursoConfigError && /both be set/.test(err.message)
    );
  });

  test('--turso / requireTurso fails when credentials are absent', () => {
    assert.throws(
      () => assertCustomerDbConfig({}, { requireTurso: true }),
      (err) => err instanceof TursoConfigError && /TURSO_DATABASE_URL/.test(err.message)
    );
  });

  test('whitespace-only Turso env counts as absent, not partial', () => {
    assert.equal(tursoCredentialState({
      TURSO_DATABASE_URL: '  ',
      TURSO_AUTH_TOKEN: '\t'
    }), 'absent');
  });
});

describe('provision CLI args', () => {
  test('parses seed, turso, json, help', () => {
    const args = parseProvisionArgs(['--seed', '--turso', '--json']);
    assert.equal(args.seed, true);
    assert.equal(args.requireTurso, true);
    assert.equal(args.json, true);
    assert.equal(args.help, false);
    assert.deepEqual(args.unknown, []);
  });

  test('--require-turso is an alias of --turso', () => {
    assert.equal(parseProvisionArgs(['--require-turso']).requireTurso, true);
  });

  test('unknown flags are collected', () => {
    const args = parseProvisionArgs(['--seed', '--wipe']);
    assert.deepEqual(args.unknown, ['--wipe']);
  });
});

describe('redactTursoUrl', () => {
  test('keeps host, drops query (never prints tokens)', () => {
    assert.equal(
      redactTursoUrl('libsql://acme.turso.io?authToken=secret'),
      'libsql://acme.turso.io'
    );
  });

  test('https URLs keep https scheme', () => {
    assert.equal(
      redactTursoUrl('https://acme.turso.io/'),
      'https://acme.turso.io'
    );
  });

  test('empty is null', () => {
    assert.equal(redactTursoUrl(''), null);
  });
});

describe('db:migrate / db:status against isolated SQLite files', () => {
  test('migrate on empty file applies schema and does not seed users', async () => {
    const sqlitePath = tempSqlitePath('acme.db');
    const { stdout, stderr } = captureStreams();
    const code = await runProvisionCli({
      command: 'migrate',
      argv: ['--json'],
      env: sqliteEnv(sqlitePath),
      stdout,
      stderr
    });
    assert.equal(code, 0, stderr.text);
    const health = JSON.parse(stdout.text);
    assert.equal(health.ok, true);
    assert.equal(health.mode, 'sqlite');
    assert.equal(health.tableCount, EXPECTED_TABLES.length);
    assert.equal(health.userCount, 0);
    assert.equal(health.emptyCustomer, true);
    assert.equal(health.seededDemoLikely, false);
    assert.ok(fs.existsSync(sqlitePath));
  });

  test('status on an unmigrated file reports empty and does not create tables', async () => {
    const sqlitePath = tempSqlitePath('empty.db');
    const { stdout, stderr } = captureStreams();
    const code = await runProvisionCli({
      command: 'status',
      argv: ['--json'],
      env: sqliteEnv(sqlitePath),
      stdout,
      stderr
    });
    assert.equal(code, 0, stderr.text);
    const health = JSON.parse(stdout.text);
    assert.equal(health.ok, false);
    assert.equal(health.health, 'empty');
    assert.equal(health.tableCount, 0);
    assert.equal(health.userCount, 0);
  });

  test('customer A and customer B SQLite files do not share rows', async () => {
    const pathA = tempSqlitePath('customer-a.db');
    const pathB = path.join(path.dirname(pathA), 'customer-b.db');

    const migrateA = await runProvisionCli({
      command: 'migrate',
      argv: ['--json'],
      env: sqliteEnv(pathA),
      stdout: captureStreams().stdout,
      stderr: captureStreams().stderr
    });
    const migrateB = await runProvisionCli({
      command: 'migrate',
      argv: ['--json'],
      env: sqliteEnv(pathB),
      stdout: captureStreams().stdout,
      stderr: captureStreams().stderr
    });
    assert.equal(migrateA, 0);
    assert.equal(migrateB, 0);

    const dbA = await openDatabase({
      useTurso: false,
      sqlitePath: pathA,
      onVercel: false
    });
    await dbA.prepare(
      `INSERT INTO departments (id, code, name) VALUES (?, ?, ?)`
    ).run(1, 'ACM', 'Acme Marketing');
    await dbA.prepare(
      `INSERT INTO users (name, email, role, department_id, title, approval_limit)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('Acme Admin', 'admin@acme.test', 'admin', 1, 'Controller', 0);

    const healthA = await collectDbHealth(dbA, { useTurso: false, sqlitePath: pathA });
    const dbB = await openDatabase({
      useTurso: false,
      sqlitePath: pathB,
      onVercel: false
    }, { migrate: false });
    const healthB = await collectDbHealth(dbB, { useTurso: false, sqlitePath: pathB });

    assert.equal(healthA.userCount, 1);
    assert.equal(healthB.userCount, 0);
    assert.equal(healthB.tableCount, EXPECTED_TABLES.length);
    assert.notEqual(pathA, pathB);
  });

  test('--seed calls the seed runner and records seedRan (does not insert unless seedFn does)', async () => {
    const sqlitePath = tempSqlitePath('seeded.db');
    let seedEnv = null;
    const { stdout, stderr } = captureStreams();
    const code = await runProvisionCli({
      command: 'migrate',
      argv: ['--json', '--seed'],
      env: sqliteEnv(sqlitePath),
      stdout,
      stderr,
      async runSeedFn(env) {
        seedEnv = env;
        const db = await openDatabase({
          useTurso: false,
          sqlitePath: env.PROCUREMENT_DB_PATH,
          onVercel: false
        });
        await db.prepare(`INSERT INTO departments (code, name) VALUES (?, ?)`).run('DMO', 'Demo');
        await db.prepare(
          `INSERT INTO users (name, email, role, department_id, title, approval_limit)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run('Demo User', 'demo@example.test', 'requester', 1, 'Buyer', 0);
      }
    });
    assert.equal(code, 0, stderr.text);
    assert.equal(seedEnv.PROCUREMENT_DB_PATH, sqlitePath);
    const health = JSON.parse(stdout.text);
    assert.equal(health.seedRan, true);
    assert.equal(health.userCount, 1);
    assert.equal(health.emptyCustomer, false);
  });

  test('status --seed is refused', async () => {
    const { stderr } = captureStreams();
    const code = await runProvisionCli({
      command: 'status',
      argv: ['--seed'],
      env: sqliteEnv(tempSqlitePath()),
      stdout: captureStreams().stdout,
      stderr
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /does not accept --seed/);
  });

  test('unknown args fail closed', async () => {
    const { stderr } = captureStreams();
    const code = await runProvisionCli({
      command: 'migrate',
      argv: ['--nope'],
      env: sqliteEnv(tempSqlitePath()),
      stdout: captureStreams().stdout,
      stderr
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /Unknown argument: --nope/);
  });

  test('partial Turso env fails before opening a SQLite file', async () => {
    const sqlitePath = tempSqlitePath('must-not-create.db');
    fs.rmSync(sqlitePath, { force: true });
    const { stderr } = captureStreams();
    const code = await runProvisionCli({
      command: 'migrate',
      argv: [],
      env: {
        PROCUREMENT_DB_PATH: sqlitePath,
        TURSO_DATABASE_URL: 'libsql://should-fail.turso.io',
        TURSO_AUTH_TOKEN: ''
      },
      stdout: captureStreams().stdout,
      stderr
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /both be set/);
    assert.equal(fs.existsSync(sqlitePath), false);
  });

  test('--help prints the runbook pointer', async () => {
    const { stdout } = captureStreams();
    const code = await runProvisionCli({
      command: 'migrate',
      argv: ['--help'],
      stdout,
      stderr: captureStreams().stderr
    });
    assert.equal(code, 0);
    assert.match(stdout.text, /docs\/CUSTOMER_ONBOARDING.md/);
    assert.match(stdout.text, /docs\/DEPLOYMENT.md/);
    assert.equal(stdout.text, MIGRATE_HELP);
  });

  test('human status text never includes auth tokens', () => {
    const text = formatDbHealth({
      ok: true,
      health: 'ok',
      mode: 'turso-http',
      tursoUrl: 'libsql://acme.turso.io',
      sqlitePath: null,
      tableCount: EXPECTED_TABLES.length,
      expectedTableCount: EXPECTED_TABLES.length,
      userCount: 0,
      emptyCustomer: true,
      seededDemoLikely: false,
      missingTables: []
    }, 'status');
    assert.match(text, /libsql:\/\/acme\.turso\.io/);
    assert.doesNotMatch(text, /token/i);
    assert.match(text, /database-per-customer/);
  });
});

describe('seed process helper', () => {
  test('default seed script is server/src/seed.js', () => {
    assert.equal(
      path.basename(defaultSeedScriptPath()),
      'seed.js'
    );
    assert.ok(fs.existsSync(defaultSeedScriptPath()));
  });

  test('runSeedProcess resolves when the child exits 0', async () => {
    const fake = new EventEmitter();
    const done = runSeedProcess({ PROCUREMENT_DB_PATH: ':memory:' }, {
      spawnFn: () => {
        queueMicrotask(() => fake.emit('exit', 0));
        return fake;
      }
    });
    await done;
  });

  test('runSeedProcess rejects on non-zero exit', async () => {
    const fake = new EventEmitter();
    const done = runSeedProcess({}, {
      spawnFn: () => {
        queueMicrotask(() => fake.emit('exit', 2));
        return fake;
      }
    });
    await assert.rejects(done, /exited with code 2/);
  });
});

describe('schema and docs stay aligned with provision', () => {
  test('EXPECTED_TABLES matches CREATE TABLE statements in schema.sql', () => {
    const schema = fs.readFileSync(schemaPath, 'utf8');
    const created = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]).sort();
    assert.deepEqual(created, [...EXPECTED_TABLES].sort());
  });

  test('README points operators at CUSTOMER_ONBOARDING.md first; ARCHITECTURE keeps DEPLOYMENT.md', () => {
    const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
    const architecture = fs.readFileSync(path.join(repoRoot, 'docs/ARCHITECTURE.md'), 'utf8');
    const deployment = fs.readFileSync(path.join(repoRoot, 'docs/DEPLOYMENT.md'), 'utf8');
    const onboarding = fs.readFileSync(path.join(repoRoot, 'docs/CUSTOMER_ONBOARDING.md'), 'utf8');
    const onboardIdx = readme.indexOf('docs/CUSTOMER_ONBOARDING.md');
    const deployIdx = readme.indexOf('docs/DEPLOYMENT.md');
    assert.ok(onboardIdx !== -1, 'README must link CUSTOMER_ONBOARDING.md');
    assert.ok(deployIdx !== -1, 'README must still link DEPLOYMENT.md');
    assert.ok(onboardIdx < deployIdx, 'README must point at CUSTOMER_ONBOARDING.md before DEPLOYMENT.md');
    assert.match(readme, /Onboard a new customer/);
    assert.match(architecture, /Customer isolation = DB per tenant/);
    assert.match(architecture, /docs\/DEPLOYMENT\.md/);
    assert.match(architecture, /CUSTOMER_ONBOARDING\.md/);
    assert.match(deployment, /CUSTOMER_ONBOARDING\.md/);
    assert.match(deployment, /npm run db:migrate/);
    assert.match(deployment, /npm run db:status/);
    assert.match(deployment, /npm run smoke/);
    assert.match(deployment, /one project/);
    assert.match(deployment, /persona/i);
    assert.match(deployment, /no.*shared-row `org_id`/i);
    assert.match(deployment, /SESSION_SECRET/);
    assert.match(deployment, /bootstrap-admin/);
    assert.match(deployment, /bootstrap-org/);
    assert.match(deployment, /--with-org/);
    assert.match(deployment, /turso:customer/);
    assert.match(deployment, /vercel:customer/);
    assert.match(deployment, /--apply/);
    assert.match(deployment, /Redeploy/);
    assert.match(onboarding, /turso db create procureflow-/);
    assert.match(onboarding, /--tursodb/);
    assert.match(onboarding, /database token/);
    assert.match(onboarding, /org JWT/i);
    assert.match(onboarding, /Production and Preview/);
    assert.match(onboarding, /DEMO_PERSONA_SWITCHER/);
    assert.match(onboarding, /npm run db:migrate/);
    assert.match(onboarding, /bootstrap-admin/);
    assert.match(onboarding, /bootstrap-org/);
    assert.match(onboarding, /provision:customer/);
    assert.match(onboarding, /--with-org/);
    assert.match(onboarding, /turso:customer/);
    assert.match(onboarding, /vercel:customer/);
    assert.match(onboarding, /--apply/);
    assert.match(onboarding, /Do not seed/);
    assert.match(onboarding, /npm run smoke/);
    assert.match(onboarding, /SESSION_SECRET/);
    assert.match(onboarding, /second Turso DB/i);
    assert.match(onboarding, /legacy seed/i);
    assert.doesNotMatch(onboarding, /turso db shell/);
    assert.match(readme, /bootstrap-admin/);
    assert.match(readme, /bootstrap-org/);
    assert.match(readme, /npm run smoke/);
    assert.match(readme, /\.env\.example/);
    assert.match(readme, /docs\/DEPLOY_MANUAL\.md/);
    const manual = fs.readFileSync(path.join(repoRoot, 'docs/SYSTEM_MANUAL.md'), 'utf8');
    assert.match(manual, /DEPLOY_MANUAL\.md/);
    const deployManual = fs.readFileSync(path.join(repoRoot, 'docs/DEPLOY_MANUAL.md'), 'utf8');
    assert.match(deployManual, /npm run onboard:customer/);
    assert.match(deployManual, /npm run offboard:customer -- --slug acme --apply --confirm-slug acme/);
    assert.match(deployManual, /VERCEL_READY_TIMEOUT_MS/);
    assert.match(deployManual, /turso db create procureflow-/);
    assert.match(deployment, /DEPLOY_MANUAL\.md/);
    assert.match(onboarding, /DEPLOY_MANUAL\.md/);
  });

  test('CLI entrypoints and npm scripts exist', () => {
    assert.ok(fs.existsSync(path.join(repoRoot, 'server/scripts/db-migrate.js')));
    assert.ok(fs.existsSync(path.join(repoRoot, 'server/scripts/db-status.js')));
    assert.ok(fs.existsSync(path.join(repoRoot, 'server/scripts/bootstrap-org.js')));
    assert.ok(fs.existsSync(path.join(repoRoot, 'scripts/provision-customer.md')));
    assert.ok(fs.existsSync(path.join(repoRoot, 'docs/CUSTOMER_ONBOARDING.md')));
    assert.ok(fs.existsSync(path.join(repoRoot, 'server/scripts/turso-customer.js')));
    assert.ok(fs.existsSync(path.join(repoRoot, 'server/scripts/vercel-customer.js')));
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['db:migrate'], 'node server/scripts/db-migrate.js');
    assert.equal(pkg.scripts['db:status'], 'node server/scripts/db-status.js');
    assert.equal(pkg.scripts['bootstrap-admin'], 'node server/src/bootstrapAdmin.js');
    assert.equal(pkg.scripts['bootstrap-org'], 'node server/scripts/bootstrap-org.js');
    assert.equal(pkg.scripts.smoke, 'node server/scripts/smoke.js');
    assert.equal(pkg.scripts['provision:customer'], 'node server/scripts/provision-customer.js');
    assert.equal(pkg.scripts['turso:customer'], 'node server/scripts/turso-customer.js');
    assert.equal(pkg.scripts['vercel:customer'], 'node server/scripts/vercel-customer.js');
    assert.equal(pkg.scripts['onboard:customer'], 'node server/scripts/onboard-customer.js');
    assert.ok(fs.existsSync(path.join(repoRoot, 'server/scripts/onboard-customer.js')));
  });
});
