/**
 * Empty-customer provision: migrate schema, optionally org skeleton, optionally
 * first admin. Never seeds. Turso DB + token + SESSION_SECRET:
 * `npm run turso:customer`. Vercel Production+Preview env + redeploy:
 * `npm run vercel:customer`.
 */

import { runProvisionCli } from './provision.js';
import { runBootstrapAdminCli } from './bootstrapAdmin.js';
import { runBootstrapOrgCli } from './bootstrapOrg.js';

export const DEFAULT_SMOKE_BASE_URL = 'http://127.0.0.1:5000';

export const PROVISION_CUSTOMER_HELP = `ProcureFlow empty-customer provision (no demo seed)

Usage:
  npm run provision:customer -- [--email admin@customer.com --password '…'] [--with-org] [--turso]

  1. Apply schema (same as npm run db:migrate). Does NOT load demo data.
  2. If --with-org, insert default cost centers + FY budgets
     (same as npm run bootstrap-org). Idempotent; never wipes or renames.
  3. If --email and --password are set, create the first admin
     (same as npm run bootstrap-admin). Skipped when omitted.
  4. Print the smoke command. Start the app (or use the Vercel URL), then:

       BASE_URL=http://127.0.0.1:5000 npm run smoke

  Org skeleton only: npm run bootstrap-org
  Demo wipe (destructive, opt-in): npm run seed
  Never pass --seed to this command.

  Three tiers: empty schema (migrate) → org skeleton (bootstrap-org) →
  destructive demo (seed). Department heads are mapped later in
  Admin → Department Approvers after users exist.

Env (same as db:migrate / bootstrap-admin / bootstrap-org):
  TURSO_DATABASE_URL + TURSO_AUTH_TOKEN   Turso HTTP (both required together)
  PROCUREMENT_DB_PATH                     Local SQLite file
  SESSION_SECRET                          Customer / Vercel session cookie key

Preferred one-command: npm run onboard:customer -- --slug <customer> [--apply]
Turso DB + token + SESSION_SECRET: npm run turso:customer -- --slug <customer> [--apply]
Vercel env + redeploy: npm run vercel:customer -- --slug <customer> [--apply]
See docs/CUSTOMER_ONBOARDING.md and docs/DEPLOYMENT.md.
`;

function write(stream, text) {
  if (!stream) return;
  if (typeof stream.write === 'function') stream.write(text);
}

function takeFlagValue(argv, i, current) {
  const eq = current.indexOf('=');
  if (eq !== -1) {
    return { value: current.slice(eq + 1), nextIndex: i };
  }
  const next = argv[i + 1];
  if (!next || next.startsWith('--')) {
    return { value: true, nextIndex: i };
  }
  return { value: next, nextIndex: i + 1 };
}

export function parseCustomerProvisionArgs(argv = []) {
  const flags = new Set();
  const unknown = [];
  const values = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--seed') {
      flags.add('seed');
      continue;
    }
    if (arg === '--turso' || arg === '--require-turso') {
      flags.add('requireTurso');
      continue;
    }
    if (arg === '--with-org') {
      flags.add('withOrg');
      continue;
    }
    if (arg === '--json') {
      flags.add('json');
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      flags.add('help');
      continue;
    }
    if (arg === '--email' || arg.startsWith('--email=')
      || arg === '--password' || arg.startsWith('--password=')
      || arg === '--name' || arg.startsWith('--name=')
      || arg === '--title' || arg.startsWith('--title=')
      || arg === '--base-url' || arg.startsWith('--base-url=')) {
      const key = arg.replace(/^--/, '').split('=')[0].replace(/-/g, '');
      const mapped = {
        email: 'email',
        password: 'password',
        name: 'name',
        title: 'title',
        baseurl: 'baseUrl'
      }[key];
      const taken = takeFlagValue(argv, i, arg);
      values[mapped] = taken.value === true ? '' : taken.value;
      i = taken.nextIndex;
      continue;
    }
    unknown.push(arg);
  }

  return {
    seed: flags.has('seed'),
    requireTurso: flags.has('requireTurso'),
    withOrg: flags.has('withOrg'),
    json: flags.has('json'),
    help: flags.has('help'),
    email: values.email ? String(values.email).trim() : null,
    password: values.password != null && values.password !== '' ? String(values.password) : null,
    name: values.name ? String(values.name).trim() : null,
    title: values.title ? String(values.title).trim() : null,
    baseUrl: values.baseUrl ? String(values.baseUrl).trim() : null,
    unknown
  };
}

