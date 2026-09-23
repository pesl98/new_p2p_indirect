import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import {
  CUSTOMER_ENV_KEYS,
  DEMO_PERSONA_SWITCHER_KEY,
  VERCEL_ENV_TARGETS
} from './vercelCustomer.js';
import { looksLikeMissingDatabase } from './tursoCustomer.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
import {
  OFFBOARD_CUSTOMER_HELP,
  confirmSlugMatches,
  envRmArgv,
  formatDryRunReport,
  looksLikeEnvAlreadyAbsent,
  looksLikeVercelProjectAbsent,
  parseOffboardCustomerArgs,
  plannedEnvRemovals,
  plannedOffboardCommands,
  resolveOffboardIdentity,
  runOffboardCustomerCli,
  tursoDestroyArgv
} from './offboardCustomer.js';

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
  test('env remove covers three keys on production and preview, then destroy', () => {
    const plan = plannedOffboardCommands('procureflow-acme', 'procureflow-acme');
    assert.deepEqual(plan.whoami.argv, ['whoami']);
    assert.deepEqual(plan.tursoWhoami.argv, ['auth', 'whoami']);
    assert.equal(plan.envRemovals.length, 6);
    assert.deepEqual(
      plan.envRemovals.map((cmd) => [cmd.key, cmd.target]),
      CUSTOMER_ENV_KEYS.flatMap((key) => VERCEL_ENV_TARGETS.map((target) => [key, target]))
    );
    assert.deepEqual(envRmArgv('TURSO_AUTH_TOKEN', 'preview', 'procureflow-acme'), [
      'env', 'rm', 'TURSO_AUTH_TOKEN', 'preview', '--yes', '--project', 'procureflow-acme'
    ]);
    assert.deepEqual(tursoDestroyArgv('procureflow-acme'), [
      'db', 'destroy', 'procureflow-acme', '--yes'
    ]);
    const joined = plannedEnvRemovals('procureflow-acme').map((cmd) => cmd.display).join('\n');
    assert.doesNotMatch(joined, new RegExp(DEMO_PERSONA_SWITCHER_KEY));
    assert.doesNotMatch(joined, /seed/);
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
    assert.match(stdout.text, /turso db destroy procureflow-acme --yes/);
    assert.match(stdout.text, /vercel env rm TURSO_DATABASE_URL production --yes --project procureflow-acme/);
    assert.match(stdout.text, /vercel env rm TURSO_AUTH_TOKEN preview --yes --project procureflow-acme/);
    assert.match(stdout.text, /vercel env rm SESSION_SECRET preview --yes --project procureflow-acme/);
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

  test('--apply strips Production+Preview env, then destroys, and redacts secrets', async () => {
    const link = linkedProjectFs('procureflow-acme');
    const calls = [];
    const stdins = [];
    const { stdout, stderr } = captureStreams();
    const code = await runOffboardCustomerCli({
      argv: ['--slug', 'acme', '--apply', '--confirm-slug', 'acme'],
      env: SECRET_ENV,
      cwd: '/tmp/linked-acme',
      stdout,
      stderr,
      existsSync: link.existsSync,
      readFileSync: link.readFileSync,
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
        if (command === 'turso' && args[0] === 'db' && args[1] === 'destroy') {
          return fakeChild({ stdout: `Destroyed ${args[2]}\n`, onStdin });
        }
        throw new Error(`unexpected spawn ${command} ${args.join(' ')}`);
      }
    });
    assert.equal(code, 0, stderr.text);
    assert.deepEqual(calls.map((call) => [call.command, ...call.args]), [
      ['vercel', 'whoami'],
      ['turso', 'auth', 'whoami'],
      ...CUSTOMER_ENV_KEYS.flatMap((key) => VERCEL_ENV_TARGETS.map(
        (target) => ['vercel', 'env', 'rm', key, target, '--yes', '--project', 'procureflow-acme']
      )),
      ['turso', 'db', 'destroy', 'procureflow-acme', '--yes']
    ]);
    const destroyAt = calls.findIndex((call) => call.args[1] === 'destroy');
    const lastEnv = calls.map((call) => call.args[1]).lastIndexOf('rm');
    assert.ok(destroyAt > lastEnv);
    assert.equal(calls.some((call) => call.args.includes('link') || call.args.includes('seed')), false);
    assert.equal(calls.some((call) => call.args.includes(DEMO_PERSONA_SWITCHER_KEY)), false);
    assert.deepEqual(stdins, []);
    assert.match(stdout.text, /Already linked to procureflow-acme/);
    assert.match(stdout.text, /Turso database: destroyed/);
    assert.match(stdout.text, /left in place/);
    assert.match(stdout.text, /docs\/CUSTOMER_ONBOARDING\.md/);
    assert.doesNotMatch(stdout.text, /tok_test_secret_value/);
    assert.match(stdout.text, /\$TURSO_AUTH_TOKEN/);
    assert.doesNotMatch(`${stdout.text}\n${stderr.text}`, new RegExp(SECRET_ENV.SESSION_SECRET));
  });

  test('an unlinked checkout uses --project and does not link', async () => {
    const fsStub = unlinkedFs();
    const calls = [];
    const { stdout, stderr } = captureStreams();
    const code = await runOffboardCustomerCli({
      argv: ['--slug', 'acme', '--apply', '--confirm-slug', 'acme'],
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
  });

  test('destroy already missing is success', async () => {
    const fsStub = unlinkedFs();
    const { stdout, stderr } = captureStreams();
    const code = await runOffboardCustomerCli({
      argv: ['--slug', 'acme', '--apply', '--confirm-slug', 'acme'],
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
  });

  test('env already absent is success and still destroys', async () => {
    const fsStub = unlinkedFs();
    const calls = [];
    const { stdout, stderr } = captureStreams();
    const code = await runOffboardCustomerCli({
      argv: ['--slug', 'acme', '--apply', '--confirm-slug', 'acme'],
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
        if (args[1] === 'destroy') return fakeChild({ stdout: 'Destroyed\n' });
        throw new Error(`unexpected spawn ${command} ${args.join(' ')}`);
      }
    });
    assert.equal(code, 0, stderr.text);
    assert.match(stdout.text, /already absent — continuing/);
    assert.match(stdout.text, /Turso database: destroyed/);
    assert.equal(calls.filter((args) => args[2] === 'destroy').length, 1);
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
