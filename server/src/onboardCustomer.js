/**
 * One-command customer onboard: Turso DB + Vercel env + empty-tenant provision.
 *
 * Dry-run by default (no Turso/Vercel/DB mutation, no invented secrets).
 * --apply reuses runTursoCustomerCli / runVercelCustomerCli /
 * runCustomerProvisionCli in-process (does not shell out to npm run).
 *
 * Isolation stays one Turso DB + one Vercel project per customer (not org_id).
 * Never seeds. Never invents Turso URL/token. Never sets DEMO_PERSONA_SWITCHER.
 * Never destroys a Turso DB. Ensures the Vercel project and links this checkout
 * before env push. Does not connect GitHub auto-deploy.
 *
 *   npm run onboard:customer -- --slug acme
 *   npm run onboard:customer -- --slug acme --apply --email admin@acme.test --password '…'
 */

import { runSmokeCli } from './smoke.js';
import { runCustomerProvisionCli } from './provisionCustomer.js';
import {
  CUSTOMER_ENV_KEYS,
  VERCEL_GITHUB_LIMIT,
  buildApplyPlan,
  defaultProjectName,
  plannedEnsureCommands,
  suggestedBaseUrl,
  runVercelCustomerCli
} from './vercelCustomer.js';
import {
  WILL_MINT_PLACEHOLDER,
  defaultDatabaseName,
  plannedTursoCommands,
  redactSecretTail,
  resolveCustomerIdentity,
  runTursoCustomerCli,
  tursoCustomerCliCode,
  tursoCustomerExports
} from './tursoCustomer.js';

export const ONBOARD_CUSTOMER_HELP = `ProcureFlow customer onboard (Turso + Vercel + provision)

Usage:
  npm run onboard:customer -- --slug acme
  npm run onboard:customer -- --slug acme --dry-run
  npm run onboard:customer -- --slug acme --apply --email admin@acme.test --password '…'
  npm run onboard:customer -- --slug acme --apply --email admin@acme.test --password '…' --name "Ada Admin" --with-org --smoke

  --slug <customer>     Required. Default DB/project is procureflow-<slug>.
  --db <name>           Override Turso database name (passed to turso:customer).
  --project <name>      Override Vercel project name (passed to vercel:customer).
  --dry-run             Print the full planned sequence (default). Exit 0.
                        Never calls Turso/Vercel/DB. Does not invent secrets.
  --apply               Run Turso → ensure Vercel project + link → env push,
                        redeploy, and wait until Production is Ready → provision
                        in-process. Secrets minted by Turso are passed to later
                        steps without copying export lines by hand. vercel:customer
                        returns only after Production is Ready (or a timeout/error).
  --email / --password  First admin (both required together). Optional.
  --name <display>      First-admin display name (optional with --email).
  --with-org            Include cost centers + FY budgets (DEFAULT ON here;
                        provision:customer still requires the flag).
  --no-org              Skip the org skeleton (schema + optional admin only).
  --smoke               After provision, hit BASE_URL (default
                        https://procureflow-<slug>.vercel.app). Preferred on
                        the same --apply command: that command waits for
                        Production Ready before it returns, so smoke is not
                        racing a still-building hostname.
  --base-url <url>      Override smoke / provision next-step URL.
  --json                Machine summary. Tokens redacted to last 4 chars.
                        Full Turso export lines may still appear on human
                        stdout from turso:customer --apply.
  --help, -h            Show this help

Refuses --seed and --tursodb. Never seeds.
Never invents Turso URL/token, never sets DEMO_PERSONA_SWITCHER, never
destroys a Turso DB.
On --apply, vercel:customer creates the project if missing
(vercel project add; idempotent if it exists) and links this directory
(vercel link --yes --project …). Already linked to that name: skip.
Linked to a different project: stop (does not retarget).

${VERCEL_GITHUB_LIMIT}
Uses the Vercel CLI's current team (vercel switch if you have more than one).

Happy path:
  1. npm run onboard:customer -- --slug <slug>
  2. npm run onboard:customer -- --slug <slug> --apply --email … --password … --smoke
     (--apply waits for Production Ready before smoke runs.
      GitHub auto-deploy is still a dashboard connection.)

Stepped (same sequence, secrets copied by hand):
  turso:customer --apply → vercel:customer --apply (ensure + link + env)
  → provision:customer -- --with-org → smoke

See docs/DEPLOY_MANUAL.md. docs/CUSTOMER_ONBOARDING.md and docs/DEPLOYMENT.md point there.
`;

