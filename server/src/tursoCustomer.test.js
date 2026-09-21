import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  TURSO_CUSTOMER_HELP,
  WILL_MINT_PLACEHOLDER,
  buildJsonSummary,
  defaultDatabaseName,
  formatDryRunReport,
  looksLikeAlreadyExists,
  looksLikeMissingDatabase,
  normalizeDatabaseName,
  parseTursoCustomerArgs,
  parseTursoToken,
  parseTursoUrl,
  plannedTursoCommands,
  redactSecretTail,
  resolveCustomerIdentity,
  resolveSessionSecret,
  runTursoCustomerCli,
  slugFromDatabaseName,
  tursoCustomerCliCode,
  tursoCustomerExports
} from './tursoCustomer.js';
import { normalizeSlug } from './vercelCustomer.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function captureStreams() {
  const stdout = { text: '', write(chunk) { this.text += chunk; } };
  const stderr = { text: '', write(chunk) { this.text += chunk; } };
  return { stdout, stderr };
}

function fakeChild({
  exitCode = 0,
  stdout = '',
  stderr = '',
  errorCode
} = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() {} };
  queueMicrotask(() => {
    if (errorCode) {
      const err = new Error(`spawn error ${errorCode}`);
      err.code = errorCode;
      child.emit('error', err);
      return;
    }
    if (stdout) child.stdout.emit('data', stdout);
    if (stderr) child.stderr.emit('data', stderr);
    child.emit('close', exitCode);
  });
  return child;
}

const APPLY_URL = 'libsql://procureflow-acme-org.turso.io';
const APPLY_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.acmeTokenValueXYZ';
const MINTED_SECRET = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function applySpawn({
  whoami = { stdout: 'operator\n' },
  show = { exitCode: 1, stderr: 'Error: database not found\n' },
  create = { stdout: 'Created database procureflow-acme\n' },
  url = { stdout: `${APPLY_URL}\n` },
  token = { stdout: `${APPLY_TOKEN}\n` }
} = {}) {
  const calls = [];
  const spawnFn = (command, args) => {
    calls.push({ command, args });
    if (args[0] === 'auth' && args[1] === 'whoami') return fakeChild(whoami);
    if (args[0] === 'db' && args[1] === 'show' && args[3] === '--url') return fakeChild(url);
    if (args[0] === 'db' && args[1] === 'show') return fakeChild(show);
    if (args[0] === 'db' && args[1] === 'create') return fakeChild(create);
    if (args[0] === 'db' && args[1] === 'tokens' && args[2] === 'create') return fakeChild(token);
    throw new Error(`unexpected spawn ${args.join(' ')}`);
  };
  return { calls, spawnFn };
}

describe('turso:customer arg parsing', () => {
  test('parses slug, db, apply, dry-run, json, and equals-form flags', () => {
    const args = parseTursoCustomerArgs([
      '--slug', 'acme',
      '--db=procureflow-acme',
      '--apply',
      '--json'
    ]);
    assert.equal(args.slug, 'acme');
    assert.equal(args.db, 'procureflow-acme');
    assert.equal(args.apply, true);
    assert.equal(args.dryRun, false);
    assert.equal(args.json, true);
    assert.equal(args.help, false);

    const dry = parseTursoCustomerArgs(['--slug=beta', '--dry-run']);
    assert.equal(dry.slug, 'beta');
    assert.equal(dry.apply, false);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.dryRunFlag, true);
  });

  test('dry-run is the default when --apply is omitted', () => {
    const args = parseTursoCustomerArgs(['--slug', 'acme']);
    assert.equal(args.apply, false);
    assert.equal(args.dryRun, true);
    assert.equal(args.dryRunFlag, false);
  });

  test('unknown flags are collected; --seed and --tursodb are tracked', () => {
    const args = parseTursoCustomerArgs(['--slug', 'acme', '--wipe', '--seed', '--tursodb']);
    assert.deepEqual(args.unknown, ['--wipe']);
    assert.equal(args.seed, true);
    assert.equal(args.tursodb, true);
  });
});

