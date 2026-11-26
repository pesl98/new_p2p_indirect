/**
 * Offboard one customer: strip the per-target env list, dump the Turso
 * database to a file outside this git checkout, then destroy that database.
 *
 * Dry-run by default (no network). --apply does not mutate unless
 * --confirm-slug exactly equals the normalized slug.
 * Never seeds. Never invents secrets. Never sets DEMO_PERSONA_SWITCHER.
 * Does not delete the Vercel project and does not retarget a linked checkout.
 * Does not destroy the preview database. Never runs `turso db tokens invalidate`
 * (that command is group-wide).
 *
 * The cross-customer shell guard (customerShellGuard.js) stops onboard, turso,
 * and vercel customer commands from writing another customer's URL or generated
 * secret into a project. This command does not write shell secrets. It removes
 * named keys and dumps with the Turso CLI login. TURSO_* values and generated
 * secrets are not placed on an argument list. Command output still passes
 * through redactSecrets (SHELL_VALUE_KEYS). The dump body is never printed.
 *
 * Flags checked against the CLIs in this environment before they were hardcoded:
 *   Vercel CLI 59.26.0 — `vercel env rm --help`:
 *     vercel env rm <name> <production|preview> --yes --project <name>
 *     `vercel project rm --help` has no --yes, so project delete is not run.
 *   Turso CLI v1.0.32 — `turso db destroy --help`:
 *     turso db destroy <database-name> --yes
 *     (no --location / --instance; those target one replica)
 *   Dump: `turso db shell <database-name> .dump` (stdout is the SQL file).
 *
 *   npm run offboard:customer -- --slug acme
 *   npm run offboard:customer -- --slug acme --apply --confirm-slug acme
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
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

/**
 * Keys removed on --apply, per Vercel target. This is the Deploy 1 §3.1 list.
 * It is not CUSTOMER_ENV_KEYS (the three values vercel:customer still writes).
 * A missing key is success. Production and Preview do not share the Turso pair.
 */
export const OFFBOARD_ENV_KEYS_BY_TARGET = Object.freeze({
  production: Object.freeze([
    'TURSO_DATABASE_URL',
    'TURSO_AUTH_TOKEN',
    'SESSION_SECRET',
    'PORTAL_TOKEN_SECRET',
    'CRON_SECRET',
    'WEBHOOK_SIGNING_SECRET',
    'PROCUREFLOW_TENANT'
  ]),
  preview: Object.freeze([
    'TURSO_PREVIEW_DATABASE_URL',
    'TURSO_PREVIEW_AUTH_TOKEN',
    'SESSION_SECRET',
    'PORTAL_TOKEN_SECRET',
    'CRON_SECRET',
    'WEBHOOK_SIGNING_SECRET',
    'PROCUREFLOW_TENANT'
  ])
});

