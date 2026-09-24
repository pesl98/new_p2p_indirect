/**
 * Offboard one customer: strip Production + Preview customer env, then destroy
 * that customer's Turso database.
 *
 * Dry-run by default (no network). --apply does not mutate unless
 * --confirm-slug exactly equals the normalized slug.
 * Never seeds. Never invents secrets. Never sets DEMO_PERSONA_SWITCHER.
 * Does not delete the Vercel project and does not retarget a linked checkout.
 *
 * Flags checked against the CLIs in this environment before they were hardcoded:
 *   Vercel CLI 59.26.0 — `vercel env rm --help`:
 *     vercel env rm <name> <production|preview> --yes --project <name>
 *     `vercel project rm --help` has no --yes, so project delete is not run.
 *   Turso CLI v1.0.32 — `turso db destroy --help`:
 *     turso db destroy <database-name> --yes
 *     (no --location / --instance; those target one replica)
 *
 *   npm run offboard:customer -- --slug acme
 *   npm run offboard:customer -- --slug acme --apply --confirm-slug acme
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import {
  CUSTOMER_ENV_KEYS,
  DEMO_PERSONA_SWITCHER_KEY,
  VERCEL_ENV_TARGETS,
  defaultProjectName,
  normalizeSlug,
  projectNamesMatch,
  readLinkedProject,
  redactSecrets,
  resolveVercelBin,
  runProcess
} from './vercelCustomer.js';
import {
  defaultDatabaseName,
  looksLikeMissingDatabase,
  normalizeDatabaseName,
  resolveTursoBin
} from './tursoCustomer.js';

export const OFFBOARD_CUSTOMER_HELP = `ProcureFlow customer offboard (Vercel env strip + Turso destroy)

Usage:
  npm run offboard:customer -- --slug acme
  npm run offboard:customer -- --slug acme --dry-run
  npm run offboard:customer -- --slug acme --apply --confirm-slug acme
  npm run offboard:customer -- --slug acme --db procureflow-acme --project procureflow-acme --apply --confirm-slug acme

  --slug <customer>       Required. Normalized to lowercase. Default DB and
                          Vercel project are procureflow-<slug>.
  --db <name>             Override the Turso database name to destroy.
  --project <name>        Override the Vercel project whose env is stripped.
  --dry-run               Print the exact plan (default). Exit 0. No network.
  --apply                 Strip env, then destroy the database. Does nothing
                          destructive unless --confirm-slug matches.
  --confirm-slug <slug>   Required with --apply. Must exactly equal the
                          normalized --slug (lowercase). "Acme" does not match
                          "acme".
  --help, -h              Show this help

Refuses --seed. Never seeds. Never invents secrets. Never sets
${DEMO_PERSONA_SWITCHER_KEY}. Never prints full tokens.

On --apply --confirm-slug <slug>, in order:
  1. If this checkout is linked to a different Vercel project, stop.
     No env changes, no Turso destroy, no vercel link (does not retarget).
  2. vercel whoami, then turso auth whoami. A login failure stops before
     any env remove or database destroy.
  3. Remove only ${CUSTOMER_ENV_KEYS.join(', ')} from Production and Preview:
       vercel env rm <key> <production|preview> --yes --project <project>
     Other env keys are left alone. A key that is already absent is success.
     An unlinked checkout is addressed with --project (this command does not
     run vercel link). A missing Vercel project stops before Turso destroy
     (switch team with vercel switch, or destroy the DB yourself if you
     already deleted the project).
  4. turso db destroy <db> --yes
     If the database is already gone, that is success.

The Vercel project is left in place. vercel project rm (CLI 59.26.0) has no
--yes, so this command does not delete it. Dashboard: Settings → General →
Delete Project. Instant Rollback reverts code only.

See docs/CUSTOMER_ONBOARDING.md.
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

function shellWord(value) {
  const text = String(value);
  if (/^[A-Za-z0-9._:@%+=,/~-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function parseOffboardCustomerArgs(argv = []) {
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
    if (
      arg === '--slug' || arg.startsWith('--slug=')
      || arg === '--db' || arg.startsWith('--db=')
      || arg === '--project' || arg.startsWith('--project=')
      || arg === '--confirm-slug' || arg.startsWith('--confirm-slug=')
    ) {
      const rawKey = arg.replace(/^--/, '').split('=')[0];
      const key = rawKey === 'confirm-slug' ? 'confirmSlug' : rawKey;
      const taken = takeFlagValue(argv, i, arg);
      values[key] = taken.value === true ? '' : taken.value;
      i = taken.nextIndex;
      continue;
    }
    unknown.push(arg);
  }

  const apply = flags.has('apply');
  return {
    help: flags.has('help'),
    apply,
    dryRun: !apply,
    dryRunFlag: flags.has('dryRun'),
    seed: flags.has('seed'),
    slug: values.slug != null ? String(values.slug).trim() : null,
    db: values.db != null ? String(values.db).trim() : null,
    project: values.project != null ? String(values.project).trim() : null,
    confirmSlug: values.confirmSlug != null ? String(values.confirmSlug).trim() : null,
    unknown
  };
}

export function resolveOffboardIdentity({ slug, db, project } = {}) {
  const rawSlug = asTrimmed(slug);
  if (!rawSlug) {
    return { error: 'slug-required', slug: null, db: null, projectName: null };
  }
  const resolvedSlug = normalizeSlug(rawSlug);
  if (!resolvedSlug) {
    return { error: 'invalid-slug', slug: rawSlug, db: null, projectName: null };
  }

  const rawDb = asTrimmed(db);
  let dbName = rawDb ? normalizeDatabaseName(rawDb) : null;
  if (rawDb && !dbName) {
    return { error: 'invalid-db', slug: resolvedSlug, db: rawDb, projectName: null };
  }
  if (!dbName) dbName = defaultDatabaseName(resolvedSlug);

  const projectName = asTrimmed(project) || defaultProjectName(resolvedSlug);
  if (!projectName) {
    return { error: 'invalid-project', slug: resolvedSlug, db: dbName, projectName: null };
  }

  return {
    error: null,
    slug: resolvedSlug,
    dbName,
    projectName
  };
}

export function confirmSlugMatches(normalizedSlug, confirmSlug) {
  return asTrimmed(confirmSlug) === normalizedSlug && Boolean(normalizedSlug);
}

export function envRmArgv(key, target, projectName) {
  return ['env', 'rm', key, target, '--yes', '--project', projectName];
}

export function envRmDisplay(key, target, projectName) {
  return `vercel env rm ${shellWord(key)} ${shellWord(target)} --yes --project ${shellWord(projectName)}`;
}

export function tursoDestroyArgv(dbName) {
  return ['db', 'destroy', dbName, '--yes'];
}

export function tursoDestroyDisplay(dbName) {
  return `turso db destroy ${shellWord(dbName)} --yes`;
}

export function plannedEnvRemovals(projectName) {
  const commands = [];
  for (const key of CUSTOMER_ENV_KEYS) {
    for (const target of VERCEL_ENV_TARGETS) {
      commands.push({
        key,
        target,
        argv: envRmArgv(key, target, projectName),
        display: envRmDisplay(key, target, projectName)
      });
    }
  }
  return commands;
}

export function plannedOffboardCommands(dbName, projectName) {
  return {
    whoami: { argv: ['whoami'], display: 'vercel whoami' },
    tursoWhoami: { argv: ['auth', 'whoami'], display: 'turso auth whoami' },
    envRemovals: plannedEnvRemovals(projectName),
    destroy: {
      argv: tursoDestroyArgv(dbName),
      display: tursoDestroyDisplay(dbName)
    }
  };
}

export function looksLikeVercelProjectAbsent(stdout, stderr) {
  const text = `${asTrimmed(stdout)}\n${asTrimmed(stderr)}`;
  return /was not found in the current scope|project ["“'].*["”'] was not found/i.test(text);
}

export function looksLikeEnvAlreadyAbsent(stdout, stderr) {
  if (looksLikeVercelProjectAbsent(stdout, stderr)) return false;
  const text = `${asTrimmed(stdout)}\n${asTrimmed(stderr)}`;
  return /environment variable\b.*\bwas not found|environment variable was not found/i.test(text);
}

export function formatDryRunReport({ slug, dbName, projectName } = {}) {
  const plan = plannedOffboardCommands(dbName, projectName);
  const lines = [
    'ProcureFlow customer offboard (dry-run — no Vercel or Turso mutation)',
    '',
    `Customer slug:  ${slug}`,
    `Database name:  ${dbName}`,
    `Vercel project: ${projectName}`,
    '',
    'Isolation: one Turso DB + one Vercel project per customer.',
    'Never seeds. Never invents secrets. Never sets DEMO_PERSONA_SWITCHER.',
    'Never prints full tokens.',
    '',
    `--apply does not destroy unless --confirm-slug exactly equals the normalized slug (${slug}).`,
    '',
    'Link rule (checked on --apply, before any CLI call):',
    '  If this checkout is linked to a different Vercel project, stop.',
    '  No env changes and no Turso destroy. This command does not run vercel link.',
    '',
    'Order on --apply (env strip, then destroy):',
    `  ${plan.whoami.display}`,
    `  ${plan.tursoWhoami.display}`,
    ...plan.envRemovals.map((cmd) => `  ${cmd.display}`),
    `  ${plan.destroy.display}`,
    '    (if the database is already gone, that is success)',
    '',
    `Env keys removed on Production and Preview only: ${CUSTOMER_ENV_KEYS.join(', ')}`,
    'Other env keys are not touched. A key that is already absent is success.',
    'A missing Vercel project stops the command before Turso destroy.',
    '',
    'Not performed:',
    '  Vercel project delete. vercel project rm on Vercel CLI 59.26.0 has no --yes,',
    '  so this command does not delete the project. Delete it in the dashboard if you',
    '  want it gone (Settings → General → Delete Project). Instant Rollback reverts',
    '  code only and does not restore a destroyed database.',
    '  Seed, GitHub auto-deploy changes, custom domains, and SSO.',
    '',
    'Next:',
    `  npm run offboard:customer -- --slug ${slug} --apply --confirm-slug ${slug}`,
    '',
    'See docs/CUSTOMER_ONBOARDING.md.'
  ];
  return `${lines.join('\n')}\n`;
}

export function formatWrongLinkStop({ linkedName, projectName, dbName }) {
  return [
    `This directory is linked to Vercel project "${linkedName}", not "${projectName}".`,
    'Refusing to retarget another customer (no vercel link, no env changes, no Turso destroy).',
    `The Turso database ${dbName} was not destroyed.`,
    `Pass --project ${linkedName} only if that link is the customer you mean,`,
    `or run this from a checkout that is unlinked or already linked to ${projectName}.`,
    'Do not delete .vercel/project.json unless you have confirmed which customer it belongs to.'
  ].join('\n');
}

export function formatUnreadableLinkStop({ projectName, dbName }) {
  return [
    'This directory has .vercel/project.json but the linked project name could not be read.',
    `Refusing to offboard ${projectName} from this checkout (no env changes, no Turso destroy).`,
    `The Turso database ${dbName} was not destroyed.`,
    'Confirm which customer the link belongs to before removing .vercel/project.json.'
  ].join('\n');
}

function identityErrorMessage(identity) {
  if (identity.error === 'invalid-slug') {
    return `Invalid --slug "${identity.slug}". Use a lowercase customer short name (letters, numbers, hyphens), e.g. acme.\n`;
  }
  if (identity.error === 'invalid-db') {
    return `Invalid --db "${identity.db}". Use a lowercase Turso database name (letters, numbers, hyphens), e.g. procureflow-acme.\n`;
  }
  if (identity.error === 'invalid-project') {
    return 'Could not derive a Vercel project name. Pass --project <name>.\n';
  }
  return `--slug is required (example: --slug acme → database and project procureflow-acme).\n${OFFBOARD_CUSTOMER_HELP}`;
}

function assessLink({ cwd, projectName, existsSync, readFileSync }) {
  const linked = readLinkedProject(cwd, { existsSync, readFileSync });
  if (linked.unreadable || (linked.linked && !linked.projectName)) {
    return { ok: false, reason: 'unreadable', linked };
  }
  if (linked.linked && !projectNamesMatch(linked.projectName, projectName)) {
    return { ok: false, reason: 'wrong-project', linked, linkedName: linked.projectName };
  }
  return {
    ok: true,
    reason: linked.linked ? 'linked-target' : 'unlinked',
    linked
  };
}

function printCommandOutput(stream, text, env) {
  const redacted = redactSecrets(asTrimmed(text), env);
  if (redacted) write(stream, `${redacted}\n`);
}

export async function runOffboardCustomerCli({
  argv = [],
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  cwd = process.cwd(),
  spawnFn = spawn,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync
} = {}) {
  const args = parseOffboardCustomerArgs(argv);
  if (args.help) {
    write(stdout, OFFBOARD_CUSTOMER_HELP);
    return 0;
  }
  if (args.seed) {
    write(
      stderr,
      'offboard:customer never seeds.\n'
        + 'Deprovision: npm run offboard:customer -- --slug <customer> --apply --confirm-slug <customer>\n'
        + 'Demo wipe (destructive, local): npm run seed\n'
    );
    return 1;
  }
  if (args.unknown.length) {
    write(stderr, `Unknown argument: ${args.unknown[0]}\n${OFFBOARD_CUSTOMER_HELP}`);
    return 1;
  }
  if (args.apply && args.dryRunFlag) {
    write(stderr, 'Use either --dry-run (default) or --apply, not both.\n');
    return 1;
  }

  const identity = resolveOffboardIdentity({
    slug: args.slug,
    db: args.db,
    project: args.project
  });
  if (identity.error) {
    write(stderr, identityErrorMessage(identity));
    return 1;
  }

  const { slug, dbName, projectName } = identity;

  if (!args.apply) {
    write(stdout, formatDryRunReport({ slug, dbName, projectName }));
    return 0;
  }

  if (!confirmSlugMatches(slug, args.confirmSlug)) {
    const shown = args.confirmSlug == null || args.confirmSlug === ''
      ? '(missing)'
      : `"${args.confirmSlug}"`;
    write(
      stderr,
      `--apply does not destroy anything by itself.\n`
        + `--confirm-slug ${shown} must exactly equal the normalized slug "${slug}".\n`
        + `  npm run offboard:customer -- --slug ${slug} --apply --confirm-slug ${slug}\n`
        + 'No Vercel env vars were removed. The Turso database was not destroyed.\n'
    );
    return 1;
  }

  const link = assessLink({ cwd, projectName, existsSync, readFileSync });
  if (!link.ok && link.reason === 'wrong-project') {
    write(stderr, `${formatWrongLinkStop({
      linkedName: link.linkedName,
      projectName,
      dbName
    })}\n`);
    return 1;
  }
  if (!link.ok) {
    write(stderr, `${formatUnreadableLinkStop({ projectName, dbName })}\n`);
    return 1;
  }

  const vercelBin = resolveVercelBin(env);
  const tursoBin = resolveTursoBin(env);
  const childEnv = { ...process.env, ...env };
  const runVercel = (commandArgs) => runProcess(vercelBin, commandArgs, {
    spawnFn,
    cwd,
    env: childEnv
  });
  const runTurso = (commandArgs) => runProcess(tursoBin, commandArgs, {
    spawnFn,
    cwd,
    env: childEnv
  });

  write(stdout, `Offboarding ${slug} (project ${projectName}, database ${dbName})…\n`);
  if (link.reason === 'linked-target') {
    write(stdout, `Already linked to ${projectName}. Env remove uses that project (no vercel link).\n`);
  } else {
    write(
      stdout,
      `This directory is not linked. Env remove uses --project ${projectName} (no vercel link).\n`
    );
  }

  const whoami = await runVercel(['whoami']);
  if (whoami.code === 127) {
    write(
      stderr,
      'Vercel CLI was not found on PATH. Install it (npm i -g vercel) and run vercel login.\n'
        + `Dry-run needs no CLI: npm run offboard:customer -- --slug ${slug}\n`
        + 'No Vercel env vars were removed. The Turso database was not destroyed.\n'
    );
    return 1;
  }
  if (whoami.code !== 0) {
    write(stderr, 'Vercel CLI is not logged in. Run: vercel login\n');
    write(stderr, 'No Vercel env vars were removed. The Turso database was not destroyed.\n');
    printCommandOutput(stderr, whoami.stderr || whoami.stdout, env);
    return 1;
  }
  printCommandOutput(stdout, whoami.stdout, env);

  const tursoWho = await runTurso(['auth', 'whoami']);
  if (tursoWho.code === 127) {
    write(
      stderr,
      'Turso CLI was not found on PATH. Install it and log in:\n'
        + '  curl -sSfL https://get.tur.so/install.sh | bash\n'
        + '  turso auth login\n'
        + 'No Vercel env vars were removed. The Turso database was not destroyed.\n'
    );
    return 1;
  }
  if (tursoWho.code !== 0) {
    write(stderr, 'Turso CLI is not logged in. Run: turso auth login\n');
    write(stderr, 'No Vercel env vars were removed. The Turso database was not destroyed.\n');
    printCommandOutput(stderr, tursoWho.stderr || tursoWho.stdout, env);
    return 1;
  }
  printCommandOutput(stdout, tursoWho.stdout, env);

  const plan = plannedOffboardCommands(dbName, projectName);
  let absentKeys = 0;
  for (const cmd of plan.envRemovals) {
    write(stdout, `Removing ${cmd.key} on ${cmd.target}…\n`);
    const result = await runVercel(cmd.argv);
    printCommandOutput(stdout, result.stdout, env);
    if (result.code === 0) continue;
    if (looksLikeVercelProjectAbsent(result.stdout, result.stderr)) {
      write(
        stderr,
        `Vercel project "${projectName}" was not found in the current scope.\n`
          + `Refusing to destroy Turso database ${dbName}.\n`
          + 'If this CLI is on the wrong team, run vercel switch and try again.\n'
          + 'If you already deleted the Vercel project, destroy the database yourself:\n'
          + `  ${plan.destroy.display}\n`
      );
      printCommandOutput(stderr, result.stderr || result.stdout, env);
      return 1;
    }
    if (looksLikeEnvAlreadyAbsent(result.stdout, result.stderr)) {
      absentKeys += 1;
      write(stdout, `${cmd.key} on ${cmd.target} is already absent — continuing.\n`);
      continue;
    }
    write(
      stderr,
      `Failed to remove ${cmd.key} on ${cmd.target} (vercel exit ${result.code}).\n`
        + `Stopped before Turso destroy. Database ${dbName} was not destroyed.\n`
        + 'Keys already removed stay removed; re-run after fixing the Vercel error '
        + '(already-absent keys are success).\n'
    );
    printCommandOutput(stderr, result.stderr || result.stdout, env);
    return 1;
  }

  write(stdout, `Destroying Turso database ${dbName}…\n`);
  const destroyed = await runTurso(plan.destroy.argv);
  printCommandOutput(stdout, destroyed.stdout, env);
  let dbState = 'destroyed';
  if (destroyed.code !== 0) {
    if (looksLikeMissingDatabase(destroyed.stdout, destroyed.stderr)) {
      dbState = 'already-gone';
      write(stdout, `Database ${dbName} is already gone — treating destroy as success.\n`);
    } else {
      write(
        stderr,
        `Failed to destroy Turso database ${dbName} (turso exit ${destroyed.code}).\n`
          + 'Customer env keys were already removed from Production and Preview.\n'
          + 'Re-run this command after fixing Turso (already-absent env keys are success).\n'
      );
      printCommandOutput(stderr, destroyed.stderr || destroyed.stdout, env);
      return 1;
    }
  }

  const lines = [
    'ProcureFlow customer offboard applied',
    '',
    `Customer slug:  ${slug}`,
    `Database name:  ${dbName}`,
    `Vercel project: ${projectName}`,
    `Env removed (Production + Preview): ${CUSTOMER_ENV_KEYS.join(', ')}`,
    absentKeys
      ? `Already absent:  ${absentKeys} key/target pair(s) (counted as success)`
      : 'Already absent:  none',
    `Turso database: ${dbState === 'already-gone' ? 'already gone' : 'destroyed'}`,
    'Vercel project: left in place (not deleted)',
    `${DEMO_PERSONA_SWITCHER_KEY} was not set.`,
    '',
    'Rotate or delete the stored URL, database token, and SESSION_SECRET in the password manager.',
    'Removing them from Vercel does not revoke the Turso token.',
    '',
    'See docs/CUSTOMER_ONBOARDING.md.'
  ];
  write(stdout, `${lines.join('\n')}\n`);
  return 0;
}