function write(stream, text) {
  if (!stream) return;
  if (typeof stream.write === 'function') stream.write(text);
}

function asTrimmed(value) {
  return value == null ? '' : String(value).trim();
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

export function parseOnboardCustomerArgs(argv = []) {
  const flags = new Set();
  const unknown = [];
  const values = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      flags.add('help');
      continue;
    }
    if (arg === '--dry-run' || arg === '--dryrun') {
      flags.add('dryRun');
      continue;
    }
    if (arg === '--apply') {
      flags.add('apply');
      continue;
    }
    if (arg === '--seed') {
      flags.add('seed');
      continue;
    }
    if (arg === '--json') {
      flags.add('json');
      continue;
    }
    if (arg === '--tursodb' || arg.startsWith('--tursodb=')) {
      flags.add('tursodb');
      continue;
    }
    if (arg === '--smoke') {
      flags.add('smoke');
      continue;
    }
    if (arg === '--with-org') {
      flags.add('withOrg');
      continue;
    }
    if (arg === '--no-org' || arg === '--no-with-org') {
      flags.add('noOrg');
      continue;
    }
    if (
      arg === '--slug' || arg.startsWith('--slug=')
      || arg === '--db' || arg.startsWith('--db=')
      || arg === '--project' || arg.startsWith('--project=')
      || arg === '--email' || arg.startsWith('--email=')
      || arg === '--password' || arg.startsWith('--password=')
      || arg === '--name' || arg.startsWith('--name=')
      || arg === '--base-url' || arg.startsWith('--base-url=')
    ) {
      const rawKey = arg.replace(/^--/, '').split('=')[0];
      const key = rawKey === 'base-url' ? 'baseUrl' : rawKey;
      const taken = takeFlagValue(argv, i, arg);
      values[key] = taken.value === true ? '' : taken.value;
      i = taken.nextIndex;
      continue;
    }
    unknown.push(arg);
  }

  const apply = flags.has('apply');
  const noOrg = flags.has('noOrg');
  return {
    help: flags.has('help'),
    apply,
    dryRun: !apply,
    dryRunFlag: flags.has('dryRun'),
    seed: flags.has('seed'),
    json: flags.has('json'),
    tursodb: flags.has('tursodb'),
    smoke: flags.has('smoke'),
    withOrg: !noOrg,
    withOrgFlag: flags.has('withOrg'),
    noOrg,
    slug: values.slug != null ? String(values.slug).trim() : null,
    db: values.db != null ? String(values.db).trim() : null,
    project: values.project != null ? String(values.project).trim() : null,
    email: values.email != null ? String(values.email).trim() : null,
    password: values.password != null && values.password !== '' ? String(values.password) : null,
    name: values.name != null ? String(values.name).trim() : null,
    baseUrl: values.baseUrl != null ? String(values.baseUrl).trim() : null,
    unknown
  };
}

export function resolveOnboardIdentity({ slug, db, project, baseUrl } = {}) {
  const identity = resolveCustomerIdentity({ slug, db });
  if (identity.error) return identity;
  const projectName = asTrimmed(project) || identity.projectName;
  const resolvedBase = asTrimmed(baseUrl) || suggestedBaseUrl(projectName);
  return {
    ...identity,
    projectName,
    baseUrl: resolvedBase
  };
}

export function buildTursoArgv({ slug, db } = {}) {
  const argv = ['--slug', slug, '--apply'];
  if (asTrimmed(db)) argv.push('--db', asTrimmed(db));
  return argv;
}

export function buildVercelArgv({ slug, project } = {}) {
  const argv = ['--slug', slug, '--apply'];
  if (asTrimmed(project)) argv.push('--project', asTrimmed(project));
  return argv;
}

export function buildProvisionArgv({
  withOrg = true,
  email = null,
  password = null,
  name = null,
  baseUrl = null
} = {}) {
  const argv = [];
  if (withOrg) argv.push('--with-org');
  if (email) argv.push('--email', email);
  if (password) argv.push('--password', password);
  if (name) argv.push('--name', name);
  if (baseUrl) argv.push('--base-url', baseUrl);
  return argv;
}

