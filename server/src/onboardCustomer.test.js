import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WILL_MINT_PLACEHOLDER } from './tursoCustomer.js';
import { runVercelCustomerCli } from './vercelCustomer.js';
import {
  ONBOARD_CUSTOMER_HELP,
  buildOnboardJsonSummary,
  buildProvisionArgv,
  buildSmokeArgv,
  buildTursoArgv,
  buildVercelArgv,
  enrichEnvWithTursoExports,
  formatOnboardDryRun,
  parseOnboardCustomerArgs,
  resolveOnboardIdentity,
  runOnboardCustomerCli
} from './onboardCustomer.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function captureStreams() {
  const stdout = { text: '', write(chunk) { this.text += chunk; } };
  const stderr = { text: '', write(chunk) { this.text += chunk; } };
  return { stdout, stderr };
}

function fakeChild({
  exitCode = 0,
  stdout = '',
  stderr = ''
} = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() {} };
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', stdout);
    if (stderr) child.stderr.emit('data', stderr);
    child.emit('close', exitCode);
  });
  return child;
}

function vercelSpawn(calls) {
  return (_command, args) => {
    calls.push([...args]);
    if (args[0] === 'whoami') return fakeChild({ stdout: 'operator\n' });
    if (args[0] === 'project' && args[1] === 'add') return fakeChild({ stdout: 'added\n' });
    if (args[0] === 'link') return fakeChild({ stdout: 'linked\n' });
    if (args[0] === 'env') return fakeChild();
    if (args[0] === 'ls') {
      return fakeChild({
        stdout: JSON.stringify([{ uid: 'dpl_acme', url: 'procureflow-acme.vercel.app' }])
      });
    }
    if (args[0] === 'redeploy') return fakeChild({ stdout: 'https://procureflow-acme.vercel.app\n' });
    throw new Error(`unexpected spawn ${args.join(' ')}`);
  };
}

const MINTED = {
  TURSO_DATABASE_URL: 'libsql://procureflow-acme-org.turso.io',
  TURSO_AUTH_TOKEN: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.onboardTokenXYZ',
  SESSION_SECRET: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
};

describe('onboard:customer arg parsing', () => {
  test('parses slug, apply, email/password/name, org, smoke, json, and equals-form flags', () => {
    const args = parseOnboardCustomerArgs([
      '--slug', 'acme',
      '--db=procureflow-acme',
      '--project=procureflow-acme',
      '--apply',
      '--email', 'admin@acme.test',
      '--password', 'long-password',
      '--name', 'Ada Admin',
      '--with-org',
      '--smoke',
      '--base-url=https://acme.example.com',
      '--json'
    ]);
    assert.equal(args.slug, 'acme');
    assert.equal(args.db, 'procureflow-acme');
    assert.equal(args.project, 'procureflow-acme');
    assert.equal(args.apply, true);
    assert.equal(args.dryRun, false);
    assert.equal(args.email, 'admin@acme.test');
    assert.equal(args.password, 'long-password');
    assert.equal(args.name, 'Ada Admin');
    assert.equal(args.withOrg, true);
    assert.equal(args.smoke, true);
    assert.equal(args.baseUrl, 'https://acme.example.com');
    assert.equal(args.json, true);
  });

  test('dry-run is the default; --with-org is on unless --no-org', () => {
    const dry = parseOnboardCustomerArgs(['--slug', 'acme']);
    assert.equal(dry.apply, false);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.withOrg, true);
    assert.equal(dry.noOrg, false);
    assert.equal(dry.smoke, false);

    const skipped = parseOnboardCustomerArgs(['--slug', 'acme', '--no-org']);
    assert.equal(skipped.withOrg, false);
    assert.equal(skipped.noOrg, true);
  });

  test('unknown flags are collected; --seed and --tursodb are tracked', () => {
    const args = parseOnboardCustomerArgs(['--slug', 'acme', '--wipe', '--seed', '--tursodb']);
    assert.deepEqual(args.unknown, ['--wipe']);
    assert.equal(args.seed, true);
    assert.equal(args.tursodb, true);
  });

  test('child argv builders pass slug/db/project and default --with-org', () => {
    assert.deepEqual(buildTursoArgv({ slug: 'acme', db: 'procureflow-acme' }), [
      '--slug', 'acme', '--apply', '--db', 'procureflow-acme'
    ]);
    assert.deepEqual(buildVercelArgv({ slug: 'acme', project: 'procureflow-acme' }), [
      '--slug', 'acme', '--apply', '--project', 'procureflow-acme'
    ]);
    assert.deepEqual(buildProvisionArgv({
      withOrg: true,
      email: 'ada@acme.test',
      password: 'secret',
      name: 'Ada'
    }), [
      '--with-org', '--email', 'ada@acme.test', '--password', 'secret', '--name', 'Ada'
    ]);
    assert.deepEqual(buildProvisionArgv({ withOrg: false }), []);
    assert.deepEqual(buildSmokeArgv({
      baseUrl: 'https://procureflow-acme.vercel.app',
      email: 'ada@acme.test',
      password: 'secret'
    }), [
      '--base-url', 'https://procureflow-acme.vercel.app',
      '--email', 'ada@acme.test',
      '--password', 'secret'
    ]);
  });

  test('resolveOnboardIdentity prefers --project / --base-url overrides', () => {
    assert.deepEqual(resolveOnboardIdentity({ slug: 'Acme' }), {
      error: null,
      slug: 'acme',
      dbName: 'procureflow-acme',
      projectName: 'procureflow-acme',
      baseUrl: 'https://procureflow-acme.vercel.app'
    });
    assert.equal(
      resolveOnboardIdentity({ slug: 'acme', project: 'pf-acme-prod' }).projectName,
      'pf-acme-prod'
    );
    assert.equal(
      resolveOnboardIdentity({ slug: 'acme', baseUrl: 'https://acme.example.com' }).baseUrl,
      'https://acme.example.com'
    );
    assert.equal(resolveOnboardIdentity({}).error, 'slug-required');
  });
});