export function nextStepsText({
  bootstrapped = false,
  orgBootstrapped = false,
  baseUrl = DEFAULT_SMOKE_BASE_URL
} = {}) {
  const lines = [''];
  if (!bootstrapped) {
    lines.push(
      'Empty tenant: create the first admin next (UI at /login, or):',
      `  npm run bootstrap-admin -- --email admin@customer.com --password 'choose-a-long-password'`
    );
  } else {
    lines.push('First admin created. Sign in at /login with that email and password.');
  }
  if (orgBootstrapped) {
    lines.push(
      '',
      'Org skeleton is in place (default cost centers + FY budgets).',
      'Map department heads in Admin → Department Approvers after users exist.',
      'There is no create-department UI yet — bootstrap-org is the operator path.'
    );
  } else {
    lines.push(
      '',
      'Cost centers are still empty until you run the org skeleton (non-destructive):',
      '  npm run bootstrap-org',
      'Then map department heads in Admin → Department Approvers after users exist.'
    );
  }
  lines.push(
    '',
    'Verify the deploy (app must be running, or point at the Vercel URL):',
    `  BASE_URL=${baseUrl} npm run smoke`,
    '',
    'Do not run npm run seed against this customer unless you intend a demo wipe.'
  );
  return `${lines.join('\n')}\n`;
}

export async function runCustomerProvisionCli({
  argv = [],
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  runMigrateFn,
  runBootstrapFn,
  runOrgFn
} = {}) {
  const args = parseCustomerProvisionArgs(argv);
  if (args.help) {
    write(stdout, PROVISION_CUSTOMER_HELP);
    return 0;
  }
  if (args.seed) {
    write(
      stderr,
      'provision:customer never seeds. Real customer: migrate + bootstrap-admin.\n'
        + 'Demo wipe (destructive): npm run seed\n'
    );
    return 1;
  }
  if (args.unknown.length) {
    write(stderr, `Unknown argument: ${args.unknown[0]}\n${PROVISION_CUSTOMER_HELP}`);
    return 1;
  }
  if ((args.email && !args.password) || (!args.email && args.password)) {
    write(stderr, 'First-admin bootstrap requires both --email and --password.\n');
    return 1;
  }

  const migrateArgv = [];
  if (args.requireTurso) migrateArgv.push('--turso');
  if (args.json) migrateArgv.push('--json');

  const migrate = runMigrateFn || ((opts) => runProvisionCli({ command: 'migrate', ...opts }));
  const migrateCode = await migrate({
    argv: migrateArgv,
    env,
    stdout,
    stderr
  });
  if (migrateCode !== 0) return migrateCode;

  let orgBootstrapped = false;
  if (args.withOrg) {
    const orgArgv = [];
    if (args.requireTurso) orgArgv.push('--turso');
    if (args.json) orgArgv.push('--json');
    const bootstrapOrg = runOrgFn || runBootstrapOrgCli;
    const orgCode = await bootstrapOrg({
      argv: orgArgv,
      env,
      stdout,
      stderr,
      skipMigrate: true
    });
    if (orgCode !== 0) return orgCode;
    orgBootstrapped = true;
  }

  let bootstrapped = false;
  if (args.email && args.password) {
    const bootstrapArgv = ['--email', args.email, '--password', args.password];
    if (args.name) bootstrapArgv.push('--name', args.name);
    if (args.title) bootstrapArgv.push('--title', args.title);
    const bootstrap = runBootstrapFn || runBootstrapAdminCli;
    const bootCode = await bootstrap({
      argv: bootstrapArgv,
      env,
      stdout,
      stderr
    });
    if (bootCode !== 0) return bootCode;
    bootstrapped = true;
  }

  const baseUrl = args.baseUrl || String(env.BASE_URL || '').trim() || DEFAULT_SMOKE_BASE_URL;
  if (!args.json) {
    write(stdout, nextStepsText({ bootstrapped, orgBootstrapped, baseUrl }));
  }
  return 0;
}