describe('turso:customer identity', () => {
  test('default database name is procureflow-<slug>', () => {
    assert.equal(defaultDatabaseName('acme'), 'procureflow-acme');
    assert.equal(defaultDatabaseName('procureflow-beta'), 'procureflow-beta');
    assert.equal(normalizeDatabaseName('ProcureFlow-Acme'), 'procureflow-acme');
    assert.equal(normalizeDatabaseName('bad_name'), null);
  });

  test('slugFromDatabaseName derives slug from procureflow- prefix', () => {
    assert.equal(slugFromDatabaseName('procureflow-acme'), 'acme');
    assert.equal(slugFromDatabaseName('procureflow-acme-corp'), 'acme-corp');
    assert.equal(slugFromDatabaseName('beta'), 'beta');
    assert.equal(slugFromDatabaseName(''), null);
  });

  test('normalizeSlug refuses invalid customer slugs', () => {
    assert.equal(normalizeSlug('Acme'), 'acme');
    assert.equal(normalizeSlug('acme-corp'), 'acme-corp');
    assert.equal(normalizeSlug(''), null);
    assert.equal(normalizeSlug('-acme'), null);
    assert.equal(normalizeSlug('acme_corp'), null);
  });

  test('resolveCustomerIdentity prefers --slug and allows --db override', () => {
    assert.deepEqual(resolveCustomerIdentity({ slug: 'Acme' }), {
      error: null,
      slug: 'acme',
      dbName: 'procureflow-acme',
      projectName: 'procureflow-acme',
      baseUrl: 'https://procureflow-acme.vercel.app'
    });
    assert.equal(
      resolveCustomerIdentity({ slug: 'acme', db: 'custom-acme' }).dbName,
      'custom-acme'
    );
    assert.equal(resolveCustomerIdentity({ db: 'procureflow-beta' }).slug, 'beta');
    assert.equal(resolveCustomerIdentity({}).error, 'slug-required');
    assert.equal(resolveCustomerIdentity({ slug: 'acme_corp' }).error, 'invalid-slug');
    assert.equal(resolveCustomerIdentity({ db: 'nope_db' }).error, 'invalid-db');
  });
});

describe('turso:customer helpers', () => {
  test('planned commands never include --tursodb or destroy', () => {
    const commands = plannedTursoCommands('procureflow-acme');
    const joined = commands.map((c) => c.display).join('\n');
    assert.match(joined, /turso db create procureflow-acme/);
    assert.match(joined, /turso db show procureflow-acme --url/);
    assert.match(joined, /turso db tokens create procureflow-acme/);
    assert.equal(joined.includes('--tursodb'), false);
    assert.equal(joined.includes('destroy'), false);
    assert.deepEqual(commands.find((c) => c.kind === 'create').argv, ['db', 'create', 'procureflow-acme']);
  });

  test('parseTursoUrl and parseTursoToken read CLI stdout', () => {
    assert.equal(parseTursoUrl(`  ${APPLY_URL}  \n`), APPLY_URL);
    assert.equal(
      parseTursoUrl('Name: acme\nURL: libsql://x.turso.io\n'),
      'libsql://x.turso.io'
    );
    assert.equal(parseTursoUrl(''), null);
    assert.equal(parseTursoToken(`Created token:\n${APPLY_TOKEN}\n`), APPLY_TOKEN);
    assert.equal(parseTursoToken('no token here'), null);
  });

  test('redactSecretTail keeps last 4 chars only', () => {
    assert.equal(redactSecretTail(APPLY_TOKEN), `…${APPLY_TOKEN.slice(-4)}`);
    assert.equal(redactSecretTail(''), null);
  });

  test('looksLikeMissingDatabase / already-exists match Turso phrasing', () => {
    assert.equal(looksLikeMissingDatabase('', 'Error: database not found'), true);
    assert.equal(looksLikeMissingDatabase('', 'could not find database foo'), true);
    assert.equal(looksLikeMissingDatabase('', 'permission denied'), false);
    assert.equal(looksLikeAlreadyExists('', 'database already exists'), true);
  });

  test('resolveSessionSecret reuses env and mints when missing', () => {
    const reused = resolveSessionSecret({ SESSION_SECRET: 'already-set-secret' });
    assert.equal(reused.source, 'reuse-from-env');
    assert.equal(reused.value, 'already-set-secret');

    const minted = resolveSessionSecret({}, {
      randomBytesFn: (n) => {
        assert.equal(n, 32);
        return Buffer.alloc(32, 0xab);
      }
    });
    assert.equal(minted.source, 'minted');
    assert.equal(minted.value, 'ab'.repeat(32));
  });

  test('dry-run JSON never includes a real token', () => {
    const json = buildJsonSummary({
      mode: 'dry-run',
      slug: 'acme',
      dbName: 'procureflow-acme',
      projectName: 'procureflow-acme'
    });
    assert.equal(json.ok, true);
    assert.equal(json.mode, 'dry-run');
    assert.equal(json.tursoAuthToken, WILL_MINT_PLACEHOLDER);
    assert.equal(json.tursoDatabaseUrl, WILL_MINT_PLACEHOLDER);
    assert.equal(json.sessionSecretSource, 'will-mint-on-apply');
    assert.equal(json.tursodb, false);
    assert.equal(json.tokenKind, 'database');
    assert.ok(json.commands.some((c) => c.includes('turso db create')));
  });

  test('apply JSON redacts token and session secret to last 4 chars', () => {
    const json = buildJsonSummary({
      mode: 'apply',
      slug: 'acme',
      dbName: 'procureflow-acme',
      projectName: 'procureflow-acme',
      created: true,
      url: APPLY_URL,
      token: APPLY_TOKEN,
      sessionSecret: MINTED_SECRET,
      sessionSource: 'minted'
    });
    assert.equal(json.tursoAuthToken, `…${APPLY_TOKEN.slice(-4)}`);
    assert.equal(json.sessionSecret, `…${MINTED_SECRET.slice(-4)}`);
    assert.equal(json.tursoDatabaseUrl, APPLY_URL);
    assert.equal(json.created, true);
    assert.equal(json.reused, false);
    assert.doesNotMatch(JSON.stringify(json), new RegExp(APPLY_TOKEN));
    assert.doesNotMatch(JSON.stringify(json), new RegExp(MINTED_SECRET));
  });

  test('formatDryRunReport uses placeholders and points at vercel:customer', () => {
    const text = formatDryRunReport({
      slug: 'acme',
      dbName: 'procureflow-acme',
      projectName: 'procureflow-acme',
      env: {}
    });
    assert.match(text, /dry-run — no Turso mutation/);
    assert.match(text, /procureflow-acme/);
    assert.match(text, /never --tursodb/);
    assert.match(text, /will mint on --apply/);
    assert.match(text, /npm run vercel:customer -- --slug acme --apply/);
    assert.match(text, /provision:customer/);
    assert.doesNotMatch(text, /eyJ/);
  });
});

