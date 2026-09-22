import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  CUSTOMER_ENV_KEYS,
  DEMO_PERSONA_SWITCHER_KEY,
  VERCEL_CUSTOMER_HELP,
  VERCEL_ENV_TARGETS,
  buildApplyPlan,
  defaultProjectName,
  envAddArgv,
  formatDryRunReport,
  missingCustomerEnvKeys,
  normalizeSlug,
  parseDeploymentTarget,
  parseInspectReadyState,
  parseProjectInspectName,
  parseVercelCustomerArgs,
  pickDeploymentRef,
  projectAddArgv,
  projectAddOk,
  projectLinkArgv,
  readLinkedProject,
  redactSecrets,
  resolveReadyTimeoutMs,
  runProcess,
  runVercelCustomerCli,
  suggestedBaseUrl,
  waitForDeploymentReady,
  DEFAULT_VERCEL_READY_TIMEOUT_MS
} from './vercelCustomer.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function captureStreams() {
  const stdout = { text: '', write(chunk) { this.text += chunk; } };
  const stderr = { text: '', write(chunk) { this.text += chunk; } };
  return { stdout, stderr };
}

function readyEnv(extra = {}) {
  return {
    TURSO_DATABASE_URL: 'libsql://procureflow-acme.turso.io',
    TURSO_AUTH_TOKEN: 'tok_test_secret_value',
    SESSION_SECRET: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ...extra
  };
}

function inspectJson(state, extra = {}) {
  return `${JSON.stringify({
    id: 'dpl_new',
    url: 'procureflow-acme-abc123.vercel.app',
    target: 'production',
    readyState: state,
    ...extra
  })}\n`;
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
      if (onStdin) onStdin(data);
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

describe('vercel:customer arg parsing', () => {
  test('parses slug, project, apply, dry-run, and equals-form flags', () => {
    const args = parseVercelCustomerArgs([
      '--slug', 'acme',
      '--project=procureflow-acme',
      '--apply'
    ]);
    assert.equal(args.slug, 'acme');
    assert.equal(args.project, 'procureflow-acme');
    assert.equal(args.apply, true);
    assert.equal(args.dryRun, false);
    assert.equal(args.help, false);

    const dry = parseVercelCustomerArgs(['--slug=beta', '--dry-run']);
    assert.equal(dry.slug, 'beta');
    assert.equal(dry.apply, false);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.dryRunFlag, true);
  });

  test('dry-run is the default when --apply is omitted', () => {
    const args = parseVercelCustomerArgs(['--slug', 'acme']);
    assert.equal(args.apply, false);
    assert.equal(args.dryRun, true);
    assert.equal(args.dryRunFlag, false);
  });

  test('unknown flags are collected; --seed is tracked', () => {
    const args = parseVercelCustomerArgs(['--slug', 'acme', '--wipe', '--seed']);
    assert.deepEqual(args.unknown, ['--wipe']);
    assert.equal(args.seed, true);
  });

  test('default project name is procureflow-<slug>', () => {
    assert.equal(defaultProjectName('acme'), 'procureflow-acme');
    assert.equal(defaultProjectName('procureflow-beta'), 'procureflow-beta');
    assert.equal(suggestedBaseUrl('procureflow-acme'), 'https://procureflow-acme.vercel.app');
  });

  test('normalizeSlug accepts lowercase hyphenated names and rejects junk', () => {
    assert.equal(normalizeSlug('Acme'), 'acme');
    assert.equal(normalizeSlug('acme-corp'), 'acme-corp');
    assert.equal(normalizeSlug(''), null);
    assert.equal(normalizeSlug('-acme'), null);
    assert.equal(normalizeSlug('acme_corp'), null);
  });
});

describe('vercel:customer env gating', () => {
  test('missingCustomerEnvKeys lists only unset required keys', () => {
    assert.deepEqual(
      missingCustomerEnvKeys({}),
      ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'SESSION_SECRET']
    );
    assert.deepEqual(
      missingCustomerEnvKeys({
        TURSO_DATABASE_URL: 'libsql://x.turso.io',
        TURSO_AUTH_TOKEN: '  ',
        SESSION_SECRET: 'abc'
      }),
      ['TURSO_AUTH_TOKEN']
    );
    assert.deepEqual(missingCustomerEnvKeys(readyEnv()), []);
  });

  test('apply plan covers three keys on production and preview and skips the demo switcher', () => {
    const plan = buildApplyPlan({ slug: 'acme', projectName: 'procureflow-acme' });
    assert.equal(plan.envCommands.length, 6);
    assert.deepEqual(
      plan.envCommands.map((c) => [c.key, c.target]),
      CUSTOMER_ENV_KEYS.flatMap((key) => VERCEL_ENV_TARGETS.map((target) => [key, target]))
    );
    assert.deepEqual(envAddArgv('SESSION_SECRET', 'preview'), [
      'env', 'add', 'SESSION_SECRET', 'preview', '--yes', '--force'
    ]);
    assert.deepEqual(plan.skipped, [DEMO_PERSONA_SWITCHER_KEY]);
    assert.doesNotMatch(
      plan.envCommands.map((c) => c.display).join('\n'),
      /DEMO_PERSONA_SWITCHER/
    );
  });
});