const OFFBOARD_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const OFFBOARD_CUSTOMER_HELP = `ProcureFlow customer offboard (Vercel env strip, dump, then Turso destroy)

Usage:
  npm run offboard:customer -- --slug acme
  npm run offboard:customer -- --slug acme --dry-run
  npm run offboard:customer -- --slug acme --apply --confirm-slug acme
  npm run offboard:customer -- --slug acme --db procureflow-acme --project procureflow-acme --apply --confirm-slug acme
  npm run offboard:customer -- --slug acme --dump-dir /var/tmp/procureflow-dumps --apply --confirm-slug acme

  --slug <customer>       Required. Normalized to lowercase. Default DB and
                          Vercel project are procureflow-<slug>.
  --db <name>             Override the Turso database name to dump and destroy.
  --project <name>        Override the Vercel project whose env is stripped.
  --dump-dir <dir>        Directory for the SQL dump taken before destroy.
                          Default: $HOME/tmp. The file name is
                          <slug>-<UTC timestamp>.sql. A path inside this git
                          checkout is refused. The file is customer data and
                          is sensitive. Its contents are never printed.
  --dry-run               Print the exact plan (default). Exit 0. No network.
  --apply                 Strip env, dump, then destroy the database. Does
                          nothing destructive unless --confirm-slug matches.
  --confirm-slug <slug>   Required with --apply. Must exactly equal the
                          normalized --slug (lowercase). "Acme" does not match
                          "acme".
  --help, -h              Show this help

Refuses --seed. Never seeds. Never invents secrets. Never sets
${DEMO_PERSONA_SWITCHER_KEY}. Never prints secret values, tokens, database
URLs, or the dump. Never runs turso db tokens invalidate (that command is
group-wide). Does not destroy the preview database.

On --apply --confirm-slug <slug>, in order:
  1. If this checkout is linked to a different Vercel project, stop.
     No env changes, no dump, no Turso destroy, no vercel link (does not retarget).
  2. If the dump path is inside this git checkout, stop. No env changes and
     no Turso destroy. Pass --dump-dir outside the checkout.
  3. vercel whoami, then turso auth whoami. A login failure stops before
     any env remove, dump, or database destroy.
  4. Remove the per-target list (a missing key is success):
       Production: ${OFFBOARD_ENV_KEYS_BY_TARGET.production.join(', ')}
       Preview: ${OFFBOARD_ENV_KEYS_BY_TARGET.preview.join(', ')}
       vercel env rm <key> <production|preview> --yes --project <project>
     Other env keys are left alone, including SSO and SMTP. An unlinked
     checkout is addressed with --project (this command does not run
     vercel link). A missing Vercel project stops before the dump and
     before Turso destroy (switch team with vercel switch, or destroy the
     DB yourself if you already deleted the project — take your own dump first).
  5. turso db shell <db> .dump, written only to the dump file. The dump text
     is not printed. A non-zero exit, an empty file, or a spawn error stops
     the command. turso db destroy is not run.
  6. turso db destroy <db> --yes
     Only after a non-empty dump file was written. If the database is
     already gone, that is success. The preview database is not destroyed.

The Vercel project is left in place. vercel project rm (CLI 59.26.0) has no
--yes, so this command does not delete it. Dashboard: Settings → General →
Delete Project. Instant Rollback reverts code only. Databases that already
share Turso's default group stay there; this command does not call
tokens invalidate on that group.

See docs/DEPLOY_MANUAL.md. docs/CUSTOMER_ONBOARDING.md points there.
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
      || arg === '--dump-dir' || arg.startsWith('--dump-dir=')
    ) {
      const rawKey = arg.replace(/^--/, '').split('=')[0];
      const key = rawKey === 'confirm-slug'
        ? 'confirmSlug'
        : rawKey === 'dump-dir'
          ? 'dumpDir'
          : rawKey;
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
    dumpDir: values.dumpDir != null ? String(values.dumpDir).trim() : null,
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

export function tursoDumpArgv(dbName) {
  return ['db', 'shell', dbName, '.dump'];
}

export function tursoDumpDisplay(dbName) {
  return `turso db shell ${shellWord(dbName)} .dump`;
}

export function dumpStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function checkoutRoot(start, existsSync) {
  if (!start) return null;
  let dir = path.resolve(start);
  const root = path.parse(dir).root;
  const seen = new Set();
  while (!seen.has(dir)) {
    seen.add(dir);
    if (existsSync(path.join(dir, '.git'))) return dir;
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function modulePackageRoot(start, existsSync) {
  if (!start) return null;
  let dir = path.resolve(start);
  const root = path.parse(dir).root;
  const seen = new Set();
  while (!seen.has(dir)) {
    seen.add(dir);
    if (
      existsSync(path.join(dir, 'package.json'))
      && existsSync(path.join(dir, 'server', 'package.json'))
    ) {
      return dir;
    }
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function canonicalPath(target, existsSync = fs.existsSync, realpathSync = fs.realpathSync) {
  const resolved = path.resolve(target);
  let current = resolved;
  const suffix = [];
  const root = path.parse(resolved).root;
  const seen = new Set();
  while (!existsSync(current)) {
    if (seen.has(current) || current === root) break;
    seen.add(current);
    suffix.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  let base = current;
  try {
    if (existsSync(current)) base = realpathSync(current);
  } catch {
    base = current;
  }
  return suffix.length ? path.join(base, ...suffix) : base;
}

export function pathInsideDir(candidate, rootDir) {
  if (!rootDir || candidate == null || candidate === '') return false;
  const root = path.resolve(rootDir);
  const target = path.resolve(candidate);
  const rel = path.relative(root, target);
  if (rel === '') return true;
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
  return true;
}

export function offboardWorkTrees({
  cwd = process.cwd(),
  moduleDir = OFFBOARD_MODULE_DIR,
  existsSync = fs.existsSync,
  realpathSync = fs.realpathSync
} = {}) {
  const found = [];
  const add = (dir) => {
    if (!dir) return;
    const real = canonicalPath(dir, existsSync, realpathSync);
    if (!found.includes(real)) found.push(real);
  };
  add(checkoutRoot(cwd, existsSync));
  add(checkoutRoot(moduleDir, existsSync));
  add(modulePackageRoot(moduleDir, existsSync));
  add(modulePackageRoot(cwd, existsSync));
  return found;
}

export function resolveOffboardDumpPath({
  slug,
  dumpDir = null,
  cwd = process.cwd(),
  homedir = os.homedir(),
  now = new Date(),
  existsSync = fs.existsSync,
  realpathSync = fs.realpathSync,
  statSync = fs.statSync,
  moduleDir = OFFBOARD_MODULE_DIR
} = {}) {
  const dir = dumpDir
    ? path.resolve(cwd, dumpDir)
    : path.join(homedir, 'tmp');
  const fileName = `${slug}-${dumpStamp(now)}.sql`;
  const filePath = path.join(dir, fileName);
  const trees = offboardWorkTrees({ cwd, moduleDir, existsSync, realpathSync });
  const canonFile = canonicalPath(filePath, existsSync, realpathSync);
  const canonDir = canonicalPath(dir, existsSync, realpathSync);
  let workTree = null;
  for (const tree of trees) {
    if (pathInsideDir(canonFile, tree) || pathInsideDir(canonDir, tree)) {
      workTree = tree;
      break;
    }
  }
  let reason = null;
  if (workTree) reason = 'inside-work-tree';
  else if (existsSync(dir)) {
    try {
      if (!statSync(dir).isDirectory()) reason = 'not-a-directory';
    } catch {
      reason = 'not-a-directory';
    }
  }
  return {
    dir,
    filePath,
    fileName,
    refused: Boolean(reason),
    reason,
    workTree
  };
}

export function plannedEnvRemovals(projectName) {
  const commands = [];
  for (const target of VERCEL_ENV_TARGETS) {
    const keys = OFFBOARD_ENV_KEYS_BY_TARGET[target] || [];
    for (const key of keys) {
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
    dump: {
      argv: tursoDumpArgv(dbName),
      display: tursoDumpDisplay(dbName)
    },
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

export function formatDumpPathRefusal({ filePath, workTree, dbName, reason } = {}) {
  const where = reason === 'not-a-directory'
    ? `Refusing --dump-dir because ${path.dirname(filePath)} is not a directory.`
    : `Refusing to write the dump to ${filePath} because it is inside the git work tree${workTree ? ` (${workTree})` : ''}.`;
  return [
    where,
    'Pass --dump-dir with a directory outside this checkout. The default is $HOME/tmp.',
    `No Vercel env vars were removed. Turso database ${dbName} was not destroyed.`,
    'The dump text was not printed.'
  ].join('\n');
}

export function formatDryRunReport({
  slug,
  dbName,
  projectName,
  dump
} = {}) {
  const plan = plannedOffboardCommands(dbName, projectName);
  const dumpPlan = dump || resolveOffboardDumpPath({ slug });
  const dumpNote = dumpPlan.refused
    ? `    REFUSED: that path is inside this git checkout${dumpPlan.workTree ? ` (${dumpPlan.workTree})` : ''}. --apply will not remove env or destroy.`
    : '    (SQL is written only to that file and is not printed; a failed or empty dump does not destroy)';
  const lines = [
    'ProcureFlow customer offboard (dry-run — no Vercel or Turso mutation)',
    '',
    `Customer slug:  ${slug}`,
    `Database name:  ${dbName}`,
    `Vercel project: ${projectName}`,
    `Dump file:      ${dumpPlan.filePath}`,
    '',
    'Isolation: one Turso DB + one Vercel project per customer.',
    'Never seeds. Never invents secrets. Never sets DEMO_PERSONA_SWITCHER.',
    'Never prints secret values, tokens, database URLs, or the dump.',
    '',
    `--apply does not destroy unless --confirm-slug exactly equals the normalized slug (${slug}).`,
    '',
    'Link rule (checked on --apply, before any CLI call):',
    '  If this checkout is linked to a different Vercel project, stop.',
    '  No env changes, no dump, and no Turso destroy. This command does not run vercel link.',
    '',
    'Order on --apply (env strip, dump outside this checkout, then destroy):',
    `  ${plan.whoami.display}`,
    `  ${plan.tursoWhoami.display}`,
    ...plan.envRemovals.map((cmd) => `  ${cmd.display}`),
    `  ${plan.dump.display}`,
    `    → ${dumpPlan.filePath}`,
    dumpNote,
    `  ${plan.destroy.display}`,
    '    (only after a non-empty dump; if the database is already gone, that is success)',
    '',
    'Env keys removed, per target (a key that is already absent is success):',
    `  Production: ${OFFBOARD_ENV_KEYS_BY_TARGET.production.join(', ')}`,
    `  Preview: ${OFFBOARD_ENV_KEYS_BY_TARGET.preview.join(', ')}`,
    'Other env keys are not touched, including SSO and SMTP.',
    'A missing Vercel project stops the command before the dump and before Turso destroy.',
    '',
    'Not performed:',
    '  turso db tokens invalidate. That command is group-wide. Databases that already',
    '  share Turso\'s default group stay there until a person recreates them.',
    '  Preview database destroy. The preview database is left in place.',
    '  Vercel project delete. vercel project rm on Vercel CLI 59.26.0 has no --yes,',
    '  so this command does not delete the project. Delete it in the dashboard if you',
    '  want it gone (Settings → General → Delete Project). Instant Rollback reverts',
    '  code only and does not restore a destroyed database.',
    '  Seed, GitHub auto-deploy changes, custom domains, and SSO.',
    '',
    'Next:',
    `  npm run offboard:customer -- --slug ${slug} --apply --confirm-slug ${slug}`,
    '',
    'See docs/DEPLOY_MANUAL.md. docs/CUSTOMER_ONBOARDING.md points there.'
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

/**
 * Run `turso db shell <db> .dump` and write stdout to filePath.
 * The SQL body is not returned and must not be written to a log stream.
 * A non-zero exit, a spawn error, or an empty file leaves no successful dump.
 */
export async function captureDumpToFile({
  tursoBin,
  dbName,
  filePath,
  spawnFn = spawn,
  cwd,
  env,
  run = runProcess,
  workTrees,
  mkdirSync = fs.mkdirSync,
  writeFileSync = fs.writeFileSync,
  statSync = fs.statSync,
  renameSync = fs.renameSync,
  unlinkSync = fs.unlinkSync,
  existsSync = fs.existsSync,
  realpathSync = fs.realpathSync
} = {}) {
  const result = await run(tursoBin, tursoDumpArgv(dbName), { spawnFn, cwd, env });
  const code = result && result.code != null ? result.code : 1;
  if (!result || result.error || code === 127) {
    return { ok: false, reason: 'spawn-error', code };
  }
  if (code !== 0) {
    return { ok: false, reason: 'exit', code };
  }
  const body = typeof result.stdout === 'string' ? result.stdout : '';
  if (!body.trim()) {
    return { ok: false, reason: 'empty', code: 0 };
  }
  const canon = canonicalPath(filePath, existsSync, realpathSync);
  const trees = workTrees || offboardWorkTrees({ cwd, existsSync, realpathSync });
  for (const tree of trees) {
    if (pathInsideDir(canon, tree)) {
      return { ok: false, reason: 'inside-work-tree', code: 1 };
    }
  }
  const partial = `${filePath}.partial`;
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(partial, body, { encoding: 'utf8', flag: 'wx' });
    const size = statSync(partial).size;
    if (!size) {
      try { unlinkSync(partial); } catch { /* empty partial is not a dump */ }
      return { ok: false, reason: 'empty', code: 0 };
    }
    renameSync(partial, filePath);
    const finalSize = statSync(filePath).size;
    if (!finalSize) {
      return { ok: false, reason: 'empty', code: 0 };
    }
    return { ok: true, bytes: finalSize };
  } catch (error) {
    try { unlinkSync(partial); } catch { /* do not report the SQL */ }
    return {
      ok: false,
      reason: 'write',
      code: 1,
      errorCode: error && error.code ? error.code : null
    };
  }
}

export function formatDumpFailure({ dbName, filePath, outcome } = {}) {
  const code = outcome?.code;
  let why = `The dump command exited ${code}.`;
  if (outcome?.reason === 'empty') {
    why = 'The dump file was empty.';
  } else if (outcome?.reason === 'spawn-error') {
    why = code === 127
      ? 'The Turso CLI was not found, so the dump could not be started.'
      : `The dump command could not be started (exit ${code}).`;
  } else if (outcome?.reason === 'write') {
    const detail = outcome.errorCode ? ` (${outcome.errorCode})` : '';
    why = `The dump could not be written outside this checkout${detail}.`;
  } else if (outcome?.reason === 'inside-work-tree') {
    why = 'The dump path is inside this git checkout.';
  }
  return [
    `Refusing to destroy Turso database ${dbName}.`,
    why,
    `Dump path: ${filePath}`,
    'The dump text was not printed.',
    'turso db destroy was not run.',
    'Customer env keys were already removed from Production and Preview.',
    'Re-run after fixing the dump (already-absent env keys are success).'
  ].join('\n');
}

export async function runOffboardCustomerCli({
  argv = [],
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  cwd = process.cwd(),
  spawnFn = spawn,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
  homedir = os.homedir(),
  now = new Date()
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

  if (args.dumpDir === '') {
    write(stderr, '--dump-dir requires a directory outside this git checkout.\n');
    return 1;
  }

  const dumpPlan = resolveOffboardDumpPath({
    slug,
    dumpDir: args.dumpDir,
    cwd,
    homedir,
    now
  });

  if (!args.apply) {
    write(stdout, formatDryRunReport({ slug, dbName, projectName, dump: dumpPlan }));
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

  if (dumpPlan.refused) {
    write(stderr, `${formatDumpPathRefusal({
      filePath: dumpPlan.filePath,
      workTree: dumpPlan.workTree,
      dbName,
      reason: dumpPlan.reason
    })}\n`);
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
          + 'The dump was not taken and turso db destroy was not run.\n'
          + 'If this CLI is on the wrong team, run vercel switch and try again.\n'
          + 'If you already deleted the Vercel project, dump the database yourself, then:\n'
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
        + `Stopped before Turso destroy. The dump was not taken. Database ${dbName} was not destroyed.\n`
        + 'Keys already removed stay removed; re-run after fixing the Vercel error '
        + '(already-absent keys are success).\n'
    );
    printCommandOutput(stderr, result.stderr || result.stdout, env);
    return 1;
  }

  write(stdout, `Dumping ${dbName} to ${dumpPlan.filePath} (SQL is not printed)…\n`);
  const dumped = await captureDumpToFile({
    tursoBin,
    dbName,
    filePath: dumpPlan.filePath,
    spawnFn,
    cwd,
    env: childEnv
  });
  if (!dumped.ok) {
    write(stderr, `${formatDumpFailure({
      dbName,
      filePath: dumpPlan.filePath,
      outcome: dumped
    })}\n`);
    return 1;
  }
  write(stdout, `Dump written (${dumped.bytes} bytes). The SQL was not printed.\n`);

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
          + `A dump was written to ${dumpPlan.filePath}. Its contents were not printed.\n`
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
    `Env removed (Production): ${OFFBOARD_ENV_KEYS_BY_TARGET.production.join(', ')}`,
    `Env removed (Preview): ${OFFBOARD_ENV_KEYS_BY_TARGET.preview.join(', ')}`,
    absentKeys
      ? `Already absent:  ${absentKeys} key/target pair(s) (counted as success)`
      : 'Already absent:  none',
    `Dump file:      ${dumpPlan.filePath} (${dumped.bytes} bytes; contents not printed)`,
    `Turso database: ${dbState === 'already-gone' ? 'already gone' : 'destroyed'}`,
    'Preview database: left in place (not destroyed)',
    'Vercel project: left in place (not deleted)',
    'turso db tokens invalidate was not run.',
    `${DEMO_PERSONA_SWITCHER_KEY} was not set.`,
    '',
    'The dump file is customer data. Keep it outside this git checkout and restrict who can read it.',
    'Rotate or delete the stored URL, database token, SESSION_SECRET, and the other removed secrets in the password manager.',
    'Removing them from Vercel does not revoke the Turso token. This command does not call tokens invalidate.',
    '',
    'See docs/DEPLOY_MANUAL.md. docs/CUSTOMER_ONBOARDING.md points there.'
  ];
  write(stdout, `${lines.join('\n')}\n`);
  return 0;
}
