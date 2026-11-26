import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { fileURLToPath } from 'node:url';
import {
  DEMO_PERSONA_SWITCHER_KEY,
  VERCEL_ENV_TARGETS
} from './vercelCustomer.js';
import { looksLikeMissingDatabase } from './tursoCustomer.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
import {
  OFFBOARD_CUSTOMER_HELP,
  OFFBOARD_ENV_KEYS_BY_TARGET,
  confirmSlugMatches,
  envRmArgv,
  formatDryRunReport,
  looksLikeEnvAlreadyAbsent,
  looksLikeVercelProjectAbsent,
  parseOffboardCustomerArgs,
  plannedEnvRemovals,
  plannedOffboardCommands,
  resolveOffboardDumpPath,
  resolveOffboardIdentity,
  runOffboardCustomerCli,
  tursoDestroyArgv,
  tursoDumpArgv
} from './offboardCustomer.js';

const PRODUCTION_OFFBOARD_KEYS = [
  'TURSO_DATABASE_URL',
  'TURSO_AUTH_TOKEN',
  'SESSION_SECRET',
  'PORTAL_TOKEN_SECRET',
  'CRON_SECRET',
  'WEBHOOK_SIGNING_SECRET',
  'PROCUREFLOW_TENANT'
];

const PREVIEW_OFFBOARD_KEYS = [
  'TURSO_PREVIEW_DATABASE_URL',
  'TURSO_PREVIEW_AUTH_TOKEN',
  'SESSION_SECRET',
  'PORTAL_TOKEN_SECRET',
  'CRON_SECRET',
  'WEBHOOK_SIGNING_SECRET',
  'PROCUREFLOW_TENANT'
];

const DUMP_SENTINEL = 'PF_DUMP_SENTINEL_do_not_echo CREATE TABLE offboard_dump_sentinel (id);';

function captureStreams() {
  const stdout = { text: '', write(chunk) { this.text += chunk; } };
  const stderr = { text: '', write(chunk) { this.text += chunk; } };
  return { stdout, stderr };
}

function fakeChild({
  exitCode = 0,
  stdout = '',
  stderr = '',
  errorCode,
  onStdin
} = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    end(data) {
      if (onStdin && data != null) onStdin(data);
    }
  };
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

function linkedProjectFs(name = 'procureflow-acme') {
  return {
    existsSync(file) {
      return String(file).endsWith(`${path.sep}.vercel${path.sep}project.json`);
    },
    readFileSync(file) {
      if (!String(file).endsWith(`${path.sep}.vercel${path.sep}project.json`)) {
        throw new Error(`unexpected read ${file}`);
      }
      return JSON.stringify({
        projectId: 'prj_test',
        orgId: 'team_test',
        projectName: name
      });
    }
  };
}

function unlinkedFs() {
  return {
    existsSync() { return false; },
    readFileSync() { throw new Error('should not read'); }
  };
}

function expectedEnvCalls(project = 'procureflow-acme') {
  const calls = [];
  for (const target of VERCEL_ENV_TARGETS) {
    for (const key of OFFBOARD_ENV_KEYS_BY_TARGET[target]) {
      calls.push(['vercel', 'env', 'rm', key, target, '--yes', '--project', project]);
    }
  }
  return calls;
}

function makeDumpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pf-offboard-'));
}

function removeDumpDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function argvHasInvalidate(calls) {
  return calls.some((args) => args.includes('invalidate') || args.includes('tokens'));
}

const SECRET_ENV = {
  TURSO_DATABASE_URL: 'libsql://procureflow-acme.turso.io',
  TURSO_AUTH_TOKEN: 'tok_test_secret_value',
  SESSION_SECRET: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
};