describe('turso:customer CLI (no live Turso)', () => {
  test('--help documents dry-run vs apply and does not spawn', async () => {
    let spawned = false;
    const { stdout, stderr } = captureStreams();
    const code = await runTursoCustomerCli({
      argv: ['--help'],
      stdout,
      stderr,
      spawnFn() {
        spawned = true;
        return fakeChild();
      }
    });
    assert.equal(code, 0);
    assert.equal(spawned, false);
    assert.equal(stdout.text, TURSO_CUSTOMER_HELP);
    assert.match(stdout.text, /--dry-run/);
    assert.match(stdout.text, /--apply/);
    assert.match(stdout.text, /--json/);
    assert.match(stdout.text, /never --tursodb|Never passes --tursodb/i);
    assert.match(stdout.text, /database token/);
  });

  test('refuses missing --slug', async () => {
    const { stderr } = captureStreams();
    const code = await runTursoCustomerCli({
      argv: [],
      stdout: captureStreams().stdout,
      stderr,
      spawnFn() { throw new Error('should not spawn'); }
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /--slug is required/);
    assert.match(stderr.text, /--apply/);
  });

  test('refuses apply without --slug', async () => {
    const { stderr } = captureStreams();
    const code = await runTursoCustomerCli({
      argv: ['--apply'],
      stdout: captureStreams().stdout,
      stderr,
      spawnFn() { throw new Error('should not spawn'); }
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /--slug is required/);
  });

  test('refuses an invalid slug', async () => {
    const { stderr } = captureStreams();
    const code = await runTursoCustomerCli({
      argv: ['--slug', 'acme_corp'],
      stdout: captureStreams().stdout,
      stderr,
      spawnFn() { throw new Error('should not spawn'); }
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /Invalid --slug/);
  });

  test('derives slug from --db procureflow-<name> on dry-run', async () => {
    const { stdout, stderr } = captureStreams();
    const code = await runTursoCustomerCli({
      argv: ['--db', 'procureflow-beta'],
      stdout,
      stderr,
      spawnFn() { throw new Error('should not spawn'); }
    });
    assert.equal(code, 0, stderr.text);
    assert.match(stdout.text, /Customer slug:  beta/);
    assert.match(stdout.text, /Database name:  procureflow-beta/);
  });

  test('refuses --apply together with --dry-run', async () => {
    const { stderr } = captureStreams();
    const code = await runTursoCustomerCli({
      argv: ['--slug', 'acme', '--apply', '--dry-run'],
      stdout: captureStreams().stdout,
      stderr,
      spawnFn() { throw new Error('should not spawn'); }
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /not both/);
  });

  test('--seed is refused', async () => {
    const { stderr } = captureStreams();
    const code = await runTursoCustomerCli({
      argv: ['--slug', 'acme', '--seed'],
      stdout: captureStreams().stdout,
      stderr,
      spawnFn() { throw new Error('should not spawn'); }
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /never seeds/);
  });

  test('--tursodb is refused', async () => {
    const { stderr } = captureStreams();
    const code = await runTursoCustomerCli({
      argv: ['--slug', 'acme', '--tursodb'],
      stdout: captureStreams().stdout,
      stderr,
      spawnFn() { throw new Error('should not spawn'); }
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /never passes --tursodb/);
  });

  test('dry-run prints planned commands and placeholders without spawning', async () => {
    let spawned = false;
    const { stdout, stderr } = captureStreams();
    const code = await runTursoCustomerCli({
      argv: ['--slug', 'acme'],
      env: {},
      stdout,
      stderr,
      spawnFn() {
        spawned = true;
        return fakeChild();
      }
    });
    assert.equal(code, 0, stderr.text);
    assert.equal(spawned, false);
    assert.match(stdout.text, /dry-run — no Turso mutation/);
    assert.match(stdout.text, /Customer slug:  acme/);
    assert.match(stdout.text, /Database name:  procureflow-acme/);
    assert.match(stdout.text, /turso db create procureflow-acme/);
    assert.match(stdout.text, /turso db show procureflow-acme --url/);
    assert.match(stdout.text, /turso db tokens create procureflow-acme/);
    assert.match(stdout.text, /never --tursodb/);
    assert.match(stdout.text, /will mint on --apply/);
    assert.match(stdout.text, /npm run turso:customer -- --slug acme --apply/);
    assert.match(stdout.text, /npm run vercel:customer -- --slug acme --apply/);
    assert.match(stdout.text, /provision:customer/);
    assert.match(stdout.text, /BASE_URL=https:\/\/procureflow-acme\.vercel\.app npm run smoke/);
    assert.doesNotMatch(stdout.text, /eyJhbGci/);
    assert.doesNotMatch(stdout.text, /libsql:\/\/procureflow-acme/);
    assert.doesNotMatch(stdout.text, /turso db destroy/);
  });

  test('dry-run --json includes the summary shape with placeholders', async () => {
    const { stdout, stderr } = captureStreams();
    const code = await runTursoCustomerCli({
      argv: ['--slug', 'acme', '--json'],
      env: {},
      stdout,
      stderr,
      spawnFn() { throw new Error('should not spawn'); }
    });
    assert.equal(code, 0, stderr.text);
    const json = JSON.parse(stdout.text.slice(stdout.text.lastIndexOf('{')));
    assert.equal(json.mode, 'dry-run');
    assert.equal(json.slug, 'acme');
    assert.equal(json.dbName, 'procureflow-acme');
    assert.equal(json.tursoAuthToken, WILL_MINT_PLACEHOLDER);
    assert.equal(json.sessionSecret, WILL_MINT_PLACEHOLDER);
  });

  test('dry-run reuses SESSION_SECRET from env without printing it', async () => {
    const secret = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
    const { stdout } = captureStreams();
    const code = await runTursoCustomerCli({
      argv: ['--slug', 'acme', '--json'],
      env: { SESSION_SECRET: secret },
      stdout,
      stderr: captureStreams().stderr,
      spawnFn() { throw new Error('should not spawn'); }
    });
    assert.equal(code, 0);
    assert.match(stdout.text, /reuse existing SESSION_SECRET/);
    assert.equal(stdout.text.includes(secret), false);
    const json = JSON.parse(stdout.text.slice(stdout.text.lastIndexOf('{')));
    assert.equal(json.sessionSecretSource, 'reuse-from-env');
    assert.equal(json.sessionSecret, 'reuse-from-env');
  });

  test('--db overrides the default name in dry-run', async () => {
    const { stdout } = captureStreams();
    const code = await runTursoCustomerCli({
      argv: ['--slug', 'acme', '--db', 'pf-acme-prod'],
      stdout,
      stderr: captureStreams().stderr,
      spawnFn() { throw new Error('should not spawn'); }
    });
    assert.equal(code, 0);
    assert.match(stdout.text, /Database name:  pf-acme-prod/);
    assert.match(stdout.text, /turso db create pf-acme-prod/);
    assert.match(stdout.text, /Customer slug:  acme/);
  });

  test('--apply fails clearly when Turso CLI is missing', async () => {
    const { stderr } = captureStreams();
    const code = await runTursoCustomerCli({
      argv: ['--slug', 'acme', '--apply'],
      env: {},
      stdout: captureStreams().stdout,
      stderr,
      spawnFn() {
        return fakeChild({ errorCode: 'ENOENT' });
      }
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /Turso CLI was not found/);
    assert.match(stderr.text, /turso auth login/);
  });

  test('--apply fails clearly when not logged in', async () => {
    const { stderr } = captureStreams();
    const code = await runTursoCustomerCli({
      argv: ['--slug', 'acme', '--apply'],
      env: {},
      stdout: captureStreams().stdout,
      stderr,
      spawnFn(_cmd, args) {
        if (args[0] === 'auth' && args[1] === 'whoami') {
          return fakeChild({ exitCode: 1, stderr: 'not logged in' });
        }
        throw new Error(`unexpected spawn ${args.join(' ')}`);
      }
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /not logged in/);
    assert.match(stderr.text, /turso auth login/);
  });

  test('--apply creates a missing DB, mints token + SESSION_SECRET, prints exports', async () => {
    const { calls, spawnFn } = applySpawn();
    const { stdout, stderr } = captureStreams();
    const code = await runTursoCustomerCli({
      argv: ['--slug', 'acme', '--apply'],
      env: {},
      stdout,
      stderr,
      spawnFn,
      randomBytesFn: (n) => {
        assert.equal(n, 32);
        return Buffer.from(MINTED_SECRET, 'hex');
      }
    });
    assert.equal(code, 0, stderr.text);
    assert.equal(calls[0].command, 'turso');
    assert.deepEqual(calls[0].args, ['auth', 'whoami']);
    const create = calls.find((c) => c.args[1] === 'create');
    assert.deepEqual(create.args, ['db', 'create', 'procureflow-acme']);
    assert.equal(create.args.includes('--tursodb'), false);
    assert.equal(calls.some((c) => c.args.includes('destroy') || c.args.includes('vercel')), false);
    assert.match(stdout.text, /Creating classic libSQL database/);
    assert.match(stdout.text, new RegExp(`export TURSO_DATABASE_URL='${APPLY_URL}'`));
    assert.match(stdout.text, new RegExp(`export TURSO_AUTH_TOKEN='${APPLY_TOKEN}'`));
    assert.match(stdout.text, new RegExp(`export SESSION_SECRET='${MINTED_SECRET}'`));
    assert.match(stdout.text, /npm run vercel:customer -- --slug acme --apply/);
    assert.match(stdout.text, /provision:customer/);
    assert.match(stdout.text, /created \(classic libSQL\)/);
  });

  test('--apply reuses an existing DB and does not create', async () => {
    const { calls, spawnFn } = applySpawn({
      show: { exitCode: 0, stdout: 'Name: procureflow-acme\n' }
    });
    const { stdout, stderr } = captureStreams();
    const code = await runTursoCustomerCli({
      argv: ['--slug', 'acme', '--apply'],
      env: { SESSION_SECRET: MINTED_SECRET },
      stdout,
      stderr,
      spawnFn
    });
    assert.equal(code, 0, stderr.text);
    assert.equal(calls.some((c) => c.args[1] === 'create'), false);
    assert.match(stdout.text, /already exists — reusing/);
    assert.match(stdout.text, /reused \(already existed\)/);
    assert.match(stdout.text, /reused from this environment/);
    assert.match(stdout.text, new RegExp(`export SESSION_SECRET='${MINTED_SECRET}'`));
  });

  test('--apply --json redacts the token but stdout still has full exports', async () => {
    const { spawnFn } = applySpawn();
    const { stdout, stderr } = captureStreams();
    const code = await runTursoCustomerCli({
      argv: ['--slug', 'acme', '--apply', '--json'],
      env: {},
      stdout,
      stderr,
      spawnFn,
      randomBytesFn: () => Buffer.from(MINTED_SECRET, 'hex')
    });
    assert.equal(code, 0, stderr.text);
    assert.match(stdout.text, new RegExp(`export TURSO_AUTH_TOKEN='${APPLY_TOKEN}'`));
    const json = JSON.parse(stdout.text.slice(stdout.text.lastIndexOf('{')));
    assert.equal(json.mode, 'apply');
    assert.equal(json.tursoAuthToken, `…${APPLY_TOKEN.slice(-4)}`);
    assert.equal(json.sessionSecret, `…${MINTED_SECRET.slice(-4)}`);
    assert.doesNotMatch(JSON.stringify(json), new RegExp(APPLY_TOKEN));
  });

  test('--apply reports create failure clearly', async () => {
    const { spawnFn } = applySpawn({
      create: { exitCode: 1, stderr: 'Error: quota exceeded\n' }
    });
    const { stderr } = captureStreams();
    const code = await runTursoCustomerCli({
      argv: ['--slug', 'acme', '--apply'],
      env: {},
      stdout: captureStreams().stdout,
      stderr,
      spawnFn
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /Failed to create Turso database/);
    assert.match(stderr.text, /never passes --tursodb/);
    assert.match(stderr.text, /quota exceeded/);
  });

  test('--apply returnResult returns minted exports; stdout still has full export lines', async () => {
    const { spawnFn } = applySpawn();
    const { stdout, stderr } = captureStreams();
    const result = await runTursoCustomerCli({
      argv: ['--slug', 'acme', '--apply'],
      env: {},
      stdout,
      stderr,
      spawnFn,
      randomBytesFn: () => Buffer.from(MINTED_SECRET, 'hex'),
      returnResult: true
    });
    assert.equal(tursoCustomerCliCode(result), 0, stderr.text);
    const minted = tursoCustomerExports(result);
    assert.equal(minted.TURSO_DATABASE_URL, APPLY_URL);
    assert.equal(minted.TURSO_AUTH_TOKEN, APPLY_TOKEN);
    assert.equal(minted.SESSION_SECRET, MINTED_SECRET);
    assert.match(stdout.text, new RegExp(`export TURSO_DATABASE_URL='${APPLY_URL}'`));
    assert.match(stdout.text, new RegExp(`export TURSO_AUTH_TOKEN='${APPLY_TOKEN}'`));
    assert.match(stdout.text, new RegExp(`export SESSION_SECRET='${MINTED_SECRET}'`));
  });

  test('without returnResult, --apply still returns a numeric exit code', async () => {
    const { spawnFn } = applySpawn();
    const code = await runTursoCustomerCli({
      argv: ['--slug', 'acme', '--apply'],
      env: { SESSION_SECRET: MINTED_SECRET },
      stdout: captureStreams().stdout,
      stderr: captureStreams().stderr,
      spawnFn
    });
    assert.equal(typeof code, 'number');
    assert.equal(code, 0);
    assert.equal(tursoCustomerExports(code), null);
  });
});

describe('npm script and docs pointer', () => {
  test('turso:customer script is wired and docs prefer it before vercel:customer', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['turso:customer'], 'node server/scripts/turso-customer.js');
    assert.ok(fs.existsSync(path.join(repoRoot, 'server/scripts/turso-customer.js')));

    const serverPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'server/package.json'), 'utf8'));
    assert.equal(serverPkg.scripts['turso:customer'], 'node scripts/turso-customer.js');

    const envExample = fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
    assert.match(envExample, /turso:customer/);

    const onboarding = fs.readFileSync(path.join(repoRoot, 'docs/CUSTOMER_ONBOARDING.md'), 'utf8');
    assert.match(onboarding, /npm run turso:customer/);
    assert.match(onboarding, /npm run vercel:customer/);
    assert.ok(
      onboarding.indexOf('npm run turso:customer') < onboarding.indexOf('npm run vercel:customer'),
      'onboarding happy path should mention turso:customer before vercel:customer'
    );

    const deployment = fs.readFileSync(path.join(repoRoot, 'docs/DEPLOYMENT.md'), 'utf8');
    assert.match(deployment, /npm run turso:customer/);

    const manual = fs.readFileSync(path.join(repoRoot, 'docs/SYSTEM_MANUAL.md'), 'utf8');
    assert.match(manual, /npm run turso:customer/);

    const checklist = fs.readFileSync(path.join(repoRoot, 'scripts/provision-customer.md'), 'utf8');
    assert.match(checklist, /npm run turso:customer/);

    const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
    assert.match(readme, /npm run turso:customer/);
  });
});