describe('onboard:customer helpers', () => {
  test('dry-run report uses placeholders and points at the orchestrator', () => {
    const text = formatOnboardDryRun({
      slug: 'acme',
      dbName: 'procureflow-acme',
      projectName: 'procureflow-acme',
      baseUrl: 'https://procureflow-acme.vercel.app',
      env: {}
    });
    assert.match(text, /dry-run — no Turso\/Vercel\/DB mutation/);
    assert.match(text, /procureflow-acme/);
    assert.match(text, /will mint on --apply/);
    assert.match(text, /--with-org is default/);
    assert.match(text, /npm run onboard:customer -- --slug acme --apply/);
    assert.match(text, /never --tursodb|Never invents Turso/);
    assert.doesNotMatch(text, /eyJ/);
  });

  test('JSON dry-run never includes a real token', () => {
    const json = buildOnboardJsonSummary({
      mode: 'dry-run',
      slug: 'acme',
      dbName: 'procureflow-acme',
      projectName: 'procureflow-acme',
      baseUrl: 'https://procureflow-acme.vercel.app',
      withOrg: true,
      smoke: false
    });
    assert.equal(json.ok, true);
    assert.equal(json.tursoAuthToken, WILL_MINT_PLACEHOLDER);
    assert.equal(json.tursoDatabaseUrl, WILL_MINT_PLACEHOLDER);
    assert.equal(json.withOrg, true);
  });

  test('enrichEnvWithTursoExports copies minted secrets over empty env', () => {
    const next = enrichEnvWithTursoExports({}, MINTED);
    assert.equal(next.TURSO_DATABASE_URL, MINTED.TURSO_DATABASE_URL);
    assert.equal(next.TURSO_AUTH_TOKEN, MINTED.TURSO_AUTH_TOKEN);
    assert.equal(next.SESSION_SECRET, MINTED.SESSION_SECRET);
  });
});