describe('offboard:customer arg parsing', () => {
  test('parses slug, db, project, apply, and confirm-slug', () => {
    const args = parseOffboardCustomerArgs([
      '--slug', 'Acme',
      '--db=procureflow-acme',
      '--project=procureflow-acme',
      '--apply',
      '--confirm-slug', 'acme'
    ]);
    assert.equal(args.slug, 'Acme');
    assert.equal(args.db, 'procureflow-acme');
    assert.equal(args.project, 'procureflow-acme');
    assert.equal(args.apply, true);
    assert.equal(args.dryRun, false);
    assert.equal(args.confirmSlug, 'acme');
    assert.equal(args.seed, false);
    assert.equal(args.dumpDir, null);
  });

  test('parses --dump-dir and does not treat it as unknown', () => {
    const args = parseOffboardCustomerArgs([
      '--slug', 'acme',
      '--dump-dir', '/var/tmp/procureflow-dumps'
    ]);
    assert.equal(args.dumpDir, '/var/tmp/procureflow-dumps');
    assert.equal(args.dryRun, true);
    assert.deepEqual(args.unknown, []);
    const eq = parseOffboardCustomerArgs(['--dump-dir=/var/tmp/procureflow-dumps']);
    assert.equal(eq.dumpDir, '/var/tmp/procureflow-dumps');
  });

  test('dry-run is the default; --seed is tracked', () => {
    const dry = parseOffboardCustomerArgs(['--slug', 'acme']);
    assert.equal(dry.apply, false);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.dryRunFlag, false);
    const seeded = parseOffboardCustomerArgs(['--slug', 'acme', '--seed', '--wipe']);
    assert.equal(seeded.seed, true);
    assert.deepEqual(seeded.unknown, ['--wipe']);
  });

  test('confirmSlugMatches is an exact match to the normalized slug', () => {
    assert.equal(confirmSlugMatches('acme', 'acme'), true);
    assert.equal(confirmSlugMatches('acme', 'Acme'), false);
    assert.equal(confirmSlugMatches('acme', 'acme '), true);
    assert.equal(confirmSlugMatches('acme', ''), false);
    assert.equal(confirmSlugMatches('acme', null), false);
  });

  test('resolveOffboardIdentity normalizes slug and defaults both names', () => {
    const identity = resolveOffboardIdentity({ slug: 'Acme' });
    assert.equal(identity.error, null);
    assert.equal(identity.slug, 'acme');
    assert.equal(identity.dbName, 'procureflow-acme');
    assert.equal(identity.projectName, 'procureflow-acme');
    const overridden = resolveOffboardIdentity({
      slug: 'acme',
      db: 'procureflow-acme-archive',
      project: 'pf-acme-prod'
    });
    assert.equal(overridden.dbName, 'procureflow-acme-archive');
    assert.equal(overridden.projectName, 'pf-acme-prod');
  });
});

describe('offboard:customer plan', () => {
  test('env remove is the §3.1 list per target, then dump, then destroy', () => {
    assert.deepEqual(OFFBOARD_ENV_KEYS_BY_TARGET.production, PRODUCTION_OFFBOARD_KEYS);
    assert.deepEqual(OFFBOARD_ENV_KEYS_BY_TARGET.preview, PREVIEW_OFFBOARD_KEYS);
    const plan = plannedOffboardCommands('procureflow-acme', 'procureflow-acme');
    assert.deepEqual(plan.whoami.argv, ['whoami']);
    assert.deepEqual(plan.tursoWhoami.argv, ['auth', 'whoami']);
    assert.equal(plan.envRemovals.length, 14);
    assert.deepEqual(
      plan.envRemovals.map((cmd) => [cmd.key, cmd.target]),
      VERCEL_ENV_TARGETS.flatMap((target) => (
        OFFBOARD_ENV_KEYS_BY_TARGET[target].map((key) => [key, target])
      ))
    );
    const productionKeys = plan.envRemovals.filter((cmd) => cmd.target === 'production').map((cmd) => cmd.key);
    const previewKeys = plan.envRemovals.filter((cmd) => cmd.target === 'preview').map((cmd) => cmd.key);
    assert.deepEqual(productionKeys, PRODUCTION_OFFBOARD_KEYS);
    assert.deepEqual(previewKeys, PREVIEW_OFFBOARD_KEYS);
    assert.equal(productionKeys.includes('TURSO_PREVIEW_DATABASE_URL'), false);
    assert.equal(productionKeys.includes('TURSO_PREVIEW_AUTH_TOKEN'), false);
    assert.equal(previewKeys.includes('TURSO_DATABASE_URL'), false);
    assert.equal(previewKeys.includes('TURSO_AUTH_TOKEN'), false);
    assert.deepEqual(envRmArgv('TURSO_PREVIEW_AUTH_TOKEN', 'preview', 'procureflow-acme'), [
      'env', 'rm', 'TURSO_PREVIEW_AUTH_TOKEN', 'preview', '--yes', '--project', 'procureflow-acme'
    ]);
    assert.deepEqual(tursoDumpArgv('procureflow-acme'), [
      'db', 'shell', 'procureflow-acme', '.dump'
    ]);
    assert.deepEqual(tursoDestroyArgv('procureflow-acme'), [
      'db', 'destroy', 'procureflow-acme', '--yes'
    ]);
    const argvs = [
      plan.whoami.argv,
      plan.tursoWhoami.argv,
      plan.dump.argv,
      plan.destroy.argv,
      ...plan.envRemovals.map((cmd) => cmd.argv)
    ];
    for (const argv of argvs) {
      assert.equal(argv.includes('invalidate'), false);
      assert.equal(argv.includes('tokens'), false);
    }
    assert.equal(plan.destroy.argv.includes('procureflow-acme-preview'), false);
    const joined = plannedEnvRemovals('procureflow-acme').map((cmd) => cmd.display).join('\n');
    assert.doesNotMatch(joined, new RegExp(DEMO_PERSONA_SWITCHER_KEY));
    assert.doesNotMatch(joined, /seed/);
    assert.doesNotMatch(joined, /tokens invalidate/);
  });

  test('the default dump path is under the home tmp dir and outside the work tree', () => {
    const outside = resolveOffboardDumpPath({
      slug: 'acme',
      homedir: os.homedir(),
      now: new Date('2026-11-26T07:27:00.000Z')
    });
    assert.equal(outside.refused, false);
    assert.equal(outside.fileName, 'acme-20261126T072700Z.sql');
    assert.equal(outside.dir, path.join(os.homedir(), 'tmp'));
    const inside = resolveOffboardDumpPath({
      slug: 'acme',
      dumpDir: repoRoot,
      cwd: os.tmpdir(),
      now: new Date('2026-11-26T07:27:00.000Z')
    });
    assert.equal(inside.refused, true);
    assert.equal(inside.reason, 'inside-work-tree');
  });

  test('classifies absent env separately from a missing Vercel project', () => {
    assert.equal(looksLikeEnvAlreadyAbsent('', 'Environment Variable was not found.\n'), true);
    assert.equal(
      looksLikeEnvAlreadyAbsent('', 'Environment Variable TURSO_DATABASE_URL was not found.'),
      true
    );
    assert.equal(
      looksLikeVercelProjectAbsent('', 'Project "procureflow-acme" was not found in the current scope.\n'),
      true
    );
    assert.equal(
      looksLikeEnvAlreadyAbsent('', 'Project "procureflow-acme" was not found in the current scope.'),
      false
    );
    assert.equal(looksLikeMissingDatabase('', 'could not find database with name procureflow-acme: record not found'), true);
  });
});