describe('vercel:customer CLI (no live Vercel)', () => {
  test('--help documents dry-run vs apply and does not spawn', async () => {
    let spawned = false;
    const { stdout, stderr } = captureStreams();
    const code = await runVercelCustomerCli({
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
    assert.equal(stdout.text, VERCEL_CUSTOMER_HELP);
    assert.match(stdout.text, /--dry-run/);
    assert.match(stdout.text, /--apply/);
    assert.match(stdout.text, /never invented/);
    assert.match(stdout.text, /DEMO_PERSONA_SWITCHER/);
    assert.match(stdout.text, /vercel project add/);
    assert.match(stdout.text, /vercel link --yes --project/);
    assert.match(stdout.text, /does not connect GitHub/);
    assert.doesNotMatch(stdout.text, /does not create Vercel projects/);
  });

  test('refuses missing --slug', async () => {
    const { stdout, stderr } = captureStreams();
    const code = await runVercelCustomerCli({
      argv: [],
      env: readyEnv(),
      stdout,
      stderr,
      spawnFn() { throw new Error('should not spawn'); }
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /--slug is required/);
    assert.match(stderr.text, /--apply/);
  });

  test('refuses apply without --slug', async () => {
    const { stderr } = captureStreams();
    const code = await runVercelCustomerCli({
      argv: ['--apply'],
      env: readyEnv(),
      stdout: captureStreams().stdout,
      stderr,
      spawnFn() { throw new Error('should not spawn'); }
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /--slug is required/);
  });

  test('refuses missing env on dry-run (does not invent secrets, does not spawn)', async () => {
    let spawned = false;
    const { stderr } = captureStreams();
    const code = await runVercelCustomerCli({
      argv: ['--slug', 'acme'],
      env: { TURSO_DATABASE_URL: 'libsql://x.turso.io' },
      stdout: captureStreams().stdout,
      stderr,
      spawnFn() {
        spawned = true;
        return fakeChild();
      }
    });
    assert.equal(code, 1);
    assert.equal(spawned, false);
    assert.match(stderr.text, /Refusing to invent secrets/);
    assert.match(stderr.text, /TURSO_AUTH_TOKEN/);
    assert.match(stderr.text, /SESSION_SECRET/);
    assert.doesNotMatch(stderr.text, /tok_/);
  });

  test('refuses missing env on --apply', async () => {
    const { stderr } = captureStreams();
    const code = await runVercelCustomerCli({
      argv: ['--slug', 'acme', '--apply'],
      env: {},
      stdout: captureStreams().stdout,
      stderr,
      spawnFn() { throw new Error('should not spawn'); }
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /Refusing to invent secrets/);
    assert.match(stderr.text, /TURSO_DATABASE_URL/);
  });

  test('refuses --apply together with --dry-run', async () => {
    const { stderr } = captureStreams();
    const code = await runVercelCustomerCli({
      argv: ['--slug', 'acme', '--apply', '--dry-run'],
      env: readyEnv(),
      stdout: captureStreams().stdout,
      stderr,
      spawnFn() { throw new Error('should not spawn'); }
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /not both/);
  });

  test('--seed is refused', async () => {
    const { stderr } = captureStreams();
    const code = await runVercelCustomerCli({
      argv: ['--slug', 'acme', '--seed'],
      env: readyEnv(),
      stdout: captureStreams().stdout,
      stderr,
      spawnFn() { throw new Error('should not spawn'); }
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /never seeds/);
  });

  test('dry-run prints Production+Preview checklist and commands without spawning', async () => {
    let spawned = false;
    const env = readyEnv();
    const { stdout, stderr } = captureStreams();
    const code = await runVercelCustomerCli({
      argv: ['--slug', 'acme'],
      env,
      stdout,
      stderr,
      spawnFn() {
        spawned = true;
        return fakeChild();
      }
    });
    assert.equal(code, 0, stderr.text);
    assert.equal(spawned, false);
    assert.match(stdout.text, /dry-run — no Vercel mutation/);
    assert.match(stdout.text, /Customer slug:  acme/);
    assert.match(stdout.text, /Project name:   procureflow-acme/);
    assert.match(stdout.text, /https:\/\/procureflow-acme\.vercel\.app/);
    assert.match(stdout.text, /Set TURSO_DATABASE_URL on production/);
    assert.match(stdout.text, /Set TURSO_DATABASE_URL on preview/);
    assert.match(stdout.text, /Set TURSO_AUTH_TOKEN on production/);
    assert.match(stdout.text, /Set TURSO_AUTH_TOKEN on preview/);
    assert.match(stdout.text, /Set SESSION_SECRET on production/);
    assert.match(stdout.text, /Set SESSION_SECRET on preview/);
    assert.match(stdout.text, /Leave DEMO_PERSONA_SWITCHER unset/);
    assert.match(stdout.text, /printf '%s' "\$TURSO_AUTH_TOKEN" \| vercel env add TURSO_AUTH_TOKEN production --yes --force/);
    assert.match(stdout.text, /vercel project add procureflow-acme/);
    assert.match(stdout.text, /vercel link --yes --project procureflow-acme/);
    assert.match(stdout.text, /does not connect GitHub/);
    assert.match(stdout.text, /vercel redeploy <latest-production-deployment> --yes/);
    assert.match(stdout.text, /vercel inspect <new-deployment-url-or-id> --json/);
    assert.match(stdout.text, /VERCEL_READY_TIMEOUT_MS/);
    assert.match(stdout.text, /waits for Production Ready|until readyState is READY/);
    assert.match(stdout.text, /Dry-run does not call Vercel/);
    assert.match(stdout.text, /npm run vercel:customer -- --slug acme --apply/);
    assert.match(stdout.text, /BASE_URL=https:\/\/procureflow-acme\.vercel\.app npm run smoke/);
    assert.doesNotMatch(stdout.text, /tok_test_secret_value/);
    assert.equal(stdout.text.includes(env.SESSION_SECRET), false);
    assert.match(stdout.text, /libsql:\/\/procureflow-acme\.turso\.io/);
  });

  test('--project overrides the default name in dry-run', async () => {
    const { stdout } = captureStreams();
    const code = await runVercelCustomerCli({
      argv: ['--slug', 'acme', '--project', 'pf-acme-prod'],
      env: readyEnv(),
      stdout,
      stderr: captureStreams().stderr,
      spawnFn() { throw new Error('should not spawn'); }
    });
    assert.equal(code, 0);
    assert.match(stdout.text, /Project name:   pf-acme-prod/);
    assert.match(stdout.text, /https:\/\/pf-acme-prod\.vercel\.app/);
  });

  test('--apply fails clearly when Vercel CLI is missing', async () => {
    const { stderr } = captureStreams();
    const code = await runVercelCustomerCli({
      argv: ['--slug', 'acme', '--apply'],
      env: readyEnv(),
      cwd: '/tmp',
      stdout: captureStreams().stdout,
      stderr,
      existsSync: () => true,
      spawnFn() {
        return fakeChild({ errorCode: 'ENOENT' });
      }
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /Vercel CLI was not found/);
    assert.match(stderr.text, /vercel login/);
  });

  test('--apply fails clearly when not logged in', async () => {
    const { stderr } = captureStreams();
    const code = await runVercelCustomerCli({
      argv: ['--slug', 'acme', '--apply'],
      env: readyEnv(),
      cwd: '/tmp',
      stdout: captureStreams().stdout,
      stderr,
      existsSync: () => true,
      spawnFn(_cmd, args) {
        if (args[0] === 'whoami') {
          return fakeChild({ exitCode: 1, stderr: 'No existing credentials found' });
        }
        throw new Error(`unexpected spawn ${args.join(' ')}`);
      }
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /not logged in/);
    assert.match(stderr.text, /vercel login/);
  });

  test('--apply when unlinked runs project add then link before env', async () => {
    const env = readyEnv();
    const calls = [];
    const { stdout, stderr } = captureStreams();
    const code = await runVercelCustomerCli({
      argv: ['--slug', 'acme', '--apply'],
      env,
      cwd: '/tmp/unlinked-acme',
      stdout,
      stderr,
      existsSync: () => false,
      spawnFn(_command, args) {
        calls.push([...args]);
        if (args[0] === 'whoami') return fakeChild({ stdout: 'operator\n' });
        if (args[0] === 'project' && args[1] === 'add') {
          return fakeChild({ stdout: 'Success! Project procureflow-acme added\n' });
        }
        if (args[0] === 'link') return fakeChild({ stdout: 'Linked\n' });
        if (args[0] === 'env') return fakeChild({ stdout: `Created ${args[2]}\n` });
        if (args[0] === 'ls') {
          return fakeChild({
            stdout: JSON.stringify([{ uid: 'dpl_acme123', url: 'procureflow-acme.vercel.app' }])
          });
        }
        if (args[0] === 'redeploy') return fakeChild({ stdout: 'https://procureflow-acme-abc123.vercel.app\n' });
        if (args[0] === 'inspect') return fakeChild({ stdout: inspectJson('READY') });
        throw new Error(`unexpected spawn ${args.join(' ')}`);
      }
    });
    assert.equal(code, 0, stderr.text);
    assert.deepEqual(calls[0], ['whoami']);
    assert.deepEqual(calls[1], projectAddArgv('procureflow-acme'));
    assert.deepEqual(calls[2], projectLinkArgv('procureflow-acme'));
    const envIndex = calls.findIndex((args) => args[0] === 'env');
    assert.ok(envIndex > 2);
    assert.equal(calls.filter((args) => args[0] === 'env').length, 6);
    assert.match(stdout.text, /Ensuring Vercel project procureflow-acme/);
    assert.match(stdout.text, /Linking this directory/);
    assert.equal(stdout.text.includes(env.TURSO_AUTH_TOKEN), false);
    assert.equal(calls.some((args) => args.includes(env.TURSO_AUTH_TOKEN)), false);
  });

  test('--apply reuses a project when project add reports it already exists', async () => {
    const calls = [];
    const { stdout, stderr } = captureStreams();
    const code = await runVercelCustomerCli({
      argv: ['--slug', 'acme', '--apply'],
      env: readyEnv(),
      cwd: '/tmp/unlinked-acme',
      stdout,
      stderr,
      existsSync: () => false,
      spawnFn(_command, args) {
        calls.push(args[0] === 'project' ? args.slice(0, 2).join(' ') : args[0]);
        if (args[0] === 'whoami') return fakeChild({ stdout: 'operator\n' });
        if (args[0] === 'project') {
          return fakeChild({ exitCode: 1, stderr: 'Error: Project already exists (409)\n' });
        }
        if (args[0] === 'link') return fakeChild({ stdout: 'Linked\n' });
        if (args[0] === 'env') return fakeChild();
        if (args[0] === 'ls') return fakeChild({ stdout: 'No deployments found.\n' });
        if (args[0] === 'deploy') return fakeChild({ stdout: 'https://procureflow-acme-abc123.vercel.app\n' });
        if (args[0] === 'inspect') return fakeChild({ stdout: inspectJson('READY') });
        throw new Error(`unexpected spawn ${args.join(' ')}`);
      }
    });
    assert.equal(code, 0, stderr.text);
    assert.equal(calls.includes('link'), true);
    assert.equal(calls.includes('inspect'), true);
    assert.match(stdout.text, /already exists — reusing it/);
  });

  test('--apply fails closed when linked to a different project', async () => {
    const link = linkedProjectFs('procureflow-other');
    const calls = [];
    const { stderr } = captureStreams();
    const code = await runVercelCustomerCli({
      argv: ['--slug', 'acme', '--apply'],
      env: readyEnv(),
      cwd: '/tmp/linked-other',
      stdout: captureStreams().stdout,
      stderr,
      existsSync: link.existsSync,
      readFileSync: link.readFileSync,
      spawnFn(_command, args) {
        calls.push([...args]);
        if (args[0] === 'whoami') return fakeChild({ stdout: 'operator\n' });
        throw new Error(`unexpected spawn ${args.join(' ')}`);
      }
    });
    assert.equal(code, 1);
    assert.deepEqual(calls, [['whoami']]);
    assert.match(stderr.text, /procureflow-other/);
    assert.match(stderr.text, /procureflow-acme/);
    assert.match(stderr.text, /Refusing to retarget/);
    assert.doesNotMatch(stderr.text, /tok_test_secret_value/);
  });

  test('--apply upserts Production+Preview env, redeploys, and never prints secrets', async () => {
    const env = readyEnv();
    const calls = [];
    const stdinValues = [];
    const link = linkedProjectFs('procureflow-acme');
    const { stdout, stderr } = captureStreams();
    const code = await runVercelCustomerCli({
      argv: ['--slug', 'acme', '--apply'],
      env,
      cwd: '/tmp/linked-acme',
      stdout,
      stderr,
      existsSync: link.existsSync,
      readFileSync: link.readFileSync,
      spawnFn(command, args, options) {
        calls.push({ command, args, cwd: options.cwd });
        const onStdin = (data) => stdinValues.push({ args: [...args], data: String(data) });
        if (args[0] === 'whoami') {
          return fakeChild({ stdout: 'operator\n', onStdin });
        }
        if (args[0] === 'env' && args[1] === 'add') {
          return fakeChild({ stdout: `Created ${args[2]}\n`, onStdin });
        }
        if (args[0] === 'ls') {
          return fakeChild({
            stdout: JSON.stringify([{
              uid: 'dpl_acme123',
              url: 'procureflow-acme.vercel.app'
            }]),
            onStdin
          });
        }
        if (args[0] === 'redeploy') {
          return fakeChild({ stdout: 'https://procureflow-acme-abc123.vercel.app\n', onStdin });
        }
        if (args[0] === 'inspect') {
          return fakeChild({ stdout: inspectJson('READY'), onStdin });
        }
        throw new Error(`unexpected spawn ${args.join(' ')}`);
      }
    });
    assert.equal(code, 0, stderr.text);
    assert.equal(calls[0].command, 'vercel');
    assert.deepEqual(calls[0].args, ['whoami']);
    assert.equal(calls.some((c) => c.args[0] === 'project' || c.args[0] === 'link'), false);
    assert.match(stdout.text, /Already linked to procureflow-acme — skipping project add and link/);
    const envCalls = calls.filter((c) => c.args[0] === 'env');
    assert.equal(envCalls.length, 6);
    assert.deepEqual(
      envCalls.map((c) => c.args),
      CUSTOMER_ENV_KEYS.flatMap((key) => VERCEL_ENV_TARGETS.map(
        (target) => ['env', 'add', key, target, '--yes', '--force']
      ))
    );
    assert.deepEqual(
      stdinValues.filter((s) => s.args[0] === 'env').map((s) => s.data),
      [
        env.TURSO_DATABASE_URL, env.TURSO_DATABASE_URL,
        env.TURSO_AUTH_TOKEN, env.TURSO_AUTH_TOKEN,
        env.SESSION_SECRET, env.SESSION_SECRET
      ]
    );
    const ls = calls.find((c) => c.args[0] === 'ls');
    assert.deepEqual(ls.args, ['ls', '--environment', 'production']);
    const redeploy = calls.find((c) => c.args[0] === 'redeploy');
    assert.deepEqual(redeploy.args, ['redeploy', 'dpl_acme123', '--yes']);
    const inspect = calls.find((c) => c.args[0] === 'inspect');
    assert.ok(calls.indexOf(inspect) > calls.indexOf(redeploy));
    assert.deepEqual(inspect.args, [
      'inspect',
      'https://procureflow-acme-abc123.vercel.app',
      '--json'
    ]);
    assert.match(stdout.text, /Production deployment https:\/\/procureflow-acme-abc123\.vercel\.app is Ready/);
    assert.match(stdout.text, /Production:\s+Ready/);
    assert.equal(calls.some((c) => c.args.includes('seed') || c.args[0] === 'deploy'), false);
    assert.match(stdout.text, /Production\+Preview env set/);
    assert.match(stdout.text, /DEMO_PERSONA_SWITCHER left unset/);
    assert.match(stdout.text, /BASE_URL=https:\/\/procureflow-acme\.vercel\.app npm run smoke/);
    assert.match(stdout.text, /provision:customer/);
    assert.doesNotMatch(stdout.text, /tok_test_secret_value/);
    assert.equal(stdout.text.includes(env.SESSION_SECRET), false);
    assert.doesNotMatch(stderr.text, /tok_test_secret_value/);
    for (const call of calls) {
      assert.equal(call.args.includes(env.TURSO_AUTH_TOKEN), false);
      assert.equal(call.args.includes(env.SESSION_SECRET), false);
    }
  });

  test('--apply falls back to vercel deploy --prod when no production deployment exists', async () => {
    const calls = [];
    const link = linkedProjectFs('procureflow-acme');
    const { stdout, stderr } = captureStreams();
    const code = await runVercelCustomerCli({
      argv: ['--slug', 'acme', '--apply'],
      env: readyEnv(),
      cwd: '/tmp/linked-acme',
      stdout,
      stderr,
      existsSync: link.existsSync,
      readFileSync: link.readFileSync,
      spawnFn(_command, args) {
        calls.push(args[0]);
        if (args[0] === 'whoami') return fakeChild({ stdout: 'operator\n' });
        if (args[0] === 'env') return fakeChild();
        if (args[0] === 'ls') return fakeChild({ stdout: 'No deployments found.\n' });
        if (args[0] === 'deploy') return fakeChild({ stdout: 'https://procureflow-acme-abc123.vercel.app\n' });
        if (args[0] === 'inspect') return fakeChild({ stdout: inspectJson('READY') });
        throw new Error(`unexpected spawn ${args.join(' ')}`);
      }
    });
    assert.equal(code, 0, stderr.text);
    assert.equal(calls.includes('redeploy'), false);
    assert.equal(calls.includes('deploy'), true);
    assert.ok(calls.indexOf('inspect') > calls.indexOf('deploy'));
    assert.match(stdout.text, /No production deployment found/);
  });

  test('--apply inspects a link that has no projectName and skips when it matches', async () => {
    const calls = [];
    const { stdout, stderr } = captureStreams();
    const code = await runVercelCustomerCli({
      argv: ['--slug', 'acme', '--apply'],
      env: readyEnv(),
      cwd: '/tmp/linked-legacy',
      stdout,
      stderr,
      existsSync: (file) => String(file).endsWith(`${path.sep}.vercel${path.sep}project.json`),
      readFileSync: () => JSON.stringify({ projectId: 'prj_legacy', orgId: 'team_legacy' }),
      spawnFn(_command, args) {
        calls.push([...args]);
        if (args[0] === 'whoami') return fakeChild({ stdout: 'operator\n' });
        if (args[0] === 'project' && args[1] === 'inspect') {
          return fakeChild({ stdout: JSON.stringify({ id: 'prj_legacy', name: 'procureflow-acme' }) });
        }
        if (args[0] === 'env') return fakeChild();
        if (args[0] === 'ls') return fakeChild({ stdout: 'No deployments found.\n' });
        if (args[0] === 'deploy') return fakeChild({ stdout: 'https://procureflow-acme-abc123.vercel.app\n' });
        if (args[0] === 'inspect') return fakeChild({ stdout: inspectJson('READY') });
        throw new Error(`unexpected spawn ${args.join(' ')}`);
      }
    });
    assert.equal(code, 0, stderr.text);
    assert.deepEqual(
      calls.find((args) => args[0] === 'project'),
      ['project', 'inspect', '--json']
    );
    assert.equal(calls.some((args) => args[0] === 'link' || (args[0] === 'project' && args[1] === 'add')), false);
    assert.match(stdout.text, /skipping project add and link/);
  });

  test('--apply fails closed when inspect shows a different linked project', async () => {
    const calls = [];
    const { stderr } = captureStreams();
    const code = await runVercelCustomerCli({
      argv: ['--slug', 'acme', '--apply'],
      env: readyEnv(),
      cwd: '/tmp/linked-legacy',
      stdout: captureStreams().stdout,
      stderr,
      existsSync: (file) => String(file).endsWith(`${path.sep}.vercel${path.sep}project.json`),
      readFileSync: () => JSON.stringify({ projectId: 'prj_legacy', orgId: 'team_legacy' }),
      spawnFn(_command, args) {
        calls.push([...args]);
        if (args[0] === 'whoami') return fakeChild({ stdout: 'operator\n' });
        if (args[0] === 'project' && args[1] === 'inspect') {
          return fakeChild({ stdout: JSON.stringify({ id: 'prj_legacy', name: 'procureflow-other' }) });
        }
        throw new Error(`unexpected spawn ${args.join(' ')}`);
      }
    });
    assert.equal(code, 1);
    assert.equal(calls.some((args) => args[0] === 'link' || args[0] === 'env' || (args[1] === 'add')), false);
    assert.match(stderr.text, /Refusing to retarget/);
    assert.match(stderr.text, /procureflow-other/);
  });

  test('--apply does not link when project add fails for a reason other than already exists', async () => {
    const calls = [];
    const { stderr } = captureStreams();
    const code = await runVercelCustomerCli({
      argv: ['--slug', 'acme', '--apply'],
      env: readyEnv(),
      cwd: '/tmp/unlinked-acme',
      stdout: captureStreams().stdout,
      stderr,
      existsSync: () => false,
      spawnFn(_command, args) {
        calls.push(args[0]);
        if (args[0] === 'whoami') return fakeChild({ stdout: 'operator\n' });
        if (args[0] === 'project') return fakeChild({ exitCode: 1, stderr: 'Not authorized\n' });
        throw new Error(`unexpected spawn ${args.join(' ')}`);
      }
    });
    assert.equal(code, 1);
    assert.deepEqual(calls, ['whoami', 'project']);
    assert.match(stderr.text, /Failed to create Vercel project/);
    assert.match(stderr.text, /does not connect GitHub/);
  });
});

describe('Production Ready wait', () => {
  test('parseInspectReadyState reads JSON readyState and plain-text status', () => {
    assert.equal(parseInspectReadyState(inspectJson('READY')), 'READY');
    assert.equal(parseInspectReadyState(inspectJson('BUILDING')), 'BUILDING');
    assert.equal(parseInspectReadyState(inspectJson('QUEUED')), 'QUEUED');
    assert.equal(parseInspectReadyState(inspectJson('INITIALIZING')), 'INITIALIZING');
    assert.equal(parseInspectReadyState(inspectJson('ERROR')), 'ERROR');
    assert.equal(parseInspectReadyState(inspectJson('CANCELED')), 'CANCELED');
    assert.equal(parseInspectReadyState('{"readyState":"CANCELLED"}'), 'CANCELED');
    assert.equal(parseInspectReadyState('  status\t● Ready\n  url\thttps://x.vercel.app\n'), 'READY');
    assert.equal(parseInspectReadyState('● Building'), 'BUILDING');
    assert.equal(parseInspectReadyState(''), null);
    assert.equal(parseInspectReadyState('not a deployment'), null);
  });

  test('pickDeploymentRef prefers the new deployment URL over the project alias', () => {
    assert.equal(
      pickDeploymentRef(
        'https://procureflow-acme.vercel.app\nhttps://procureflow-acme-abc123.vercel.app\n',
        { projectName: 'procureflow-acme' }
      ),
      'https://procureflow-acme-abc123.vercel.app'
    );
    assert.equal(
      pickDeploymentRef('https://procureflow-acme.vercel.app\n', { projectName: 'procureflow-acme' }),
      'https://procureflow-acme.vercel.app'
    );
    assert.equal(
      pickDeploymentRef(JSON.stringify({ id: 'dpl_new', url: 'procureflow-acme-abc123.vercel.app' })),
      'https://procureflow-acme-abc123.vercel.app'
    );
    assert.equal(pickDeploymentRef(''), null);
    assert.equal(resolveReadyTimeoutMs({}), DEFAULT_VERCEL_READY_TIMEOUT_MS);
    assert.equal(resolveReadyTimeoutMs({ VERCEL_READY_TIMEOUT_MS: '1000' }), 1000);
    assert.equal(resolveReadyTimeoutMs({ VERCEL_READY_TIMEOUT_MS: 'nope' }), DEFAULT_VERCEL_READY_TIMEOUT_MS);
  });

  test('waitForDeploymentReady returns immediately on READY and does not sleep', async () => {
    let slept = 0;
    const result = await waitForDeploymentReady({
      deploymentRef: 'https://procureflow-acme-abc123.vercel.app',
      timeoutMs: 1000,
      async inspect() {
        return { code: 0, stdout: inspectJson('READY'), stderr: '' };
      },
      async sleep() { slept += 1; }
    });
    assert.equal(result.ok, true);
    assert.equal(result.state, 'READY');
    assert.equal(slept, 0);
  });

  test('waitForDeploymentReady polls Building then Ready without a real delay', async () => {
    const states = ['BUILDING', 'READY'];
    const sleeps = [];
    let clock = 0;
    const result = await waitForDeploymentReady({
      deploymentRef: 'dpl_new',
      timeoutMs: 60_000,
      pollIntervalMs: 5000,
      now: () => clock,
      async sleep(ms) {
        sleeps.push(ms);
        clock += ms;
      },
      async inspect() {
        return { code: 0, stdout: inspectJson(states.shift()), stderr: '' };
      }
    });
    assert.equal(result.ok, true);
    assert.equal(result.state, 'READY');
    assert.deepEqual(sleeps, [5000]);
    assert.equal(clock, 5000);
  });

  test('waitForDeploymentReady fails on ERROR and CANCELED without further polls', async () => {
    for (const state of ['ERROR', 'CANCELED', 'BLOCKED']) {
      let calls = 0;
      let slept = 0;
      const result = await waitForDeploymentReady({
        deploymentRef: 'dpl_new',
        timeoutMs: 60_000,
        async inspect() {
          calls += 1;
          return { code: 1, stdout: inspectJson(state), stderr: 'build failed\n' };
        },
        async sleep() { slept += 1; }
      });
      assert.equal(result.ok, false);
      assert.equal(result.state, state);
      assert.equal(result.timedOut, false);
      assert.equal(calls, 1);
      assert.equal(slept, 0);
    }
  });

  test('waitForDeploymentReady times out while still Building using an injected clock', async () => {
    let clock = 10_000;
    let calls = 0;
    const result = await waitForDeploymentReady({
      deploymentRef: 'https://procureflow-acme-abc123.vercel.app',
      timeoutMs: 1000,
      pollIntervalMs: 5000,
      now: () => clock,
      async sleep(ms) { clock += ms; },
      async inspect() {
        calls += 1;
        return { code: 0, stdout: inspectJson('QUEUED'), stderr: '' };
      }
    });
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.state, 'QUEUED');
    assert.equal(calls, 1);
    assert.equal(clock, 11_000);
  });

  function linkedApplySpawn(states) {
    const queue = [...states];
    const calls = [];
    return {
      calls,
      spawnFn(_command, args) {
        calls.push([...args]);
        if (args[0] === 'whoami') return fakeChild({ stdout: 'operator\n' });
        if (args[0] === 'env') return fakeChild();
        if (args[0] === 'ls') {
          return fakeChild({
            stdout: JSON.stringify([{ uid: 'dpl_old', url: 'procureflow-acme-old.vercel.app' }])
          });
        }
        if (args[0] === 'redeploy') {
          return fakeChild({ stdout: 'https://procureflow-acme-abc123.vercel.app\n' });
        }
        if (args[0] === 'inspect') {
          const state = queue.shift() || 'BUILDING';
          return fakeChild({
            exitCode: state === 'ERROR' || state === 'CANCELED' ? 1 : 0,
            stdout: inspectJson(state),
            stderr: state === 'ERROR' ? 'Build failed\n' : ''
          });
        }
        throw new Error(`unexpected spawn ${args.join(' ')}`);
      }
    };
  }

  test('--apply waits through Building and returns only after Ready', async () => {
    const link = linkedProjectFs('procureflow-acme');
    const harness = linkedApplySpawn(['BUILDING', 'INITIALIZING', 'READY']);
    let clock = 0;
    const sleeps = [];
    const { stdout, stderr } = captureStreams();
    const code = await runVercelCustomerCli({
      argv: ['--slug', 'acme', '--apply'],
      env: { ...readyEnv(), VERCEL_READY_TIMEOUT_MS: '60000' },
      cwd: '/tmp/linked-acme',
      stdout,
      stderr,
      existsSync: link.existsSync,
      readFileSync: link.readFileSync,
      spawnFn: harness.spawnFn,
      pollIntervalMs: 1000,
      now: () => clock,
      async sleep(ms) {
        sleeps.push(ms);
        clock += ms;
      }
    });
    assert.equal(code, 0, stderr.text);
    const inspects = harness.calls.filter((args) => args[0] === 'inspect');
    assert.equal(inspects.length, 3);
    assert.deepEqual(inspects[0], [
      'inspect',
      'https://procureflow-acme-abc123.vercel.app',
      '--json'
    ]);
    const redeployAt = harness.calls.findIndex((args) => args[0] === 'redeploy');
    const firstInspect = harness.calls.findIndex((args) => args[0] === 'inspect');
    assert.ok(firstInspect > redeployAt);
    assert.deepEqual(sleeps, [1000, 1000]);
    assert.match(stdout.text, /is Ready/);
    assert.match(stdout.text, /customer env applied/);
    assert.doesNotMatch(stdout.text, /tok_test_secret_value/);
  });

  test('--apply exits non-zero when the deployment is ERROR', async () => {
    const link = linkedProjectFs('procureflow-acme');
    const harness = linkedApplySpawn(['ERROR']);
    const { stdout, stderr } = captureStreams();
    const code = await runVercelCustomerCli({
      argv: ['--slug', 'acme', '--apply'],
      env: readyEnv(),
      cwd: '/tmp/linked-acme',
      stdout,
      stderr,
      existsSync: link.existsSync,
      readFileSync: link.readFileSync,
      spawnFn: harness.spawnFn,
      async sleep() { throw new Error('should not sleep on ERROR'); }
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /is ERROR/);
    assert.match(stderr.text, /vercel redeploy/);
    assert.match(stderr.text, /Vercel dashboard/);
    assert.match(stderr.text, /Build failed/);
    assert.doesNotMatch(stdout.text, /customer env applied/);
    assert.equal(harness.calls.filter((args) => args[0] === 'inspect').length, 1);
  });

  test('--apply exits non-zero on Ready timeout and names the last state', async () => {
    const link = linkedProjectFs('procureflow-acme');
    const harness = linkedApplySpawn(['BUILDING', 'BUILDING']);
    let clock = 0;
    const { stdout, stderr } = captureStreams();
    const code = await runVercelCustomerCli({
      argv: ['--slug', 'acme', '--apply'],
      env: { ...readyEnv(), VERCEL_READY_TIMEOUT_MS: '1500' },
      cwd: '/tmp/linked-acme',
      stdout,
      stderr,
      existsSync: link.existsSync,
      readFileSync: link.readFileSync,
      spawnFn: harness.spawnFn,
      pollIntervalMs: 5000,
      now: () => clock,
      async sleep(ms) { clock += ms; }
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /Timed out after 2s/);
    assert.match(stderr.text, /last state: BUILDING/);
    assert.match(stderr.text, /vercel inspect/);
    assert.match(stderr.text, /vercel redeploy/);
    assert.match(stderr.text, /Vercel dashboard/);
    assert.doesNotMatch(stdout.text, /customer env applied/);
    assert.equal(harness.calls.filter((args) => args[0] === 'inspect').length, 1);
    assert.doesNotMatch(stderr.text, /tok_test_secret_value/);
  });
});

describe('helpers', () => {
  test('parseDeploymentTarget reads JSON and plain-text vercel.app URLs', () => {
    assert.deepEqual(
      parseDeploymentTarget(JSON.stringify([{ uid: 'dpl_1', url: 'foo.vercel.app' }])),
      { uid: 'dpl_1', url: 'https://foo.vercel.app' }
    );
    assert.equal(
      parseDeploymentTarget('  Age  https://beta-xyz.vercel.app  Ready  Production').url,
      'https://beta-xyz.vercel.app'
    );
    assert.equal(parseDeploymentTarget(''), null);
  });

  test('redactSecrets never leaves the token in operator output', () => {
    const env = readyEnv();
    assert.equal(
      redactSecrets(`token=${env.TURSO_AUTH_TOKEN}`, env),
      'token=$TURSO_AUTH_TOKEN'
    );
  });

  test('formatDryRunReport shape is stable enough for operators to copy', () => {
    const text = formatDryRunReport({
      slug: 'acme',
      projectName: 'procureflow-acme',
      env: readyEnv()
    });
    assert.match(text, /Production \+ Preview/);
    assert.match(text, /--apply/);
    assert.match(text, /Does not create a Turso database/);
    assert.match(text, /vercel inspect <new-deployment-url-or-id> --json/);
    assert.match(text, /Dry-run does not call Vercel/);
  });

  test('readLinkedProject and project-add reuse detection', () => {
    const linked = readLinkedProject('/tmp/customer', {
      existsSync: (file) => String(file).endsWith('project.json'),
      readFileSync: () => JSON.stringify({
        projectId: 'prj_1',
        orgId: 'team_1',
        projectName: 'ProcureFlow-Acme'
      })
    });
    assert.equal(linked.linked, true);
    assert.equal(linked.projectName, 'ProcureFlow-Acme');
    assert.equal(readLinkedProject('/tmp/missing', { existsSync: () => false }).linked, false);
    assert.equal(projectAddOk({ code: 0, stdout: '', stderr: '' }), true);
    assert.equal(projectAddOk({ code: 1, stdout: '', stderr: 'Project already exists' }), true);
    assert.equal(projectAddOk({ code: 1, stdout: '', stderr: 'Not authorized' }), false);
    assert.equal(parseProjectInspectName('{"name":"procureflow-acme"}'), 'procureflow-acme');
    assert.deepEqual(projectAddArgv('procureflow-acme'), ['project', 'add', 'procureflow-acme']);
    assert.deepEqual(projectLinkArgv('procureflow-acme'), ['link', '--yes', '--project', 'procureflow-acme']);
  });

  test('runProcess maps ENOENT to exit 127', async () => {
    const result = await runProcess('vercel', ['whoami'], {
      spawnFn() {
        const err = new Error('not found');
        err.code = 'ENOENT';
        throw err;
      }
    });
    assert.equal(result.code, 127);
  });
});

describe('npm script and docs pointer', () => {
  test('vercel:customer script is wired in package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['vercel:customer'], 'node server/scripts/vercel-customer.js');
    assert.ok(fs.existsSync(path.join(repoRoot, 'server/scripts/vercel-customer.js')));
    const envExample = fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
    assert.match(envExample, /vercel:customer/);
    const onboarding = fs.readFileSync(path.join(repoRoot, 'docs/CUSTOMER_ONBOARDING.md'), 'utf8');
    assert.match(onboarding, /npm run turso:customer/);
    assert.match(onboarding, /npm run vercel:customer/);
    assert.match(onboarding, /--apply/);
  });
});
