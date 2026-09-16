import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDatabase } from './db.js';
import {
  parseBootstrapArgs,
  runBootstrapAdminCli
} from './bootstrapAdmin.js';
import {
  PROVISION_CUSTOMER_HELP,
  nextStepsText,
  parseCustomerProvisionArgs,
  runCustomerProvisionCli
} from './provisionCustomer.js';
import { collectDbHealth } from './provision.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function tempSqlitePath(name = 'customer.db') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-provision-customer-'));
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

describe('empty-customer provision CLI', () => {
  test('parses email/password and refuses unknown flags', () => {
    const args = parseCustomerProvisionArgs([
      '--email', 'ada@acme.test',
      '--password', 'long-password',
      '--turso'
    ]);
    assert.equal(args.email, 'ada@acme.test');
    assert.equal(args.password, 'long-password');
    assert.equal(args.requireTurso, true);
    assert.equal(args.seed, false);
    assert.deepEqual(parseCustomerProvisionArgs(['--wipe']).unknown, ['--wipe']);
  });

  test('--seed is refused and migrate is not called', async () => {
    let migrated = false;
    const { stderr } = captureStreams();
    const code = await runCustomerProvisionCli({
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

  test('migrate-only leaves zero users and prints smoke next step', async () => {
    const sqlitePath = tempSqlitePath('acme.db');
    const { stdout, stderr } = captureStreams();
    const code = await runCustomerProvisionCli({
      argv: [],
      env: sqliteEnv(sqlitePath),
      stdout,
      stderr
    });
    assert.equal(code, 0, stderr.text);
    const db = await openDatabase({
      useTurso: false,
      sqlitePath,
      onVercel: false
    }, { migrate: false });
    const health = await collectDbHealth(db, { useTurso: false, sqlitePath });
    assert.equal(health.ok, true);
    assert.equal(health.userCount, 0);
    assert.equal(health.emptyCustomer, true);
    assert.match(stdout.text, /bootstrap-admin/);
    assert.match(stdout.text, /npm run smoke/);
    assert.match(stdout.text, /Do not run npm run seed/);
  });

  test('migrate + bootstrap creates the first admin without seed data', async () => {
    const sqlitePath = tempSqlitePath('beta.db');
    const { stdout, stderr } = captureStreams();
    const code = await runCustomerProvisionCli({
      argv: [
        '--email', 'admin@beta.test',
        '--password', 'choose-a-long-password',
        '--name', 'Beta Admin'
      ],
      env: sqliteEnv(sqlitePath),
      stdout,
      stderr
    });
    assert.equal(code, 0, stderr.text);
    assert.match(stdout.text, /Created first admin: Beta Admin <admin@beta.test>/);
    assert.match(stdout.text, /BASE_URL=http:\/\/127\.0\.0\.1:5000 npm run smoke/);
    assert.doesNotMatch(stdout.text, /bootstrap-admin --/);

    const db = await openDatabase({
      useTurso: false,
      sqlitePath,
      onVercel: false
    }, { migrate: false });
    const health = await collectDbHealth(db, { useTurso: false, sqlitePath });
    assert.equal(health.userCount, 1);
    const catalog = await db.prepare('SELECT COUNT(*) AS n FROM catalog_items').get();
    assert.equal(Number(catalog.n) || 0, 0);
    const users = await db.prepare('SELECT email, role FROM users').all();
    assert.equal(users[0].email, 'admin@beta.test');
    assert.equal(users[0].role, 'admin');
  });

  test('second bootstrap on the same DB exits 2', async () => {
    const sqlitePath = tempSqlitePath('once.db');
    const env = sqliteEnv(sqlitePath);
    const first = await runCustomerProvisionCli({
      argv: ['--email', 'a@acme.test', '--password', 'choose-a-long-password'],
      env,
      stdout: captureStreams().stdout,
      stderr: captureStreams().stderr
    });
    assert.equal(first, 0);
    const { stderr } = captureStreams();
    const second = await runBootstrapAdminCli({
      argv: ['--email', 'b@acme.test', '--password', 'choose-a-long-password'],
      env,
      stdout: captureStreams().stdout,
      stderr
    });
    assert.equal(second, 2);
    assert.match(stderr.text, /already has users/);
  });

  test('--help prints the empty-customer runbook', async () => {
    const { stdout } = captureStreams();
    const code = await runCustomerProvisionCli({
      argv: ['--help'],
      stdout,
      stderr: captureStreams().stderr
    });
    assert.equal(code, 0);
    assert.equal(stdout.text, PROVISION_CUSTOMER_HELP);
    assert.match(nextStepsText(), /npm run smoke/);
  });

  test('parseBootstrapArgs accepts --email=value', () => {
    const args = parseBootstrapArgs(['--email=ada@acme.test', '--password', 'secret']);
    assert.equal(args.email, 'ada@acme.test');
    assert.equal(args.password, 'secret');
  });
});

describe('scripts and env template', () => {
  test('npm scripts, .env.example, and smoke CLI exist', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts.smoke, 'node server/scripts/smoke.js');
    assert.equal(pkg.scripts['provision:customer'], 'node server/scripts/provision-customer.js');
    assert.ok(fs.existsSync(path.join(repoRoot, 'server/scripts/smoke.js')));
    assert.ok(fs.existsSync(path.join(repoRoot, 'server/scripts/provision-customer.js')));
    const envExample = fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
    assert.match(envExample, /TURSO_DATABASE_URL/);
    assert.match(envExample, /TURSO_AUTH_TOKEN/);
    assert.match(envExample, /SESSION_SECRET/);
    assert.match(envExample, /PROCUREMENT_DB_PATH/);
    assert.match(envExample, /DEMO_PERSONA_SWITCHER/);
    assert.match(envExample, /BASE_URL/);
    assert.doesNotMatch(envExample, /libsql:\/\/.+\.(turso|io).+=/);
  });
});
