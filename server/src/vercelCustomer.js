/**
 * Push per-customer Turso + session env to a linked Vercel project and redeploy.
 *
 * Isolation stays one Turso DB + one Vercel project per customer (not org_id).
 * Does not create a Turso database, migrate, seed, or set DEMO_PERSONA_SWITCHER.
 * Secrets must already be in the shell — this command never invents them.
 *
 *   npm run turso:customer -- --slug acme --apply   # first: print exports
 *   npm run vercel:customer -- --slug acme
 *   npm run vercel:customer -- --slug acme --apply
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { redactTursoUrl } from './provision.js';

export const CUSTOMER_ENV_KEYS = Object.freeze([
  'TURSO_DATABASE_URL',
  'TURSO_AUTH_TOKEN',
  'SESSION_SECRET'
]);

export const VERCEL_ENV_TARGETS = Object.freeze(['production', 'preview']);

export const DEMO_PERSONA_SWITCHER_KEY = 'DEMO_PERSONA_SWITCHER';

export const DEFAULT_PROJECT_PREFIX = 'procureflow-';

export const VERCEL_CUSTOMER_HELP = `ProcureFlow Vercel customer env (Production + Preview)

Usage:
  npm run vercel:customer -- --slug acme
  npm run vercel:customer -- --slug acme --dry-run
  npm run vercel:customer -- --slug acme --apply
  npm run vercel:customer -- --slug acme --project procureflow-acme --apply

  --slug <customer>     Required. Default project name is procureflow-<slug>
  --project <name>      Override Vercel project name
  --dry-run             Print the operator checklist + exact commands (default).
                        Exit 0. Never calls Vercel. No network required.
  --apply               Set/update the three env vars on Production and Preview
                        on the linked Vercel project, then redeploy so env
                        takes effect. Requires Vercel CLI, vercel login, and
                        vercel link.
  --help, -h            Show this help

Required shell env (same values that will go to Vercel; never invented):
  TURSO_DATABASE_URL
  TURSO_AUTH_TOKEN
  SESSION_SECRET

Does not create a Turso database, migrate, seed, or set DEMO_PERSONA_SWITCHER.

Happy path:
  Preferred: npm run onboard:customer -- --slug <slug> [--apply --email … --password …]
  1. npm run turso:customer -- --slug <slug> --apply     # classic libSQL + exports
  2. Create Vercel project procureflow-<slug> in the dashboard (import repo)
  3. vercel link --yes --project procureflow-<slug>
  4. npm run vercel:customer -- --slug <slug>            # dry-run
  5. npm run vercel:customer -- --slug <slug> --apply
  6. npm run provision:customer -- --with-org --email … --password …
  7. BASE_URL=https://procureflow-<slug>.vercel.app npm run smoke

See docs/CUSTOMER_ONBOARDING.md and docs/DEPLOYMENT.md.
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

export function defaultProjectName(slug) {
  const normalized = asTrimmed(slug).toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith(DEFAULT_PROJECT_PREFIX)) return normalized;
  return `${DEFAULT_PROJECT_PREFIX}${normalized}`;
}

export function suggestedBaseUrl(projectName) {
  const name = asTrimmed(projectName);
  if (!name) return null;
  return `https://${name}.vercel.app`;
}

export function normalizeSlug(raw) {
  const slug = asTrimmed(raw).toLowerCase();
  if (!slug) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) return null;
  if (slug.length > 48) return null;
  return slug;
}

export function missingCustomerEnvKeys(env = process.env) {
  return CUSTOMER_ENV_KEYS.filter((key) => !asTrimmed(env[key]));
}

export function demoPersonaSwitcherSet(env = process.env) {
  const raw = asTrimmed(env[DEMO_PERSONA_SWITCHER_KEY]);
  if (!raw) return false;
  return raw !== '0' && raw.toLowerCase() !== 'false';
}

export function parseVercelCustomerArgs(argv = []) {
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
    if (
      arg === '--slug' || arg.startsWith('--slug=')
      || arg === '--project' || arg.startsWith('--project=')
    ) {
      const key = arg.replace(/^--/, '').split('=')[0];
      const taken = takeFlagValue(argv, i, arg);
      values[key] = taken.value === true ? '' : taken.value;
      i = taken.nextIndex;
      continue;
    }
    unknown.push(arg);
  }

  const apply = flags.has('apply');
  const dryRunFlag = flags.has('dryRun');
  return {
    help: flags.has('help'),
    apply,
    dryRun: !apply,
    dryRunFlag,
    seed: flags.has('seed'),
    json: flags.has('json'),
    slug: values.slug != null ? String(values.slug).trim() : null,
    project: values.project != null ? String(values.project).trim() : null,
    unknown
  };
}

export function envAddArgv(key, target) {
  return ['env', 'add', key, target, '--yes', '--force'];
}

export function envAddDisplayCommand(key, target) {
  return `printf '%s' "$${key}" | vercel env add ${key} ${target} --yes --force`;
}

export function whoamiArgv() {
  return ['whoami'];
}

export function listProductionArgv() {
  return ['ls', '--environment', 'production'];
}

export function redeployArgv(deploymentIdOrUrl) {
  return ['redeploy', deploymentIdOrUrl, '--yes'];
}

export function deployProdArgv() {
  return ['deploy', '--prod', '--yes'];
}

export function linkGuidance({ projectName }) {
  return [
    'This directory is not linked to a Vercel project (missing .vercel/project.json).',
    '',
    'Create the project in the Vercel dashboard first (do not share it with another customer):',
    '  Add New → Project → import pesl98/new_p2p_indirect (or your fork)',
    `  Project name: ${projectName}`,
    '  Root Directory = repository root (leave default; build comes from vercel.json)',
    '',
    'Then from this repo root:',
    `  vercel login`,
    `  vercel link --yes --project ${projectName}`,
    '',
    'Re-run:',
    `  npm run vercel:customer -- --slug <customer> --apply`,
    '',
    'This command does not create Vercel projects (that stays a dashboard / vercel link step).'
  ].join('\n');
}

export function parseDeploymentTarget(stdout) {
  const text = asTrimmed(stdout);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.deployments)
        ? parsed.deployments
        : [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const rawUrl = item.url || item.name;
      const uid = item.uid || item.id || rawUrl;
      if (!rawUrl && !uid) continue;
      const url = rawUrl
        ? (/^https?:/i.test(rawUrl) ? rawUrl : `https://${rawUrl}`)
        : null;
      return { url, uid: uid || url };
    }
  } catch {
    // plain-text vercel ls table
  }
  const httpsMatch = text.match(/https:\/\/[a-z0-9._-]+\.vercel\.app/i);
  if (httpsMatch) {
    return { url: httpsMatch[0], uid: httpsMatch[0] };
  }
  const hostMatch = text.match(/\b[a-z0-9._-]+\.vercel\.app\b/i);
  if (hostMatch) {
    const url = `https://${hostMatch[0]}`;
    return { url, uid: url };
  }
  return null;
}

export function redactSecrets(text, env = process.env) {
  let out = String(text || '');
  for (const key of CUSTOMER_ENV_KEYS) {
    const val = asTrimmed(env[key]);
    if (val.length >= 4) {
      out = out.split(val).join(`$${key}`);
    }
  }
  return out;
}

export function describeReadyEnv(env = process.env) {
  const lines = [];
  const url = asTrimmed(env.TURSO_DATABASE_URL);
  const token = asTrimmed(env.TURSO_AUTH_TOKEN);
  const secret = asTrimmed(env.SESSION_SECRET);
  lines.push(`  TURSO_DATABASE_URL     set  ${redactTursoUrl(url) || '(set)'}`);
  lines.push(`  TURSO_AUTH_TOKEN       set  (length ${token.length}, not printed)`);
  lines.push(`  SESSION_SECRET         set  (length ${secret.length}, not printed)`);
  if (demoPersonaSwitcherSet(env)) {
    lines.push(
      `  DEMO_PERSONA_SWITCHER  set in this shell — will NOT be copied to Vercel`
    );
  } else {
    lines.push('  DEMO_PERSONA_SWITCHER  unset (leave unset on the customer project)');
  }
  return lines.join('\n');
}

export function buildApplyPlan({ slug, projectName }) {
  const envCommands = [];
  for (const key of CUSTOMER_ENV_KEYS) {
    for (const target of VERCEL_ENV_TARGETS) {
      envCommands.push({
        kind: 'env-upsert',
        key,
        target,
        argv: envAddArgv(key, target),
        stdinFromEnv: key,
        display: envAddDisplayCommand(key, target)
      });
    }
  }
  return {
    slug,
    projectName,
    baseUrl: suggestedBaseUrl(projectName),
    whoami: { argv: whoamiArgv(), display: 'vercel whoami' },
    envCommands,
    listProduction: {
      argv: listProductionArgv(),
      display: 'vercel ls --environment production'
    },
    redeployDisplay: 'vercel redeploy <latest-production-deployment> --yes',
    deployFallbackDisplay: 'vercel deploy --prod --yes',
    skipped: [DEMO_PERSONA_SWITCHER_KEY]
  };
}

export function formatDryRunReport({
  slug,
  projectName,
  env = process.env
} = {}) {
  const plan = buildApplyPlan({ slug, projectName });
  const lines = [
    'ProcureFlow Vercel customer env (dry-run — no Vercel mutation)',
    '',
    `Customer slug:  ${slug}`,
    `Project name:   ${projectName}`,
    `Suggested URL:  ${plan.baseUrl}`,
    '',
    'Shell env (values not printed, not invented):',
    describeReadyEnv(env),
    '',
    'Checklist (Production + Preview):',
    `  [ ] Vercel project ${projectName} exists (dashboard import; root = repo root)`,
    `  [ ] Linked in this directory: vercel link --yes --project ${projectName}`,
    ...CUSTOMER_ENV_KEYS.flatMap((key) => VERCEL_ENV_TARGETS.map(
      (target) => `  [ ] Set ${key} on ${target}`
    )),
    `  [ ] Leave ${DEMO_PERSONA_SWITCHER_KEY} unset`,
    '  [ ] Redeploy so env takes effect',
    '',
    'Commands that --apply would run (secrets stay in the shell / stdin, never argv):',
    `  ${plan.whoami.display}`,
    ...plan.envCommands.map((cmd) => `  ${cmd.display}`),
    `  ${plan.listProduction.display}`,
    `  ${plan.redeployDisplay}`,
    `  (if no production deployment yet: ${plan.deployFallbackDisplay})`,
    '',
    'Does not create a Turso database, migrate, seed, or set DEMO_PERSONA_SWITCHER.',
    '',
    'Next:',
    `  npm run vercel:customer -- --slug ${slug} --apply`,
    '  npm run provision:customer -- --with-org --email admin@customer.com --password \'…\'',
    `  BASE_URL=${plan.baseUrl} npm run smoke`
  ];
  return `${lines.join('\n')}\n`;
}

export function formatApplyReport({
  slug,
  projectName,
  baseUrl,
  redeployed
} = {}) {
  const url = baseUrl || suggestedBaseUrl(projectName);
  const lines = [
    'ProcureFlow Vercel customer env applied',
    '',
    `Customer slug:  ${slug}`,
    `Project name:   ${projectName}`,
    `Production+Preview env set: ${CUSTOMER_ENV_KEYS.join(', ')}`,
    `Redeploy:       ${redeployed || 'triggered'}`,
    `DEMO_PERSONA_SWITCHER left unset`,
    '',
    'Next (same TURSO_* already in this shell):',
    '  npm run provision:customer -- --with-org --email admin@customer.com --password \'…\'',
    `  BASE_URL=${url} npm run smoke`,
    '',
    'Secrets stay in this shell and in Vercel env — not in git.'
  ];
  return `${lines.join('\n')}\n`;
}

export function isProjectLinked(cwd, { existsSync = fs.existsSync } = {}) {
  return existsSync(path.join(cwd, '.vercel', 'project.json'));
}

export function resolveVercelBin(env = process.env) {
  const override = asTrimmed(env.VERCEL_CLI);
  return override || 'vercel';
}

export function runProcess(command, args, {
  spawnFn = spawn,
  cwd,
  env,
  stdin
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code, stdout, stderr, error) => {
      if (settled) return;
      settled = true;
      resolve({
        code: code == null ? 1 : code,
        stdout: stdout || '',
        stderr: stderr || '',
        error
      });
    };

    let child;
    try {
      child = spawnFn(command, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      finish(error?.code === 'ENOENT' ? 127 : 1, '', error?.message || String(error), error);
      return;
    }

    if (!child || typeof child.on !== 'function') {
      finish(1, '', 'spawn did not return a ChildProcess', new Error('invalid spawn'));
      return;
    }

    let stdout = '';
    let stderr = '';
    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', (chunk) => { stdout += chunk; });
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => { stderr += chunk; });
    }

    if (child.stdin) {
      if (stdin != null && typeof child.stdin.end === 'function') {
        child.stdin.end(stdin);
      } else if (typeof child.stdin.end === 'function') {
        child.stdin.end();
      }
    }

    child.on('error', (error) => {
      if (error?.code === 'ENOENT') {
        finish(127, stdout, stderr || error.message, error);
        return;
      }
      finish(1, stdout, stderr || error?.message || String(error), error);
    });
    child.on('close', (code) => finish(code, stdout, stderr));
  });
}

async function runVercelCommand(args, {
  spawnFn,
  cwd,
  env,
  stdin,
  vercelBin
}) {
  return runProcess(vercelBin, args, {
    spawnFn,
    cwd,
    env,
    stdin
  });
}

function printCommandOutput(stream, text, env) {
  const redacted = redactSecrets(asTrimmed(text), env);
  if (redacted) write(stream, `${redacted}\n`);
}

export async function runVercelCustomerCli({
  argv = [],
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  cwd = process.cwd(),
  spawnFn = spawn,
  existsSync = fs.existsSync
} = {}) {
  const args = parseVercelCustomerArgs(argv);
  if (args.help) {
    write(stdout, VERCEL_CUSTOMER_HELP);
    return 0;
  }
  if (args.seed) {
    write(
      stderr,
      'vercel:customer never seeds and does not migrate.\n'
        + 'Real customer: vercel env + redeploy, then npm run provision:customer.\n'
        + 'Demo wipe (destructive): npm run seed\n'
    );
    return 1;
  }
  if (args.json) {
    write(stderr, 'vercel:customer does not support --json.\n');
    return 1;
  }
  if (args.unknown.length) {
    write(stderr, `Unknown argument: ${args.unknown[0]}\n${VERCEL_CUSTOMER_HELP}`);
    return 1;
  }
  if (args.apply && args.dryRunFlag) {
    write(stderr, 'Use either --dry-run (default) or --apply, not both.\n');
    return 1;
  }
  if (!args.slug) {
    write(
      stderr,
      '--slug is required (example: --slug acme → project procureflow-acme).\n'
        + VERCEL_CUSTOMER_HELP
    );
    return 1;
  }

  const slug = normalizeSlug(args.slug);
  if (!slug) {
    write(
      stderr,
      `Invalid --slug "${args.slug}". Use a lowercase customer short name (letters, numbers, hyphens), e.g. acme.\n`
    );
    return 1;
  }

  const projectName = args.project
    ? asTrimmed(args.project)
    : defaultProjectName(slug);
  if (!projectName) {
    write(stderr, 'Could not derive a Vercel project name. Pass --project <name>.\n');
    return 1;
  }

  const missing = missingCustomerEnvKeys(env);
  if (missing.length) {
    write(
      stderr,
      'Refusing to invent secrets. Export these in the shell first (same values that will go to Vercel):\n'
        + missing.map((key) => `  ${key}`).join('\n')
        + '\n\n'
        + 'Mint them with:\n'
        + `  npm run turso:customer -- --slug ${slug} --apply\n`
        + 'Then re-run this command. Example (if you already have values):\n'
        + `  export TURSO_DATABASE_URL="$(turso db show ${projectName} --url)"\n`
        + `  export TURSO_AUTH_TOKEN="$(turso db tokens create ${projectName})"\n`
        + '  export SESSION_SECRET="$(node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))")"\n'
    );
    return 1;
  }

  if (!args.apply) {
    write(stdout, formatDryRunReport({ slug, projectName, env }));
    return 0;
  }

  const vercelBin = resolveVercelBin(env);
  const childEnv = { ...process.env, ...env };
  const runOpts = {
    spawnFn,
    cwd,
    env: childEnv,
    vercelBin
  };

  write(stdout, `Applying Vercel env for ${projectName} (Production + Preview)…\n`);

  const whoami = await runVercelCommand(whoamiArgv(), runOpts);
  if (whoami.code === 127) {
    write(
      stderr,
      'Vercel CLI was not found on PATH. Install it (npm i -g vercel) and run vercel login.\n'
        + 'Dry-run needs no CLI: npm run vercel:customer -- --slug ' + slug + '\n'
    );
    return 1;
  }
  if (whoami.code !== 0) {
    write(
      stderr,
      'Vercel CLI is not logged in. Run: vercel login\n'
    );
    printCommandOutput(stderr, whoami.stderr || whoami.stdout, env);
    return 1;
  }
  printCommandOutput(stdout, whoami.stdout, env);

  if (!isProjectLinked(cwd, { existsSync })) {
    write(stderr, `${linkGuidance({ projectName })}\n`);
    return 1;
  }

  const plan = buildApplyPlan({ slug, projectName });
  for (const cmd of plan.envCommands) {
    const value = asTrimmed(env[cmd.stdinFromEnv]);
    write(stdout, `Setting ${cmd.key} on ${cmd.target}…\n`);
    const result = await runVercelCommand(cmd.argv, {
      ...runOpts,
      stdin: value
    });
    printCommandOutput(stdout, result.stdout, env);
    if (result.code !== 0) {
      write(
        stderr,
        `Failed to set ${cmd.key} on ${cmd.target} (vercel exit ${result.code}).\n`
      );
      printCommandOutput(stderr, result.stderr || result.stdout, env);
      return 1;
    }
  }

  write(stdout, 'Triggering production redeploy so env takes effect…\n');
  const listed = await runVercelCommand(listProductionArgv(), runOpts);
  printCommandOutput(stdout, listed.stdout, env);
  if (listed.code !== 0) {
    write(stderr, 'Failed to list production deployments.\n');
    printCommandOutput(stderr, listed.stderr || listed.stdout, env);
    return 1;
  }

  const target = parseDeploymentTarget(listed.stdout);
  let redeployed;
  if (target?.uid) {
    const redeploy = await runVercelCommand(redeployArgv(target.uid), runOpts);
    printCommandOutput(stdout, redeploy.stdout, env);
    if (redeploy.code !== 0) {
      write(stderr, `vercel redeploy failed (exit ${redeploy.code}).\n`);
      printCommandOutput(stderr, redeploy.stderr || redeploy.stdout, env);
      return 1;
    }
    redeployed = asTrimmed(redeploy.stdout) || target.url || target.uid;
  } else {
    write(
      stdout,
      'No production deployment found to rebuild. Creating one with vercel deploy --prod --yes.\n'
    );
    const deployed = await runVercelCommand(deployProdArgv(), runOpts);
    printCommandOutput(stdout, deployed.stdout, env);
    if (deployed.code !== 0) {
      write(stderr, `vercel deploy --prod failed (exit ${deployed.code}).\n`);
      printCommandOutput(stderr, deployed.stderr || deployed.stdout, env);
      return 1;
    }
    redeployed = asTrimmed(deployed.stdout) || suggestedBaseUrl(projectName);
  }

  if (demoPersonaSwitcherSet(env)) {
    write(
      stdout,
      'Note: DEMO_PERSONA_SWITCHER is set in this shell and was not copied to Vercel.\n'
    );
  }

  write(stdout, formatApplyReport({
    slug,
    projectName,
    baseUrl: suggestedBaseUrl(projectName),
    redeployed
  }));
  return 0;
}