describe('onboard:customer CLI (no live network)', () => {
  test('--help documents dry-run vs apply and does not call child CLIs', async () => {
    let called = false;
    const { stdout, stderr } = captureStreams();
    const code = await runOnboardCustomerCli({
      argv: ['--help'],
      stdout,
      stderr,
      async runTursoFn() { called = true; return 0; },
      async runVercelFn() { called = true; return 0; },
      async runProvisionFn() { called = true; return 0; }
    });
    assert.equal(code, 0);
    assert.equal(called, false);
    assert.equal(stdout.text, ONBOARD_CUSTOMER_HELP);
    assert.match(stdout.text, /--dry-run/);
    assert.match(stdout.text, /--apply/);
    assert.match(stdout.text, /--with-org/);
    assert.match(stdout.text, /--no-org/);
    assert.match(stdout.text, /--smoke/);
    assert.match(stdout.text, /never seeds|Never seeds/i);
  });

  test('refuses missing --slug without calling children', async () => {
    let called = false;
    const { stderr } = captureStreams();
    const code = await runOnboardCustomerCli({
      argv: [],
      stdout: captureStreams().stdout,
      stderr,
      async runTursoFn() { called = true; return 0; }
    });
    assert.equal(code, 1);
    assert.equal(called, false);
    assert.match(stderr.text, /--slug is required/);
  });

  test('--seed is refused and children are not called', async () => {
    let called = false;
    const { stderr } = captureStreams();
    const code = await runOnboardCustomerCli({
      argv: ['--slug', 'acme', '--seed'],
      stdout: captureStreams().stdout,
      stderr,
      async runTursoFn() { called = true; return 0; },
      async runVercelFn() { called = true; return 0; },
      async runProvisionFn() { called = true; return 0; }
    });
    assert.equal(code, 1);
    assert.equal(called, false);
    assert.match(stderr.text, /never seeds/);
  });

  test('--tursodb is refused', async () => {
    const { stderr } = captureStreams();
    const code = await runOnboardCustomerCli({
      argv: ['--slug', 'acme', '--tursodb'],
      stdout: captureStreams().stdout,
      stderr,
      async runTursoFn() { throw new Error('should not call turso'); }
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /never passes --tursodb/);
  });

  test('refuses --apply together with --dry-run', async () => {
    const { stderr } = captureStreams();
    const code = await runOnboardCustomerCli({
      argv: ['--slug', 'acme', '--apply', '--dry-run'],
      stdout: captureStreams().stdout,
      stderr,
      async runTursoFn() { throw new Error('should not call turso'); }
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /not both/);
  });

  test('dry-run prints the full plan without calling children or inventing secrets', async () => {
    let called = false;
    const { stdout, stderr } = captureStreams();
    const code = await runOnboardCustomerCli({
      argv: ['--slug', 'acme'],
      env: {},
      stdout,
      stderr,
      async runTursoFn() { called = true; return 0; },
      async runVercelFn() { called = true; return 0; },
      async runProvisionFn() { called = true; return 0; },
      async runSmokeFn() { called = true; return 0; }
    });
    assert.equal(code, 0, stderr.text);
    assert.equal(called, false);
    assert.match(stdout.text, /dry-run — no Turso\/Vercel\/DB mutation/);
    assert.match(stdout.text, /Customer slug:  acme/);
    assert.match(stdout.text, /Database name:  procureflow-acme/);
    assert.match(stdout.text, /Vercel project: procureflow-acme/);
    assert.match(stdout.text, /turso db create procureflow-acme/);
    assert.match(stdout.text, /vercel project add procureflow-acme/);
    assert.match(stdout.text, /vercel link --yes --project procureflow-acme/);
    assert.match(stdout.text, /does not connect GitHub/);
    assert.match(stdout.text, /vercel env add TURSO_DATABASE_URL production/);
    assert.match(stdout.text, /provision:customer -- --with-org/);
    assert.match(stdout.text, /skip \(pass --smoke/);
    assert.match(stdout.text, /will mint on --apply/);
    assert.doesNotMatch(stdout.text, /eyJhbGci/);
    assert.doesNotMatch(stdout.text, /libsql:\/\/procureflow-acme-org/);
  });

  test('dry-run --json includes placeholders and no full secrets', async () => {
    const { stdout, stderr } = captureStreams();
    const code = await runOnboardCustomerCli({
      argv: ['--slug', 'acme', '--json'],
      env: {},
      stdout,
      stderr,
      async runTursoFn() { throw new Error('should not call turso'); }
    });
    assert.equal(code, 0, stderr.text);
    const json = JSON.parse(stdout.text.slice(stdout.text.lastIndexOf('{')));
    assert.equal(json.mode, 'dry-run');
    assert.equal(json.slug, 'acme');
    assert.equal(json.tursoAuthToken, WILL_MINT_PLACEHOLDER);
    assert.equal(json.withOrg, true);
  });

  test('--apply stubs the three CLIs and passes minted secrets into vercel/provision', async () => {
    const calls = { turso: null, vercel: null, provision: null, smoke: null };
    const { stdout, stderr } = captureStreams();
    const code = await runOnboardCustomerCli({
      argv: [
        '--slug', 'acme',
        '--apply',
        '--email', 'admin@acme.test',
        '--password', 'choose-a-long-password',
        '--name', 'Ada Admin'
      ],
      env: {},
      stdout,
      stderr,
      async runTursoFn(opts) {
        calls.turso = opts;
        assert.equal(opts.returnResult, true);
        assert.ok(opts.argv.includes('--slug'));
        assert.ok(opts.argv.includes('acme'));
        assert.ok(opts.argv.includes('--apply'));
        return { code: 0, exports: MINTED };
      },
      async runVercelFn(opts) {
        calls.vercel = opts;
        assert.equal(opts.env.TURSO_DATABASE_URL, MINTED.TURSO_DATABASE_URL);
        assert.equal(opts.env.TURSO_AUTH_TOKEN, MINTED.TURSO_AUTH_TOKEN);
        assert.equal(opts.env.SESSION_SECRET, MINTED.SESSION_SECRET);
        assert.ok(opts.argv.includes('--apply'));
        assert.ok(opts.argv.includes('--slug'));
        return 0;
      },
      async runProvisionFn(opts) {
        calls.provision = opts;
        assert.equal(opts.env.TURSO_DATABASE_URL, MINTED.TURSO_DATABASE_URL);
        assert.equal(opts.env.TURSO_AUTH_TOKEN, MINTED.TURSO_AUTH_TOKEN);
        assert.equal(opts.env.SESSION_SECRET, MINTED.SESSION_SECRET);
        assert.ok(opts.argv.includes('--with-org'));
        assert.deepEqual(opts.argv.slice(opts.argv.indexOf('--email'), opts.argv.indexOf('--email') + 2), [
          '--email', 'admin@acme.test'
        ]);
        assert.ok(opts.argv.includes('Ada Admin'));
        assert.equal(opts.argv.includes('--seed'), false);
        return 0;
      },
      async runSmokeFn() {
        calls.smoke = true;
        return 0;
      }
    });
    assert.equal(code, 0, stderr.text);
    assert.ok(calls.turso);
    assert.ok(calls.vercel);
    assert.ok(calls.provision);
    assert.equal(calls.smoke, null);
    assert.match(stdout.text, /Onboarding acme/);
    assert.match(stdout.text, /customer onboard applied/);
    assert.doesNotMatch(stdout.text, /DEMO_PERSONA_SWITCHER set/);
  });

  test('--apply --no-org skips the org skeleton and --db/--project pass through', async () => {
    const calls = { turso: null, vercel: null, provision: null };
    const code = await runOnboardCustomerCli({
      argv: [
        '--slug', 'acme',
        '--db', 'pf-acme-prod',
        '--project', 'pf-acme-prod',
        '--apply',
        '--no-org'
      ],
      env: {},
      stdout: captureStreams().stdout,
      stderr: captureStreams().stderr,
      async runTursoFn(opts) {
        calls.turso = opts;
        assert.ok(opts.argv.includes('pf-acme-prod'));
        return { code: 0, exports: MINTED };
      },
      async runVercelFn(opts) {
        calls.vercel = opts;
        assert.ok(opts.argv.includes('pf-acme-prod'));
        return 0;
      },
      async runProvisionFn(opts) {
        calls.provision = opts;
        assert.equal(opts.argv.includes('--with-org'), false);
        return 0;
      }
    });
    assert.equal(code, 0);
    assert.ok(calls.turso && calls.vercel && calls.provision);
  });

  test('--apply --smoke runs smoke against the suggested BASE_URL', async () => {
    let smokeOpts = null;
    const code = await runOnboardCustomerCli({
      argv: [
        '--slug', 'acme',
        '--apply',
        '--email', 'admin@acme.test',
        '--password', 'choose-a-long-password',
        '--smoke'
      ],
      env: {},
      stdout: captureStreams().stdout,
      stderr: captureStreams().stderr,
      async runTursoFn() { return { code: 0, exports: MINTED }; },
      async runVercelFn() { return 0; },
      async runProvisionFn() { return 0; },
      async runSmokeFn(opts) {
        smokeOpts = opts;
        return 0;
      }
    });
    assert.equal(code, 0);
    assert.ok(smokeOpts);
    assert.ok(smokeOpts.argv.includes('https://procureflow-acme.vercel.app'));
    assert.equal(smokeOpts.env.BASE_URL, 'https://procureflow-acme.vercel.app');
    assert.equal(smokeOpts.env.TURSO_AUTH_TOKEN, MINTED.TURSO_AUTH_TOKEN);
  });

  test('--apply stops after Vercel when ensure fails closed; provision is not called', async () => {
    let provisioned = false;
    const calls = [];
    const { stderr } = captureStreams();
    const code = await runOnboardCustomerCli({
      argv: ['--slug', 'acme', '--apply', '--email', 'a@acme.test', '--password', 'long-password'],
      env: {},
      cwd: '/tmp/linked-other',
      stdout: captureStreams().stdout,
      stderr,
      existsSync: (file) => String(file).endsWith(`${path.sep}.vercel${path.sep}project.json`),
      readFileSync: () => JSON.stringify({
        projectId: 'prj_other',
        orgId: 'team_other',
        projectName: 'procureflow-other'
      }),
      spawnFn(_command, args) {
        calls.push([...args]);
        if (args[0] === 'whoami') return fakeChild({ stdout: 'operator\n' });
        throw new Error(`unexpected spawn ${args.join(' ')}`);
      },
      async runTursoFn() {
        calls.push(['turso:customer']);
        return { code: 0, exports: MINTED };
      },
      runVercelFn: runVercelCustomerCli,
      async runProvisionFn() {
        provisioned = true;
        return 0;
      }
    });
    assert.equal(code, 1);
    assert.equal(provisioned, false);
    assert.deepEqual(calls[0], ['turso:customer']);
    assert.deepEqual(calls[1], ['whoami']);
    assert.equal(calls.some((args) => args[0] === 'project' || args[0] === 'link' || args[0] === 'env'), false);
    assert.match(stderr.text, /stopped at Vercel/);
    assert.match(stderr.text, /Refusing to retarget/);
    assert.match(stderr.text, /procureflow-other/);
    assert.doesNotMatch(stderr.text, /never creates Vercel projects/);
  });

  test('--apply unlinked path orders Turso, project add, link, env, then provision', async () => {
    const calls = [];
    let provisioned = false;
    const { stdout, stderr } = captureStreams();
    const code = await runOnboardCustomerCli({
      argv: ['--slug', 'acme', '--apply'],
      env: {},
      cwd: '/tmp/unlinked-acme',
      stdout,
      stderr,
      existsSync: () => false,
      spawnFn: vercelSpawn(calls),
      async runTursoFn() {
        calls.push(['turso:customer']);
        return { code: 0, exports: MINTED };
      },
      runVercelFn: runVercelCustomerCli,
      async runProvisionFn() {
        provisioned = true;
        calls.push(['provision']);
        return 0;
      }
    });
    assert.equal(code, 0, stderr.text);
    assert.equal(provisioned, true);
    const labels = calls.map((args) => {
      if (args[0] === 'turso:customer') return 'turso';
      if (args[0] === 'whoami') return 'whoami';
      if (args[0] === 'project') return 'project-add';
      if (args[0] === 'link') return 'link';
      if (args[0] === 'env') return 'env';
      if (args[0] === 'redeploy') return 'redeploy';
      if (args[0] === 'provision') return 'provision';
      return args[0];
    });
    assert.equal(labels[0], 'turso');
    assert.ok(labels.indexOf('whoami') > labels.indexOf('turso'));
    assert.ok(labels.indexOf('project-add') > labels.indexOf('whoami'));
    assert.ok(labels.indexOf('link') > labels.indexOf('project-add'));
    assert.ok(labels.indexOf('env') > labels.indexOf('link'));
    assert.ok(labels.indexOf('redeploy') > labels.indexOf('env'));
    assert.ok(labels.indexOf('provision') > labels.indexOf('redeploy'));
    assert.match(stdout.text, /Onboarding acme \(Turso → Vercel project → env → provision/);
    assert.equal(stdout.text.includes(MINTED.TURSO_AUTH_TOKEN), false);
  });

  test('--apply already linked to the expected project skips create and link', async () => {
    const calls = [];
    const { stderr } = captureStreams();
    const code = await runOnboardCustomerCli({
      argv: ['--slug', 'acme', '--apply'],
      env: {},
      cwd: '/tmp/linked-acme',
      stdout: captureStreams().stdout,
      stderr,
      existsSync: (file) => String(file).endsWith(`${path.sep}.vercel${path.sep}project.json`),
      readFileSync: () => JSON.stringify({
        projectId: 'prj_acme',
        orgId: 'team_acme',
        projectName: 'procureflow-acme'
      }),
      spawnFn: vercelSpawn(calls),
      async runTursoFn() { return { code: 0, exports: MINTED }; },
      runVercelFn: runVercelCustomerCli,
      async runProvisionFn() { return 0; }
    });
    assert.equal(code, 0, stderr.text);
    assert.equal(calls.some((args) => args[0] === 'project' || args[0] === 'link'), false);
    assert.equal(calls.some((args) => args[0] === 'env'), true);
  });

  test('--apply --json redacts token and session secret', async () => {
    const { stdout, stderr } = captureStreams();
    const code = await runOnboardCustomerCli({
      argv: ['--slug', 'acme', '--apply', '--json'],
      env: {},
      stdout,
      stderr,
      async runTursoFn() { return { code: 0, exports: MINTED }; },
      async runVercelFn() { return 0; },
      async runProvisionFn() { return 0; }
    });
    assert.equal(code, 0, stderr.text);
    const json = JSON.parse(stdout.text.slice(stdout.text.lastIndexOf('{')));
    assert.equal(json.mode, 'apply');
    assert.equal(json.tursoAuthToken, `…${MINTED.TURSO_AUTH_TOKEN.slice(-4)}`);
    assert.equal(json.sessionSecret, `…${MINTED.SESSION_SECRET.slice(-4)}`);
    assert.doesNotMatch(JSON.stringify(json), new RegExp(MINTED.TURSO_AUTH_TOKEN));
    assert.doesNotMatch(JSON.stringify(json), new RegExp(MINTED.SESSION_SECRET));
  });

  test('email without password is refused before any child runs', async () => {
    let called = false;
    const { stderr } = captureStreams();
    const code = await runOnboardCustomerCli({
      argv: ['--slug', 'acme', '--apply', '--email', 'admin@acme.test'],
      stdout: captureStreams().stdout,
      stderr,
      async runTursoFn() { called = true; return 0; }
    });
    assert.equal(code, 1);
    assert.equal(called, false);
    assert.match(stderr.text, /both --email and --password/);
  });
});

describe('npm script and docs pointer', () => {
  test('onboard:customer script is wired and docs prefer it', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['onboard:customer'], 'node server/scripts/onboard-customer.js');
    assert.ok(fs.existsSync(path.join(repoRoot, 'server/scripts/onboard-customer.js')));

    const serverPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'server/package.json'), 'utf8'));
    assert.equal(serverPkg.scripts['onboard:customer'], 'node scripts/onboard-customer.js');

    const onboarding = fs.readFileSync(path.join(repoRoot, 'docs/CUSTOMER_ONBOARDING.md'), 'utf8');
    assert.match(onboarding, /npm run onboard:customer/);
    assert.ok(
      onboarding.indexOf('npm run onboard:customer') < onboarding.indexOf('npm run turso:customer'),
      'onboarding happy path should mention onboard:customer before the stepped turso:customer path'
    );

    const deployment = fs.readFileSync(path.join(repoRoot, 'docs/DEPLOYMENT.md'), 'utf8');
    assert.match(deployment, /npm run onboard:customer/);

    const manual = fs.readFileSync(path.join(repoRoot, 'docs/SYSTEM_MANUAL.md'), 'utf8');
    assert.match(manual, /npm run onboard:customer/);

    const checklist = fs.readFileSync(path.join(repoRoot, 'scripts/provision-customer.md'), 'utf8');
    assert.match(checklist, /npm run onboard:customer/);

    const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
    assert.match(readme, /npm run onboard:customer/);
  });
});
