import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { runOnboardCustomerCli } from './onboardCustomer.js';
import { runTursoCustomerCli } from './tursoCustomer.js';
import { runVercelCustomerCli } from './vercelCustomer.js';
import {
  customerShellGuardError,
  previewDatabaseName,
  urlNamesDatabase
} from './customerShellGuard.js';

function captureStreams() {
  const stdout = { text: '', write(chunk) { this.text += chunk; } };
  const stderr = { text: '', write(chunk) { this.text += chunk; } };
  return { stdout, stderr };
}

const SESSION = 'session-secret-do-not-print-0123456789abcdef';
const PORTAL = 'portal-secret-do-not-print-0123456789abcdef';
const TOKEN = 'beta-token-do-not-print';
const PREVIEW_TOKEN = 'preview-token-do-not-print';
const BETA_URL = 'libsql://user:super-secret-token@procureflow-beta.turso.io/db?x=another-secret';
const BETA_REGIONAL = 'libsql://procureflow-beta-org.aws-eu-west-1.turso.io/v2/pipeline?token=regional-secret';
const BETA_PREVIEW = 'libsql://procureflow-beta-preview-org.aws-eu-west-1.turso.io/db?token=preview-secret-value';
const ACME_URL = 'libsql://procureflow-acme-org.turso.io';
const ACME_PREVIEW = 'libsql://procureflow-acme-preview-org.aws-eu-west-1.turso.io';

const COMMANDS = [
  { name: 'onboard:customer', run: runOnboardCustomerCli },
  { name: 'turso:customer', run: runTursoCustomerCli },
  { name: 'vercel:customer', run: runVercelCustomerCli }
];

async function runCommand(run, argv, env) {
  let spawned = false;
  let childCalled = false;
  const { stdout, stderr } = captureStreams();
  const code = await run({
    argv,
    env,
    stdout,
    stderr,
    spawnFn() {
      spawned = true;
      throw new Error('spawned');
    },
    async runTursoFn() {
      childCalled = true;
      throw new Error('turso child should not be called');
    },
    async runVercelFn() {
      childCalled = true;
      throw new Error('vercel child should not be called');
    },
    async runProvisionFn() {
      childCalled = true;
      throw new Error('provision child should not be called');
    }
  });
  return { code, spawned, childCalled, stdout, stderr };
}

function assertNoSecrets(text, extras = []) {
  for (const secret of [
    SESSION, PORTAL, TOKEN, PREVIEW_TOKEN,
    'super-secret-token', 'another-secret', 'regional-secret', 'preview-secret-value',
    BETA_URL, BETA_REGIONAL, BETA_PREVIEW,
    ...extras
  ]) {
    assert.equal(text.includes(secret), false, `output contained a secret or URL: ${secret.slice(0, 24)}`);
  }
}