describe('offboard:customer CLI (no live Turso/Vercel)', () => {
  test('--help documents confirm-slug and the runbook, and does not spawn', async () => {
    let spawned = false;
    const { stdout, stderr } = captureStreams();
    const code = await runOffboardCustomerCli({
      argv: ['--help'],
      stdout,
      stderr,
      spawnFn() { spawned = true; return fakeChild(); }
    });
    assert.equal(code, 0);
    assert.equal(spawned, false);
    assert.match(stdout.text, /--confirm-slug/);
    assert.match(stdout.text, /--dump-dir/);
    assert.match(stdout.text, /docs\/CUSTOMER_ONBOARDING\.md/);
    assert.equal(stdout.text, OFFBOARD_CUSTOMER_HELP);
    assert.doesNotMatch(stdout.text, /tok_test_secret_value/);
  });

  test('dry-run prints the exact plan and does not spawn', async () => {
    let spawned = false;
    const { stdout, stderr } = captureStreams();
    const code = await runOffboardCustomerCli({
      argv: ['--slug', 'Acme'],
      env: SECRET_ENV,
      stdout,
      stderr,
      spawnFn() { spawned = true; return fakeChild(); }
    });
    assert.equal(code, 0, stderr.text);
    assert.equal(spawned, false);
    assert.match(stdout.text, /dry-run — no Vercel or Turso mutation/);
    assert.match(stdout.text, /Customer slug:  acme/);
    assert.match(stdout.text, /turso db shell procureflow-acme \.dump/);
    assert.match(stdout.text, /turso db destroy procureflow-acme --yes/);
    assert.match(stdout.text, /vercel env rm TURSO_DATABASE_URL production --yes --project procureflow-acme/);
    assert.match(stdout.text, /vercel env rm TURSO_PREVIEW_AUTH_TOKEN preview --yes --project procureflow-acme/);
    assert.match(stdout.text, /vercel env rm SESSION_SECRET preview --yes --project procureflow-acme/);
    assert.match(stdout.text, /vercel env rm PORTAL_TOKEN_SECRET production --yes --project procureflow-acme/);
    assert.match(stdout.text, /vercel env rm CRON_SECRET preview --yes --project procureflow-acme/);
    assert.match(stdout.text, /vercel env rm WEBHOOK_SIGNING_SECRET production --yes --project procureflow-acme/);
    assert.match(stdout.text, /vercel env rm PROCUREFLOW_TENANT preview --yes --project procureflow-acme/);
    assert.doesNotMatch(stdout.text, /vercel env rm TURSO_AUTH_TOKEN preview/);
    assert.doesNotMatch(stdout.text, /vercel env rm TURSO_DATABASE_URL preview/);
    assert.match(stdout.text, /tokens invalidate/);
    assert.match(stdout.text, /not printed/);
    assert.match(stdout.text, /docs\/CUSTOMER_ONBOARDING\.md/);
    assert.match(stdout.text, /does not delete the project/);
    assert.match(stdout.text, /--apply --confirm-slug acme/);
    assert.doesNotMatch(stdout.text, /tok_test_secret_value/);
    assert.doesNotMatch(stdout.text, /libsql:\/\/procureflow-acme\.turso\.io/);
    assert.doesNotMatch(stdout.text, new RegExp(SECRET_ENV.SESSION_SECRET));
    assert.doesNotMatch(stdout.text, /^\s*vercel link/m);
    assert.doesNotMatch(stdout.text, /npm run seed/);
    const report = formatDryRunReport({
      slug: 'acme',
      dbName: 'procureflow-acme-archive',
      projectName: 'pf-acme-prod'
    });
    assert.match(report, /turso db destroy procureflow-acme-archive --yes/);
    assert.match(report, /--project pf-acme-prod/);
  });

  test('--apply without --confirm-slug does not spawn', async () => {
    let spawned = false;
    const { stderr } = captureStreams();
    const code = await runOffboardCustomerCli({
      argv: ['--slug', 'acme', '--apply'],
      stdout: captureStreams().stdout,
      stderr,
      spawnFn() { spawned = true; return fakeChild(); }
    });
    assert.equal(code, 1);
    assert.equal(spawned, false);
    assert.match(stderr.text, /does not destroy anything by itself/);
    assert.match(stderr.text, /--confirm-slug acme/);
    assert.match(stderr.text, /was not destroyed/);
  });

  test('--apply with a mismatched --confirm-slug does not spawn', async () => {
    let spawned = false;
    const { stderr } = captureStreams();
    const code = await runOffboardCustomerCli({
      argv: ['--slug', 'Acme', '--apply', '--confirm-slug', 'Acme'],
      stdout: captureStreams().stdout,
      stderr,
      spawnFn() { spawned = true; return fakeChild(); }
    });
    assert.equal(code, 1);
    assert.equal(spawned, false);
    assert.match(stderr.text, /"Acme"/);
    assert.match(stderr.text, /normalized slug "acme"/);
    assert.match(stderr.text, /was not destroyed/);

    const other = captureStreams();
    const otherCode = await runOffboardCustomerCli({
      argv: ['--slug', 'acme', '--apply', '--confirm-slug', 'beta'],
      stdout: captureStreams().stdout,
      stderr: other.stderr,
      spawnFn() { spawned = true; return fakeChild(); }
    });
    assert.equal(otherCode, 1);
    assert.equal(spawned, false);
    assert.match(other.stderr.text, /"beta"/);
  });

  test('--seed is refused and does not spawn', async () => {
    let spawned = false;
    const { stderr } = captureStreams();
    const code = await runOffboardCustomerCli({
      argv: ['--slug', 'acme', '--apply', '--confirm-slug', 'acme', '--seed'],
      stdout: captureStreams().stdout,
      stderr,
      spawnFn() { spawned = true; return fakeChild(); }
    });
    assert.equal(code, 1);
    assert.equal(spawned, false);
    assert.match(stderr.text, /never seeds/);
  });

  test('--apply fails closed when linked to a different project', async () => {
    const link = linkedProjectFs('procureflow-other');
    const calls = [];
    const { stderr } = captureStreams();
    const code = await runOffboardCustomerCli({
      argv: ['--slug', 'acme', '--apply', '--confirm-slug', 'acme'],
      env: SECRET_ENV,
      cwd: '/tmp/linked-other',
      stdout: captureStreams().stdout,
      stderr,
      existsSync: link.existsSync,
      readFileSync: link.readFileSync,
      spawnFn(command, args) {
        calls.push([command, ...args]);
        return fakeChild();
      }
    });
    assert.equal(code, 1);
    assert.deepEqual(calls, []);
    assert.match(stderr.text, /procureflow-other/);
    assert.match(stderr.text, /procureflow-acme/);
    assert.match(stderr.text, /Refusing to retarget/);
    assert.match(stderr.text, /was not destroyed/);
    assert.doesNotMatch(stderr.text, /tok_test_secret_value/);
  });

  test('--apply strips the §3.1 env list, dumps outside the repo, then destroys, and redacts secrets', async () => {
    const link = linkedProjectFs('procureflow-acme');
    const calls = [];
    const stdins = [];
    const dumpDir = makeDumpDir();
    const { stdout, stderr } = captureStreams();
    try {
      const code = await runOffboardCustomerCli({
        argv: ['--slug', 'acme', '--apply', '--confirm-slug', 'acme', '--dump-dir', dumpDir],
        env: SECRET_ENV,
        cwd: '/tmp/linked-acme',
        stdout,
        stderr,
        existsSync: link.existsSync,
        readFileSync: link.readFileSync,
        now: new Date('2026-11-26T07:27:00.000Z'),
        spawnFn(command, args) {
          calls.push({ command, args: [...args] });
          const onStdin = (data) => stdins.push(String(data));
          if (command === 'vercel' && args[0] === 'whoami') {
            return fakeChild({ stdout: 'operator\n', onStdin });
          }
          if (command === 'turso' && args[0] === 'auth') {
            return fakeChild({ stdout: 'operator@turso\n', onStdin });
          }
          if (command === 'vercel' && args[0] === 'env' && args[1] === 'rm') {
            return fakeChild({
              stdout: `Removed ${args[2]} token=${SECRET_ENV.TURSO_AUTH_TOKEN}\n`,
              onStdin
            });
          }
          if (command === 'turso' && args[0] === 'db' && args[1] === 'shell') {
            return fakeChild({
              stdout: `${DUMP_SENTINEL}\n${SECRET_ENV.TURSO_AUTH_TOKEN}\n${SECRET_ENV.TURSO_DATABASE_URL}\n`,
              onStdin
            });
          }
          if (command === 'turso' && args[0] === 'db' && args[1] === 'destroy') {
            return fakeChild({ stdout: `Destroyed ${args[2]}\n`, onStdin });
          }
          throw new Error(`unexpected spawn ${command} ${args.join(' ')}`);
        }
      });
      assert.equal(code, 0, stderr.text);
      const flat = calls.map((call) => [call.command, ...call.args]);
      assert.deepEqual(flat, [
        ['vercel', 'whoami'],
        ['turso', 'auth', 'whoami'],
        ...expectedEnvCalls(),
        ['turso', 'db', 'shell', 'procureflow-acme', '.dump'],
        ['turso', 'db', 'destroy', 'procureflow-acme', '--yes']
      ]);
      const destroyAt = flat.findIndex((args) => args[2] === 'destroy');
      const dumpAt = flat.findIndex((args) => args[2] === 'shell');
      const lastEnv = flat.map((args) => args[2]).lastIndexOf('rm');
      assert.ok(dumpAt > lastEnv);
      assert.ok(destroyAt > dumpAt);
      assert.equal(argvHasInvalidate(flat), false);
      assert.equal(flat.some((args) => args.includes('procureflow-acme-preview')), false);
      assert.equal(flat.some((args) => args.includes('link') || args.includes('seed')), false);
      assert.equal(flat.some((args) => args.includes(DEMO_PERSONA_SWITCHER_KEY)), false);
      assert.deepEqual(stdins, []);
      const dumpFile = path.join(dumpDir, 'acme-20261126T072700Z.sql');
      const dumpBody = fs.readFileSync(dumpFile, 'utf8');
      assert.match(dumpBody, /PF_DUMP_SENTINEL_do_not_echo/);
      assert.match(stdout.text, /Already linked to procureflow-acme/);
      assert.match(stdout.text, /Turso database: destroyed/);
      assert.match(stdout.text, /left in place/);
      assert.match(stdout.text, /tokens invalidate was not run/);
      assert.match(stdout.text, /docs\/CUSTOMER_ONBOARDING\.md/);
      const shown = `${stdout.text}\n${stderr.text}`;
      assert.doesNotMatch(shown, /PF_DUMP_SENTINEL_do_not_echo/);
      assert.doesNotMatch(shown, /tok_test_secret_value/);
      assert.doesNotMatch(shown, /libsql:\/\/procureflow-acme\.turso\.io/);
      assert.match(stdout.text, /\$TURSO_AUTH_TOKEN/);
      assert.doesNotMatch(shown, new RegExp(SECRET_ENV.SESSION_SECRET));
      assert.equal(path.relative(repoRoot, dumpFile).startsWith('..'), true);
    } finally {
      removeDumpDir(dumpDir);
    }
  });

  test('an unlinked checkout uses --project and does not link', async () => {
    const fsStub = unlinkedFs();
    const calls = [];
    const dumpDir = makeDumpDir();
    const { stdout, stderr } = captureStreams();
    const code = await runOffboardCustomerCli({
      argv: ['--slug', 'acme', '--apply', '--confirm-slug', 'acme', '--dump-dir', dumpDir],
      cwd: '/tmp/unlinked-acme',
      stdout,
      stderr,
      existsSync: fsStub.existsSync,
      readFileSync: fsStub.readFileSync,
      spawnFn(command, args) {
        calls.push([command, ...args]);
        if (args[0] === 'whoami' || (args[0] === 'auth' && args[1] === 'whoami')) {
          return fakeChild({ stdout: 'operator\n' });
        }
        if (args[0] === 'env') return fakeChild({ stdout: 'Removed\n' });
        if (args[0] === 'db' && args[1] === 'shell') return fakeChild({ stdout: `${DUMP_SENTINEL}\n` });
        if (args[1] === 'destroy') return fakeChild({ stdout: 'Destroyed\n' });
        throw new Error(`unexpected spawn ${command} ${args.join(' ')}`);
      }
    });
    assert.equal(code, 0, stderr.text);
    assert.match(stdout.text, /not linked/);
    assert.equal(calls.some((args) => args.includes('link')), false);
    assert.equal(calls.some((args) => args[1] === 'project'), false);
    assert.deepEqual(
      calls.find((args) => args[2] === 'rm').slice(0, 8),
      ['vercel', 'env', 'rm', 'TURSO_DATABASE_URL', 'production', '--yes', '--project', 'procureflow-acme']
    );
    assert.equal(argvHasInvalidate(calls), false);
    removeDumpDir(dumpDir);
  });

  test('destroy already missing is success', async () => {
    const fsStub = unlinkedFs();
    const dumpDir = makeDumpDir();
    const { stdout, stderr } = captureStreams();
    const code = await runOffboardCustomerCli({
      argv: ['--slug', 'acme', '--apply', '--confirm-slug', 'acme', '--dump-dir', dumpDir],
      cwd: '/tmp/unlinked-acme',
      stdout,
      stderr,
      existsSync: fsStub.existsSync,
      readFileSync: fsStub.readFileSync,
      spawnFn(_command, args) {
        if (args[0] === 'whoami' || (args[0] === 'auth' && args[1] === 'whoami')) {
          return fakeChild({ stdout: 'operator\n' });
        }
        if (args[0] === 'env') return fakeChild({ stdout: 'Removed\n' });
        if (args[0] === 'db' && args[1] === 'shell') return fakeChild({ stdout: `${DUMP_SENTINEL}\n` });
        if (args[1] === 'destroy') {
          return fakeChild({
            exitCode: 1,
            stderr: 'Error: could not find database with name procureflow-acme: record not found\n'
          });
        }
        throw new Error(`unexpected spawn ${args.join(' ')}`);
      }
    });
    assert.equal(code, 0, stderr.text);
    assert.match(stdout.text, /already gone — treating destroy as success/);
    assert.match(stdout.text, /Turso database: already gone/);
    removeDumpDir(dumpDir);
  });

  test('env already absent is success and still destroys', async () => {
    const fsStub = unlinkedFs();
    const calls = [];
    const dumpDir = makeDumpDir();
    const { stdout, stderr } = captureStreams();
    const code = await runOffboardCustomerCli({
      argv: ['--slug', 'acme', '--apply', '--confirm-slug', 'acme', '--dump-dir', dumpDir],
      cwd: '/tmp/unlinked-acme',
      stdout,
      stderr,
      existsSync: fsStub.existsSync,
      readFileSync: fsStub.readFileSync,
      spawnFn(command, args) {
        calls.push([command, ...args]);
        if (args[0] === 'whoami' || (args[0] === 'auth' && args[1] === 'whoami')) {
          return fakeChild({ stdout: 'operator\n' });
        }
        if (args[0] === 'env') {
          return fakeChild({ exitCode: 1, stderr: 'Environment Variable was not found.\n' });
        }
        if (args[0] === 'db' && args[1] === 'shell') return fakeChild({ stdout: `${DUMP_SENTINEL}\n` });
        if (args[1] === 'destroy') return fakeChild({ stdout: 'Destroyed\n' });
        throw new Error(`unexpected spawn ${command} ${args.join(' ')}`);
      }
    });
    assert.equal(code, 0, stderr.text);
    assert.match(stdout.text, /already absent — continuing/);
    assert.match(stdout.text, /counted as success/);
    assert.match(stdout.text, /Turso database: destroyed/);
    assert.equal(calls.filter((args) => args[2] === 'rm').length, 14);
    assert.equal(calls.filter((args) => args[2] === 'destroy').length, 1);
    assert.equal(argvHasInvalidate(calls), false);
    assert.deepEqual(
      calls.filter((args) => args[2] === 'rm').map((args) => [args[3], args[4]]),
      VERCEL_ENV_TARGETS.flatMap((target) => (
        OFFBOARD_ENV_KEYS_BY_TARGET[target].map((key) => [key, target])
      ))
    );
    removeDumpDir(dumpDir);
  });

  test('a real env remove failure does not destroy the database', async () => {
    const fsStub = unlinkedFs();
    const calls = [];
    const { stderr } = captureStreams();
    const code = await runOffboardCustomerCli({
      argv: ['--slug', 'acme', '--apply', '--confirm-slug', 'acme'],
      cwd: '/tmp/unlinked-acme',
      stdout: captureStreams().stdout,
      stderr,
      existsSync: fsStub.existsSync,
      readFileSync: fsStub.readFileSync,
      spawnFn(command, args) {
        calls.push([command, ...args]);
        if (args[0] === 'whoami' || (args[0] === 'auth' && args[1] === 'whoami')) {
          return fakeChild({ stdout: 'operator\n' });
        }
        if (args[0] === 'env') return fakeChild({ exitCode: 1, stderr: 'Error: forbidden\n' });
        if (args[1] === 'destroy') return fakeChild({ stdout: 'Destroyed\n' });
        throw new Error(`unexpected spawn ${command} ${args.join(' ')}`);
      }
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /Stopped before Turso destroy/);
    assert.match(stderr.text, /was not destroyed/);
    assert.equal(calls.some((args) => args[2] === 'destroy'), false);
  });

  test('a missing Vercel project does not destroy the database', async () => {
    const fsStub = unlinkedFs();
    const calls = [];
    const { stderr } = captureStreams();
    const code = await runOffboardCustomerCli({
      argv: ['--slug', 'acme', '--apply', '--confirm-slug', 'acme'],
      cwd: '/tmp/unlinked-acme',
      stdout: captureStreams().stdout,
      stderr,
      existsSync: fsStub.existsSync,
      readFileSync: fsStub.readFileSync,
      spawnFn(command, args) {
        calls.push([command, ...args]);
        if (args[0] === 'whoami' || (args[0] === 'auth' && args[1] === 'whoami')) {
          return fakeChild({ stdout: 'operator\n' });
        }
        if (args[0] === 'env') {
          return fakeChild({
            exitCode: 1,
            stderr: 'Error: Project "procureflow-acme" was not found in the current scope.\n'
          });
        }
        throw new Error(`unexpected spawn ${command} ${args.join(' ')}`);
      }
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /was not found/);
    assert.match(stderr.text, /Refusing to destroy/);
    assert.equal(calls.filter((args) => args[2] === 'rm').length, 1);
    assert.equal(calls.some((args) => args[2] === 'destroy'), false);
  });

  test('an unreadable link does not spawn', async () => {
    const calls = [];
    const { stderr } = captureStreams();
    const code = await runOffboardCustomerCli({
      argv: ['--slug', 'acme', '--apply', '--confirm-slug', 'acme'],
      cwd: '/tmp/bad-link',
      stdout: captureStreams().stdout,
      stderr,
      existsSync(file) {
        return String(file).endsWith(`${path.sep}.vercel${path.sep}project.json`);
      },
      readFileSync() {
        return '{not json';
      },
      spawnFn(command, args) {
        calls.push([command, ...args]);
        return fakeChild();
      }
    });
    assert.equal(code, 1);
    assert.deepEqual(calls, []);
    assert.match(stderr.text, /could not be read/);
    assert.match(stderr.text, /was not destroyed/);
  });

  test('a failing dump does not spawn turso db destroy and does not echo the dump', async () => {
    const fsStub = unlinkedFs();
    const calls = [];
    const dumpDir = makeDumpDir();
    const { stdout, stderr } = captureStreams();
    try {
      const code = await runOffboardCustomerCli({
        argv: ['--slug', 'acme', '--apply', '--confirm-slug', 'acme', '--dump-dir', dumpDir],
        cwd: '/tmp/unlinked-acme',
        stdout,
        stderr,
        existsSync: fsStub.existsSync,
        readFileSync: fsStub.readFileSync,
        spawnFn(command, args) {
          calls.push([command, ...args]);
          if (args[0] === 'whoami' || (args[0] === 'auth' && args[1] === 'whoami')) {
            return fakeChild({ stdout: 'operator\n' });
          }
          if (args[0] === 'env') return fakeChild({ stdout: 'Removed\n' });
          if (args[0] === 'db' && args[1] === 'shell') {
            return fakeChild({
              exitCode: 2,
              stdout: `${DUMP_SENTINEL}\npartial sql that must not be printed\n`,
              stderr: `${DUMP_SENTINEL} on stderr\n`
            });
          }
          if (args[1] === 'destroy') return fakeChild({ stdout: 'Destroyed\n' });
          throw new Error(`unexpected spawn ${command} ${args.join(' ')}`);
        }
      });
      assert.equal(code, 1);
      assert.match(stderr.text, /turso db destroy was not run/);
      assert.match(stderr.text, /was not printed/);
      assert.equal(calls.some((args) => args[2] === 'shell'), true);
      assert.equal(calls.some((args) => args[2] === 'destroy'), false);
      assert.equal(argvHasInvalidate(calls), false);
      const shown = `${stdout.text}\n${stderr.text}`;
      assert.doesNotMatch(shown, /PF_DUMP_SENTINEL_do_not_echo/);
      assert.equal(fs.readdirSync(dumpDir).length, 0);
    } finally {
      removeDumpDir(dumpDir);
    }
  });

  test('an empty dump does not spawn turso db destroy', async () => {
    const fsStub = unlinkedFs();
    const calls = [];
    const dumpDir = makeDumpDir();
    const { stdout, stderr } = captureStreams();
    try {
      const code = await runOffboardCustomerCli({
        argv: ['--slug', 'acme', '--apply', '--confirm-slug', 'acme', '--dump-dir', dumpDir],
        cwd: '/tmp/unlinked-acme',
        stdout,
        stderr,
        existsSync: fsStub.existsSync,
        readFileSync: fsStub.readFileSync,
        spawnFn(command, args) {
          calls.push([command, ...args]);
          if (args[0] === 'whoami' || (args[0] === 'auth' && args[1] === 'whoami')) {
            return fakeChild({ stdout: 'operator\n' });
          }
          if (args[0] === 'env') return fakeChild({ stdout: 'Removed\n' });
          if (args[0] === 'db' && args[1] === 'shell') return fakeChild({ exitCode: 0, stdout: '\n' });
          if (args[1] === 'destroy') return fakeChild({ stdout: 'Destroyed\n' });
          throw new Error(`unexpected spawn ${command} ${args.join(' ')}`);
        }
      });
      assert.equal(code, 1);
      assert.match(stderr.text, /empty/);
      assert.match(stderr.text, /turso db destroy was not run/);
      assert.equal(calls.some((args) => args[2] === 'destroy'), false);
      assert.equal(fs.readdirSync(dumpDir).length, 0);
    } finally {
      removeDumpDir(dumpDir);
    }
  });

  test('a dump spawn error does not spawn turso db destroy', async () => {
    const fsStub = unlinkedFs();
    const calls = [];
    const dumpDir = makeDumpDir();
    const { stderr } = captureStreams();
    try {
      const code = await runOffboardCustomerCli({
        argv: ['--slug', 'acme', '--apply', '--confirm-slug', 'acme', '--dump-dir', dumpDir],
        cwd: '/tmp/unlinked-acme',
        stdout: captureStreams().stdout,
        stderr,
        existsSync: fsStub.existsSync,
        readFileSync: fsStub.readFileSync,
        spawnFn(command, args) {
          calls.push([command, ...args]);
          if (args[0] === 'whoami' || (args[0] === 'auth' && args[1] === 'whoami')) {
            return fakeChild({ stdout: 'operator\n' });
          }
          if (args[0] === 'env') return fakeChild({ stdout: 'Removed\n' });
          if (args[0] === 'db' && args[1] === 'shell') return fakeChild({ errorCode: 'ENOENT' });
          if (args[1] === 'destroy') return fakeChild({ stdout: 'Destroyed\n' });
          throw new Error(`unexpected spawn ${command} ${args.join(' ')}`);
        }
      });
      assert.equal(code, 1);
      assert.match(stderr.text, /could not be started/);
      assert.match(stderr.text, /turso db destroy was not run/);
      assert.equal(calls.some((args) => args[2] === 'destroy'), false);
      assert.equal(argvHasInvalidate(calls), false);
    } finally {
      removeDumpDir(dumpDir);
    }
  });

  test('a dump path inside the work tree is refused and does not spawn', async () => {
    const calls = [];
    const { stderr } = captureStreams();
    const inside = path.join(repoRoot, 'server');
    const code = await runOffboardCustomerCli({
      argv: ['--slug', 'acme', '--apply', '--confirm-slug', 'acme', '--dump-dir', inside],
      cwd: '/tmp/unlinked-acme',
      env: SECRET_ENV,
      stdout: captureStreams().stdout,
      stderr,
      existsSync: unlinkedFs().existsSync,
      readFileSync: unlinkedFs().readFileSync,
      spawnFn(command, args) {
        calls.push([command, ...args]);
        return fakeChild();
      }
    });
    assert.equal(code, 1);
    assert.deepEqual(calls, []);
    assert.match(stderr.text, /inside the git work tree/);
    assert.match(stderr.text, /was not destroyed/);
    assert.match(stderr.text, /was not printed/);
    assert.doesNotMatch(stderr.text, /tok_test_secret_value/);
    assert.doesNotMatch(stderr.text, /libsql:\/\//);

    const relative = captureStreams();
    const relativeCalls = [];
    const relativeCode = await runOffboardCustomerCli({
      argv: ['--slug', 'acme', '--apply', '--confirm-slug', 'acme', '--dump-dir', '.'],
      cwd: repoRoot,
      stdout: captureStreams().stdout,
      stderr: relative.stderr,
      existsSync: unlinkedFs().existsSync,
      readFileSync: unlinkedFs().readFileSync,
      spawnFn(command, args) {
        relativeCalls.push([command, ...args]);
        return fakeChild();
      }
    });
    assert.equal(relativeCode, 1);
    assert.deepEqual(relativeCalls, []);
    assert.match(relative.stderr.text, /inside the git work tree/);
  });

  test('without --confirm-slug nothing is spawned, including dump and destroy', async () => {
    const calls = [];
    const { stderr } = captureStreams();
    const code = await runOffboardCustomerCli({
      argv: ['--slug', 'acme', '--apply', '--dump-dir', os.tmpdir()],
      stdout: captureStreams().stdout,
      stderr,
      spawnFn(command, args) {
        calls.push([command, ...args]);
        return fakeChild();
      }
    });
    assert.equal(code, 1);
    assert.deepEqual(calls, []);
    assert.equal(argvHasInvalidate(calls), false);
    assert.match(stderr.text, /does not destroy anything by itself/);
  });
});

describe('offboard:customer wiring', () => {
  test('package.json script and the runbook name the CLI', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['offboard:customer'], 'node server/scripts/offboard-customer.js');
    assert.ok(fs.existsSync(path.join(repoRoot, 'server/scripts/offboard-customer.js')));
    const onboarding = fs.readFileSync(path.join(repoRoot, 'docs/CUSTOMER_ONBOARDING.md'), 'utf8');
    assert.match(onboarding, /npm run offboard:customer -- --slug acme --apply --confirm-slug acme/);
    const deployment = fs.readFileSync(path.join(repoRoot, 'docs/DEPLOYMENT.md'), 'utf8');
    assert.match(deployment, /npm run offboard:customer/);
  });
});
