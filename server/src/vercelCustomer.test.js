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
  parseVercelCustomerArgs,
  redactSecrets,
  runProcess,
  runVercelCustomerCli,
  suggestedBaseUrl
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
    assert.match(stdout.text, /vercel redeploy <latest-production-deployment> --yes/);
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

  test('--apply guides the operator when the project is not linked', async () => {
    const { stderr } = captureStreams();
    const code = await runVercelCustomerCli({
      argv: ['--slug', 'acme', '--apply'],
      env: readyEnv(),
      cwd: '/tmp',
      stdout: captureStreams().stdout,
      stderr,
      existsSync: () => false,
      spawnFn(_cmd, args) {
        if (args[0] === 'whoami') return fakeChild({ stdout: 'operator\n' });
        throw new Error(`unexpected spawn ${args.join(' ')}`);
      }
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /not linked/);
    assert.match(stderr.text, /vercel link --yes --project procureflow-acme/);
    assert.match(stderr.text, /does not create Vercel projects/);
  });

  test('--apply upserts Production+Preview env, redeploys, and never prints secrets', async () => {
    const env = readyEnv();
    const calls = [];
    const stdinValues = [];
    const { stdout, stderr } = captureStreams();
    const code = await runVercelCustomerCli({
      argv: ['--slug', 'acme', '--apply'],
      env,
      cwd: '/tmp/linked-acme',
      stdout,
      stderr,
      existsSync: (file) => file.endsWith(path.join('.vercel', 'project.json')),
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
          return fakeChild({ stdout: 'https://procureflow-acme.vercel.app\n', onStdin });
        }
        throw new Error(`unexpected spawn ${args.join(' ')}`);
      }
    });
    assert.equal(code, 0, stderr.text);
    assert.equal(calls[0].command, 'vercel');
    assert.deepEqual(calls[0].args, ['whoami']);
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
    const { stdout, stderr } = captureStreams();
    const code = await runVercelCustomerCli({
      argv: ['--slug', 'acme', '--apply'],
      env: readyEnv(),
      cwd: '/tmp/linked-acme',
      stdout,
      stderr,
      existsSync: () => true,
      spawnFn(_command, args) {
        calls.push(args[0]);
        if (args[0] === 'whoami') return fakeChild({ stdout: 'operator\n' });
        if (args[0] === 'env') return fakeChild();
        if (args[0] === 'ls') return fakeChild({ stdout: 'No deployments found.\n' });
        if (args[0] === 'deploy') return fakeChild({ stdout: 'https://procureflow-acme.vercel.app\n' });
        throw new Error(`unexpected spawn ${args.join(' ')}`);
      }
    });
    assert.equal(code, 0, stderr.text);
    assert.equal(calls.includes('redeploy'), false);
    assert.equal(calls.includes('deploy'), true);
    assert.match(stdout.text, /No production deployment found/);
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