export function buildSmokeArgv({
  baseUrl,
  email = null,
  password = null
} = {}) {
  const argv = [];
  if (baseUrl) argv.push('--base-url', baseUrl);
  if (email && password) {
    argv.push('--email', email, '--password', password);
  }
  return argv;
}

export function enrichEnvWithTursoExports(env = {}, exports = null) {
  const next = { ...env };
  const minted = exports && typeof exports === 'object' ? exports : {};
  for (const key of CUSTOMER_ENV_KEYS) {
    const value = asTrimmed(minted[key]) || asTrimmed(next[key]);
    if (value) next[key] = value;
  }
  return next;
}

export function missingMintedEnvKeys(env = {}) {
  return CUSTOMER_ENV_KEYS.filter((key) => !asTrimmed(env[key]));
}

export function plannedOnboardSteps({
  slug,
  dbName,
  projectName,
  withOrg = true,
  smoke = false,
  email = null,
  name = null,
  baseUrl = null
} = {}) {
  const dbOverride = dbName && dbName !== defaultDatabaseName(slug);
  const projectOverride = projectName && projectName !== defaultProjectName(slug);
  const tursoCmd = [
    'npm run turso:customer --',
    `--slug ${slug}`,
    dbOverride ? `--db ${dbName}` : null,
    '--apply'
  ].filter(Boolean).join(' ');
  const vercelCmd = [
    'npm run vercel:customer --',
    `--slug ${slug}`,
    projectOverride ? `--project ${projectName}` : null,
    '--apply'
  ].filter(Boolean).join(' ');
  const ensure = plannedEnsureCommands(projectName);
  const provisionBits = [
    'npm run provision:customer --',
    withOrg ? '--with-org' : null,
    email ? `--email ${email}` : null,
    email ? '--password \'…\'' : null,
    name ? `--name ${JSON.stringify(name)}` : null
  ].filter(Boolean).join(' ');
  const smokeUrl = baseUrl || suggestedBaseUrl(projectName);
  return [
    {
      id: 'A',
      name: 'turso:customer',
      command: tursoCmd,
      summary: 'Create/reuse classic libSQL DB; mint TURSO_* + SESSION_SECRET'
    },
    {
      id: 'B',
      name: 'ensure-vercel-project',
      command: ensure.map((cmd) => cmd.display).join(' && '),
      summary: 'Create or reuse the Vercel project, then link this directory. Skip if already linked to this name. Fail closed if linked to a different project.'
    },
    {
      id: 'C',
      name: 'vercel:customer',
      command: vercelCmd,
      summary: 'Push TURSO_* + SESSION_SECRET to Production+Preview, redeploy, and wait until Production is Ready. Includes step B when run via vercel:customer --apply.'
    },
    {
      id: 'D',
      name: 'provision:customer',
      command: provisionBits,
      summary: withOrg
        ? 'Migrate + org skeleton' + (email ? ' + first admin' : ' (no first admin unless --email/--password)')
        : 'Migrate only' + (email ? ' + first admin' : '') + ' (--no-org)'
    },
    {
      id: 'E',
      name: 'smoke',
      command: `BASE_URL=${smokeUrl} npm run smoke`,
      summary: smoke
        ? 'HTTP smoke against the customer URL (after Production is Ready)'
        : 'Skipped unless --smoke. --apply waits for Production Ready, so --smoke on the same command is the preferred close'
    }
  ];
}