describe('customer shell guard', () => {
  test('urlNamesDatabase accepts this database and rejects another customer or its preview database', () => {
    assert.equal(previewDatabaseName('procureflow-acme'), 'procureflow-acme-preview');
    assert.equal(urlNamesDatabase('libsql://procureflow-acme.turso.io', 'procureflow-acme'), true);
    assert.equal(urlNamesDatabase(ACME_URL, 'procureflow-acme'), true);
    assert.equal(
      urlNamesDatabase('https://procureflow-acme.aws-eu-west-1.turso.io/v2/pipeline', 'procureflow-acme'),
      true
    );
    assert.equal(urlNamesDatabase(BETA_URL, 'procureflow-acme'), false);
    assert.equal(urlNamesDatabase(BETA_REGIONAL, 'procureflow-acme'), false);
    assert.equal(urlNamesDatabase(ACME_PREVIEW, 'procureflow-acme'), false);
    assert.equal(urlNamesDatabase(ACME_PREVIEW, 'procureflow-acme-preview'), true);
    assert.equal(urlNamesDatabase(BETA_PREVIEW, 'procureflow-acme-preview'), false);
  });

  test('generated secrets and Turso tokens require PROCUREFLOW_SECRET_SLUG without printing values', () => {
    const cron = 'cron-secret-do-not-print-0123456789abcdef';
    const webhook = 'webhook-secret-do-not-print-0123456789';
    const cases = [
      { SESSION_SECRET: SESSION },
      { PORTAL_TOKEN_SECRET: PORTAL },
      { CRON_SECRET: cron },
      { WEBHOOK_SIGNING_SECRET: webhook },
      { TURSO_DATABASE_URL: ACME_URL, TURSO_AUTH_TOKEN: TOKEN },
      { TURSO_PREVIEW_DATABASE_URL: ACME_PREVIEW, TURSO_PREVIEW_AUTH_TOKEN: PREVIEW_TOKEN }
    ];
    for (const env of cases) {
      const error = customerShellGuardError({ env, slug: 'acme', dbName: 'procureflow-acme' });
      assert.ok(error);
      assert.match(error.message, /PROCUREFLOW_SECRET_SLUG/);
      assert.match(error.message, /acme/);
      assert.match(error.message, /unset/);
      assertNoSecrets(error.message, [cron, webhook, ACME_URL, ACME_PREVIEW]);
      const labeled = customerShellGuardError({
        env: { ...env, PROCUREFLOW_SECRET_SLUG: 'acme' },
        slug: 'acme',
        dbName: 'procureflow-acme'
      });
      assert.equal(labeled, null);
    }

    const wrong = customerShellGuardError({
      env: { SESSION_SECRET: SESSION, PROCUREFLOW_SECRET_SLUG: 'beta' },
      slug: 'acme',
      dbName: 'procureflow-acme'
    });
    assert.match(wrong.message, /SESSION_SECRET/);
    assert.match(wrong.message, /beta/);
    assert.match(wrong.message, /not acme/);
    assertNoSecrets(wrong.message);

    const tokenOnly = customerShellGuardError({
      env: { TURSO_AUTH_TOKEN: TOKEN, PROCUREFLOW_SECRET_SLUG: 'acme' },
      slug: 'acme',
      dbName: 'procureflow-acme'
    });
    assert.match(tokenOnly.message, /TURSO_AUTH_TOKEN/);
    assert.match(tokenOnly.message, /TURSO_DATABASE_URL/);
    assert.match(tokenOnly.message, /acme/);
    assertNoSecrets(tokenOnly.message);

    const oddLabel = customerShellGuardError({
      env: { PORTAL_TOKEN_SECRET: PORTAL, PROCUREFLOW_SECRET_SLUG: PORTAL },
      slug: 'acme',
      dbName: 'procureflow-acme'
    });
    assert.match(oddLabel.message, /not a customer slug \(value not printed\)/);
    assertNoSecrets(oddLabel.message);
  });

  test('a procureflow-beta URL with --slug acme is refused before spawn on every customer command', async () => {
    const env = {
      TURSO_DATABASE_URL: BETA_URL,
      TURSO_AUTH_TOKEN: TOKEN,
      SESSION_SECRET: SESSION,
      PROCUREFLOW_SECRET_SLUG: 'acme'
    };
    for (const command of COMMANDS) {
      for (const argv of [['--slug', 'acme', '--apply'], ['--slug', 'acme']]) {
        const result = await runCommand(command.run, argv, env);
        assert.notEqual(result.code, 0, command.name);
        assert.equal(result.spawned, false, command.name);
        assert.equal(result.childCalled, false, command.name);
        assert.match(result.stderr.text, /TURSO_DATABASE_URL/);
        assert.match(result.stderr.text, /slug acme/);
        assert.match(result.stderr.text, /procureflow-beta/);
        assertNoSecrets(`${result.stdout.text}\n${result.stderr.text}`);
      }
    }
  });

  test('a procureflow-beta preview URL is refused before spawn on every customer command', async () => {
    const env = {
      TURSO_DATABASE_URL: ACME_URL,
      TURSO_AUTH_TOKEN: TOKEN,
      TURSO_PREVIEW_DATABASE_URL: BETA_PREVIEW,
      TURSO_PREVIEW_AUTH_TOKEN: PREVIEW_TOKEN,
      SESSION_SECRET: SESSION,
      PROCUREFLOW_SECRET_SLUG: 'acme'
    };
    for (const command of COMMANDS) {
      const result = await runCommand(command.run, ['--slug', 'acme', '--apply'], env);
      assert.notEqual(result.code, 0, command.name);
      assert.equal(result.spawned, false, command.name);
      assert.equal(result.childCalled, false, command.name);
      assert.match(result.stderr.text, /TURSO_PREVIEW_DATABASE_URL/);
      assert.match(result.stderr.text, /slug acme/);
      assert.match(result.stderr.text, /procureflow-beta-preview/);
      assertNoSecrets(`${result.stdout.text}\n${result.stderr.text}`);
    }
  });

  test('SESSION_SECRET or PORTAL_TOKEN_SECRET without PROCUREFLOW_SECRET_SLUG=acme exits before spawn', async () => {
    const cases = [
      { SESSION_SECRET: SESSION, key: 'SESSION_SECRET' },
      { PORTAL_TOKEN_SECRET: PORTAL, key: 'PORTAL_TOKEN_SECRET' }
    ];
    for (const secretCase of cases) {
      for (const command of COMMANDS) {
        const result = await runCommand(
          command.run,
          ['--slug', 'acme', '--apply'],
          secretCase
        );
        assert.notEqual(result.code, 0, `${command.name} ${secretCase.key}`);
        assert.equal(result.spawned, false, command.name);
        assert.equal(result.childCalled, false, command.name);
        assert.match(result.stderr.text, new RegExp(secretCase.key));
        assert.match(result.stderr.text, /PROCUREFLOW_SECRET_SLUG is unset, not acme/);
        assertNoSecrets(`${result.stdout.text}\n${result.stderr.text}`);
      }
    }
  });

  test('a labeled shell whose Turso host is this customer is not refused', async () => {
    const env = {
      TURSO_DATABASE_URL: ACME_URL,
      TURSO_AUTH_TOKEN: TOKEN,
      TURSO_PREVIEW_DATABASE_URL: ACME_PREVIEW,
      TURSO_PREVIEW_AUTH_TOKEN: PREVIEW_TOKEN,
      SESSION_SECRET: SESSION,
      PORTAL_TOKEN_SECRET: PORTAL,
      PROCUREFLOW_SECRET_SLUG: 'acme'
    };
    for (const command of COMMANDS) {
      const result = await runCommand(command.run, ['--slug', 'acme'], env);
      assert.equal(result.code, 0, `${command.name}\n${result.stderr.text}`);
      assert.equal(result.spawned, false, command.name);
      assertNoSecrets(`${result.stderr.text}`);
    }
  });
});