export function formatOnboardDryRun({
  slug,
  dbName,
  projectName,
  baseUrl,
  withOrg = true,
  smoke = false,
  email = null,
  name = null,
  env = process.env
} = {}) {
  const steps = plannedOnboardSteps({
    slug, dbName, projectName, withOrg, smoke, email, name, baseUrl
  });
  const vercelPlan = buildApplyPlan({ slug, projectName });
  const provision = steps.find((step) => step.name === 'provision:customer');
  const smokeStep = steps.find((step) => step.name === 'smoke');
  const sessionSet = Boolean(asTrimmed(env.SESSION_SECRET));
  const adminLine = email
    ? `First admin:    ${name ? `${name} <${email}>` : email}`
    : 'First admin:    (none — pass --email and --password on --apply)';
  const lines = [
    'ProcureFlow customer onboard (dry-run — no Turso/Vercel/DB mutation)',
    '',
    `Customer slug:  ${slug}`,
    `Database name:  ${dbName}`,
    `Vercel project: ${projectName}`,
    `Suggested URL:  ${baseUrl}`,
    `Org skeleton:   ${withOrg ? 'yes (--with-org is default on this command; --no-org to skip)' : 'no (--no-org)'}`,
    `Smoke:          ${smoke ? 'yes (--smoke, after Production is Ready)' : 'skip (pass --smoke on the same --apply; it waits for Production Ready)'}`,
    adminLine,
    '',
    'Isolation: one classic libSQL database + one Vercel project per customer.',
    'Never seeds. Never invents Turso URL/token. Never sets DEMO_PERSONA_SWITCHER.',
    'Never destroys a Turso DB. Creates or reuses the Vercel project, then links this directory.',
    '',
    'Step A — turso:customer --apply (secrets stay in-process for later steps):',
    ...plannedTursoCommands(dbName).flatMap((cmd) => (
      cmd.note ? [`  ${cmd.display}`, `    (${cmd.note})`] : [`  ${cmd.display}`]
    )),
    '',
    'Exports --apply will mint (placeholders — secrets are not invented in dry-run):',
    `  export TURSO_DATABASE_URL='${WILL_MINT_PLACEHOLDER}'`,
    `  export TURSO_AUTH_TOKEN='${WILL_MINT_PLACEHOLDER}'`,
    sessionSet
      ? '  export SESSION_SECRET=\'<reuse existing SESSION_SECRET from this environment — not printed>\''
      : `  export SESSION_SECRET='${WILL_MINT_PLACEHOLDER}'`,
    '',
    'Step B — ensure Vercel project + link (no secrets; part of vercel:customer --apply):',
    `  ${vercelPlan.whoami.display}`,
    ...vercelPlan.ensureCommands.flatMap((cmd) => (
      cmd.note ? [`  ${cmd.display}`, `    (${cmd.note})`] : [`  ${cmd.display}`]
    )),
    '  If this directory is linked to a different project, --apply stops and does not retarget.',
    `  ${VERCEL_GITHUB_LIMIT}`,
    '',
    'Step C — vercel:customer env + redeploy (uses Step A secrets; no manual export):',
    ...vercelPlan.envCommands.map((cmd) => `  ${cmd.display}`),
    `  ${vercelPlan.listProduction.display}`,
    `  ${vercelPlan.redeployDisplay}`,
    `  (if no production deployment yet: ${vercelPlan.deployFallbackDisplay})`,
    `  ${vercelPlan.inspectDisplay}`,
    `    (${vercelPlan.readyWaitNote})`,
    '',
    `Step D — ${provision.command}`,
    `  ${provision.summary}. Never seeds.`,
    '',
    `Step E — ${smokeStep.command}`,
    `  ${smokeStep.summary}.`,
    '',
    'Preferred one-command entry. Stepped path still works:',
    `  npm run turso:customer -- --slug ${slug} --apply`,
    `  npm run vercel:customer -- --slug ${slug} --apply`,
    `  npm run provision:customer -- ${withOrg ? '--with-org ' : ''}--email … --password …`,
    '',
    'Next:',
    `  npm run onboard:customer -- --slug ${slug} --apply --email admin@customer.com --password '…'`
      + (smoke ? ' --smoke' : '')
  ];
  return `${lines.join('\n')}\n`;
}

export function formatOnboardApplyReport({
  slug,
  dbName,
  projectName,
  baseUrl,
  withOrg,
  smoked = false
} = {}) {
  const lines = [
    'ProcureFlow customer onboard applied',
    '',
    `Customer slug:  ${slug}`,
    `Database name:  ${dbName}`,
    `Vercel project: ${projectName}`,
    `Org skeleton:   ${withOrg ? 'yes' : 'no'}`,
    `Smoke:          ${smoked ? 'ran' : 'skipped (pass --smoke on the same --apply; it waits for Production Ready)'}`,
    '',
    'Secrets stay in this process, Vercel env, and (from Turso) human stdout — not in git.',
    'DEMO_PERSONA_SWITCHER left unset.',
    VERCEL_GITHUB_LIMIT,
    '',
    'Next:',
    `  Sign in at ${baseUrl} (or Create the first admin if you omitted --email).`,
    smoked ? null : `  BASE_URL=${baseUrl} npm run smoke`,
    '  Administration → Users → Department Approvers'
  ].filter((line) => line != null);
  return `${lines.join('\n')}\n`;
}

export function formatVercelLinkStop({ slug, projectName } = {}) {
  return [
    '',
    'onboard:customer stopped at Vercel (ensure project + link, then env).',
    'Turso was not destroyed and was not seeded.',
    'If this directory is linked to a different project, the command will not retarget it.',
    `Expected project: ${projectName}`,
    '',
    'Re-run after the Vercel error above is fixed (the Turso DB is reused):',
    `  npm run onboard:customer -- --slug ${slug} --apply --email … --password …`,
    '',
    VERCEL_GITHUB_LIMIT,
    ''
  ].join('\n');
}

export function buildOnboardJsonSummary({
  mode,
  slug,
  dbName,
  projectName,
  baseUrl,
  withOrg,
  smoke,
  email = null,
  name = null,
  exports = null,
  steps = null,
  env = {}
} = {}) {
  const apply = mode === 'apply';
  const minted = exports || {};
  const sessionFromEnv = Boolean(asTrimmed(env.SESSION_SECRET));
  return {
    ok: true,
    mode,
    slug,
    dbName,
    projectName,
    baseUrl,
    withOrg,
    smoke,
    email: email || null,
    name: name || null,
    tursoDatabaseUrl: apply
      ? (asTrimmed(minted.TURSO_DATABASE_URL) || null)
      : WILL_MINT_PLACEHOLDER,
    tursoAuthToken: apply
      ? redactSecretTail(minted.TURSO_AUTH_TOKEN)
      : WILL_MINT_PLACEHOLDER,
    sessionSecret: apply
      ? redactSecretTail(minted.SESSION_SECRET)
      : (sessionFromEnv ? 'reuse-from-env' : WILL_MINT_PLACEHOLDER),
    steps: steps || plannedOnboardSteps({
      slug, dbName, projectName, withOrg, smoke, email, name, baseUrl
    }).map((step) => step.command),
    note: apply
      ? 'JSON redacts TURSO_AUTH_TOKEN and SESSION_SECRET to last 4 chars. Full values may appear on turso:customer export lines above.'
      : 'Dry-run does not invent secrets. Use --apply to mint URL, database token, and SESSION_SECRET in-process.'
  };
}

function identityErrorMessage(identity) {
  if (identity.error === 'invalid-slug') {
    return `Invalid --slug "${identity.slug}". Use a lowercase customer short name (letters, numbers, hyphens), e.g. acme.\n`;
  }
  if (identity.error === 'invalid-db') {
    return `Invalid --db "${identity.db}". Use a lowercase Turso database name (letters, numbers, hyphens), e.g. procureflow-acme.\n`;
  }
  return (
    '--slug is required (example: --slug acme → database/project procureflow-acme).\n'
      + ONBOARD_CUSTOMER_HELP
  );
}

export async function runOnboardCustomerCli({
  argv = [],
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  cwd = process.cwd(),
  spawnFn,
  randomBytesFn,
  existsSync,
  readFileSync,
  runTursoFn = runTursoCustomerCli,
  runVercelFn = runVercelCustomerCli,
  runProvisionFn = runCustomerProvisionCli,
  runSmokeFn = runSmokeCli
} = {}) {
  const args = parseOnboardCustomerArgs(argv);
  if (args.help) {
    write(stdout, ONBOARD_CUSTOMER_HELP);
    return 0;
  }
  if (args.seed) {
    write(
      stderr,
      'onboard:customer never seeds.\n'
        + 'Real customer: npm run onboard:customer -- --slug <customer> --apply --email … --password …\n'
        + 'Demo wipe (destructive): npm run seed\n'
    );
    return 1;
  }
  if (args.tursodb) {
    write(
      stderr,
      'onboard:customer never passes --tursodb. ProcureFlow uses classic libSQL only.\n'
        + 'Create/reuse with: npm run onboard:customer -- --slug <customer> --apply\n'
    );
    return 1;
  }
  if (args.unknown.length) {
    write(stderr, `Unknown argument: ${args.unknown[0]}\n${ONBOARD_CUSTOMER_HELP}`);
    return 1;
  }
  if (args.apply && args.dryRunFlag) {
    write(stderr, 'Use either --dry-run (default) or --apply, not both.\n');
    return 1;
  }
  if (args.withOrgFlag && args.noOrg) {
    write(stderr, 'Use either --with-org (default) or --no-org, not both.\n');
    return 1;
  }
  if ((args.email && !args.password) || (!args.email && args.password)) {
    write(stderr, 'First-admin bootstrap requires both --email and --password.\n');
    return 1;
  }

  const identity = resolveOnboardIdentity({
    slug: args.slug,
    db: args.db,
    project: args.project,
    baseUrl: args.baseUrl
  });
  if (identity.error) {
    write(stderr, identityErrorMessage(identity));
    return 1;
  }

  const { slug, dbName, projectName, baseUrl } = identity;
  const withOrg = args.withOrg;
  const reportOpts = {
    slug,
    dbName,
    projectName,
    baseUrl,
    withOrg,
    smoke: args.smoke,
    email: args.email,
    name: args.name,
    env
  };

  if (!args.apply) {
    write(stdout, formatOnboardDryRun(reportOpts));
    if (args.json) {
      write(stdout, `${JSON.stringify(buildOnboardJsonSummary({
        mode: 'dry-run',
        ...reportOpts
      }), null, 2)}\n`);
    }
    return 0;
  }

  write(stdout, `Onboarding ${slug} (Turso → Vercel project → env → provision${args.smoke ? ' → smoke' : ''})…\n`);

  const tursoArgv = buildTursoArgv({ slug, db: args.db || dbName });
  const tursoResult = await runTursoFn({
    argv: tursoArgv,
    env,
    stdout,
    stderr,
    cwd,
    spawnFn,
    randomBytesFn,
    returnResult: true
  });
  const tursoCode = tursoCustomerCliCode(tursoResult);
  if (tursoCode !== 0) return tursoCode;

  const minted = tursoCustomerExports(tursoResult);
  const enrichedEnv = enrichEnvWithTursoExports(env, minted);
  const missing = missingMintedEnvKeys(enrichedEnv);
  if (missing.length) {
    write(
      stderr,
      'onboard:customer: Turso apply succeeded but these secrets were not returned in-process:\n'
        + missing.map((key) => `  ${key}`).join('\n')
        + '\nRefusing to invent them. Re-run npm run turso:customer -- --slug '
        + `${slug} --apply and export the printed lines, or update the Turso CLI return API.\n`
    );
    return 1;
  }

  const vercelArgv = buildVercelArgv({ slug, project: args.project || projectName });
  const vercelCode = await runVercelFn({
    argv: vercelArgv,
    env: enrichedEnv,
    stdout,
    stderr,
    cwd,
    spawnFn,
    existsSync,
    readFileSync
  });
  if (vercelCode !== 0) {
    write(stderr, formatVercelLinkStop({ slug, projectName }));
    return vercelCode;
  }

  const provisionArgv = buildProvisionArgv({
    withOrg,
    email: args.email,
    password: args.password,
    name: args.name,
    baseUrl
  });
  const provisionEnv = { ...enrichedEnv, BASE_URL: baseUrl };
  const provisionCode = await runProvisionFn({
    argv: provisionArgv,
    env: provisionEnv,
    stdout,
    stderr
  });
  if (provisionCode !== 0) return provisionCode;

  let smoked = false;
  if (args.smoke) {
    const smokeArgv = buildSmokeArgv({
      baseUrl,
      email: args.email,
      password: args.password
    });
    const smokeCode = await runSmokeFn({
      argv: smokeArgv,
      env: { ...provisionEnv, BASE_URL: baseUrl },
      stdout,
      stderr
    });
    if (smokeCode !== 0) return smokeCode;
    smoked = true;
  }

  write(stdout, formatOnboardApplyReport({
    slug,
    dbName,
    projectName,
    baseUrl,
    withOrg,
    smoked
  }));

  if (args.json) {
    write(stdout, `${JSON.stringify(buildOnboardJsonSummary({
      mode: 'apply',
      slug,
      dbName,
      projectName,
      baseUrl,
      withOrg,
      smoke: smoked,
      email: args.email,
      name: args.name,
      exports: minted,
      env: enrichedEnv
    }), null, 2)}\n`);
  }

  return 0;
}
