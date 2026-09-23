/**
 * Ensure a per-customer Vercel project exists, link this checkout, push Turso +
 * session env, redeploy, and wait until that Production deployment is Ready.
 *
 * Isolation stays one Turso DB + one Vercel project per customer (not org_id).
 * Does not create a Turso database, migrate, seed, or set DEMO_PERSONA_SWITCHER.
 * Secrets must already be in the shell — this command never invents them.
 * Does not connect GitHub auto-deploy (laptop vercel deploy / redeploy only).
 *
 * Ready wait uses `vercel inspect <url-or-id> --json` (confirmed on Vercel CLI
 * 59.25.4). The CLI also has `inspect --wait`, but this command polls so the
 * timeout, sleep, and Ready/ERROR/CANCELED handling stay in-process and testable.
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

export const VERCEL_GITHUB_LIMIT =
  'vercel project add does not connect GitHub. Production is deployed from this laptop (vercel deploy --prod / vercel redeploy). Git-push deploys still need a one-time Vercel↔GitHub connection in the dashboard.';

/** Default wait for Production readyState READY after redeploy/deploy. */
export const DEFAULT_VERCEL_READY_TIMEOUT_MS = 4 * 60 * 1000;

/** Pause between `vercel inspect --json` polls while the deployment is still building. */
export const DEFAULT_VERCEL_READY_POLL_MS = 5000;

export const DEPLOYMENT_INSPECT_DISPLAY = 'vercel inspect <new-deployment-url-or-id> --json';

export const PENDING_DEPLOYMENT_STATES = Object.freeze([
  'BUILDING',
  'QUEUED',
  'INITIALIZING'
]);

export const FAILED_DEPLOYMENT_STATES = Object.freeze([
  'ERROR',
  'CANCELED',
  'BLOCKED'
]);

export function readyWaitNote() {
  return `--apply polls ${DEPLOYMENT_INSPECT_DISPLAY} until readyState is READY`
    + ` (keeps waiting only while ${PENDING_DEPLOYMENT_STATES.join(', ')}).`
    + ` Default timeout ${DEFAULT_VERCEL_READY_TIMEOUT_MS} ms (VERCEL_READY_TIMEOUT_MS).`
    + ' It returns after Ready, so smoke can follow. Dry-run does not call Vercel.';
}

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
  --apply               Ensure the Vercel project exists and this directory is
                        linked, then set/update the three env vars on Production
                        and Preview, redeploy, and wait until that Production
                        deployment is Ready (vercel inspect <url-or-id> --json).
                        Requires the Vercel CLI and vercel login. Uses the CLI's
                        current team (vercel switch if you have more than one).
                        Default wait is ${DEFAULT_VERCEL_READY_TIMEOUT_MS} ms
                        (override with VERCEL_READY_TIMEOUT_MS). Exits non-zero
                        on timeout, ERROR, or CANCELED.
  --help, -h            Show this help

Required shell env (same values that will go to Vercel; never invented):
  TURSO_DATABASE_URL
  TURSO_AUTH_TOKEN
  SESSION_SECRET

Does not create a Turso database, migrate, seed, or set DEMO_PERSONA_SWITCHER.

Project ensure (before env, on --apply):
  vercel project add procureflow-<slug>
    Idempotent. Vercel CLI 59 exits 0 if the project already exists (HTTP 409).
    Skipped when this directory is already linked to that project name.
  vercel link --yes --project procureflow-<slug>
    Skipped when already linked to that name.
  If .vercel/project.json names a different project, --apply stops and does
  not retarget it.

${VERCEL_GITHUB_LIMIT}

${readyWaitNote()}

Happy path:
  Preferred: npm run onboard:customer -- --slug <slug> --apply --email … --password … --smoke
  1. npm run turso:customer -- --slug <slug> --apply     # classic libSQL + exports
  2. npm run vercel:customer -- --slug <slug>            # dry-run (ensure + env + Ready wait)
  3. npm run vercel:customer -- --slug <slug> --apply    # project add, link, env, redeploy, wait Ready
  4. npm run provision:customer -- --with-org --email … --password …
  5. BASE_URL=https://procureflow-<slug>.vercel.app npm run smoke
     (--apply already waited for Production Ready, so smoke can follow immediately.
      GitHub auto-deploy is still a dashboard connection, not this command.)

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

export function deploymentInspectArgv(deploymentIdOrUrl) {
  return ['inspect', deploymentIdOrUrl, '--json'];
}

export function resolveReadyTimeoutMs(env = process.env) {
  const raw = asTrimmed(env.VERCEL_READY_TIMEOUT_MS);
  if (!raw) return DEFAULT_VERCEL_READY_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_VERCEL_READY_TIMEOUT_MS;
  return n;
}

export function normalizeDeploymentState(value) {
  if (value == null) return null;
  const text = String(value).replace(/\u001b\[[0-9;]*m/g, '').trim();
  if (!text) return null;
  const upper = text.toUpperCase();
  if (upper === 'CANCELLED') return 'CANCELED';
  if (
    PENDING_DEPLOYMENT_STATES.includes(upper)
    || FAILED_DEPLOYMENT_STATES.includes(upper)
    || upper === 'READY'
  ) {
    return upper;
  }
  const labeled = text.match(
    /(?:readyState|status|state)\s*[:=]\s*["']?(INITIALIZING|QUEUED|BUILDING|READY|ERROR|CANCELED|CANCELLED|BLOCKED)\b/i
  );
  if (labeled) {
    return labeled[1].toUpperCase() === 'CANCELLED' ? 'CANCELED' : labeled[1].toUpperCase();
  }
  const all = [...text.matchAll(
    /\b(INITIALIZING|QUEUED|BUILDING|READY|ERROR|CANCELED|CANCELLED|BLOCKED)\b/gi
  )];
  if (!all.length) return null;
  const found = all[all.length - 1][1].toUpperCase();
  return found === 'CANCELLED' ? 'CANCELED' : found;
}

export function parseInspectReadyState(stdout) {
  const text = asTrimmed(stdout).replace(/\u001b\[[0-9;]*m/g, '');
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const raw = parsed.readyState || parsed.status || parsed.state;
      const normalized = normalizeDeploymentState(raw);
      if (normalized) return normalized;
    }
  } catch {
    // plain-text `vercel inspect` summary
  }
  return normalizeDeploymentState(text);
}

export function classifyDeploymentState(state) {
  if (!state) return 'unknown';
  if (state === 'READY') return 'ready';
  if (PENDING_DEPLOYMENT_STATES.includes(state)) return 'pending';
  if (FAILED_DEPLOYMENT_STATES.includes(state)) return 'failed';
  return 'unknown';
}

export function pickDeploymentRef(stdout, { projectName } = {}) {
  const text = String(stdout || '');
  if (!asTrimmed(text)) return null;
  let parsedUrl = null;
  let parsedId = null;
  try {
    const parsed = JSON.parse(text);
    const obj = Array.isArray(parsed) ? parsed[0] : parsed;
    if (obj && typeof obj === 'object') {
      const rawUrl = obj.url || obj.deploymentUrl;
      const uid = obj.uid || obj.id;
      if (uid && /^dpl_/.test(String(uid))) parsedId = String(uid);
      if (rawUrl) {
        parsedUrl = /^https?:/i.test(String(rawUrl))
          ? String(rawUrl)
          : `https://${rawUrl}`;
      }
    }
  } catch {
    // redeploy/deploy stdout is usually a bare URL
  }
  const urls = [];
  if (parsedUrl) urls.push(parsedUrl);
  const re = /https:\/\/[a-z0-9._-]+\.vercel\.app/gi;
  let match = re.exec(text);
  while (match) {
    urls.push(match[0]);
    match = re.exec(text);
  }
  const alias = projectName
    ? `https://${String(projectName).toLowerCase()}.vercel.app`
    : null;
  const unique = urls.find((url) => !alias || url.toLowerCase() !== alias);
  if (unique) return unique;
  if (parsedId) return parsedId;
  const dpl = text.match(/\bdpl_[A-Za-z0-9]+\b/);
  if (urls[0]) return urls[0];
  if (dpl) return dpl[0];
  return null;
}

export function formatMissingDeploymentRef() {
  return [
    'Redeploy finished but no deployment URL or id was found to inspect.',
    'Refusing to treat the deploy as Ready.',
    'Check the Vercel dashboard for the Production deployment, then redeploy if needed:',
    '  vercel ls --environment production',
    '  vercel redeploy <deployment-url-or-id>'
  ].join('\n');
}

export function formatDeploymentWaitFailure({
  deploymentRef,
  state,
  timedOut,
  timeoutMs,
  inspect,
  env = process.env
} = {}) {
  const ref = deploymentRef || '(unknown deployment)';
  if (timedOut) {
    const seconds = Math.round((timeoutMs || 0) / 1000);
    return [
      `Timed out after ${seconds}s waiting for Production deployment ${ref} to become Ready (last state: ${state || 'unknown'}).`,
      'Env was updated and a deploy was triggered, but this command stops here so smoke does not hit a deployment that is still building.',
      'Check the Vercel dashboard, or inspect and redeploy:',
      `  vercel inspect ${ref}`,
      `  vercel redeploy ${ref}`,
      'Then re-run once that deployment is Ready.'
    ].join('\n');
  }
  if (classifyDeploymentState(state) === 'failed') {
    return [
      `Production deployment ${ref} is ${state} (not Ready).`,
      'Check the Vercel dashboard for the build error, then redeploy:',
      `  vercel inspect ${ref} --logs`,
      `  vercel redeploy ${ref}`
    ].join('\n');
  }
  const detail = redactSecrets(
    asTrimmed(inspect?.stderr || inspect?.stdout || ''),
    env
  );
  const snippet = detail
    ? detail.split('\n').slice(0, 8).join('\n')
    : '';
  return [
    `Could not read a deployment state from vercel inspect ${ref} --json (exit ${inspect?.code ?? 'unknown'}).`,
    'Check the Vercel dashboard, then redeploy if the build failed:',
    `  vercel inspect ${ref}`,
    `  vercel redeploy ${ref}`,
    snippet || null
  ].filter((line) => line != null).join('\n');
}

export async function waitForDeploymentReady({
  deploymentRef,
  inspect,
  timeoutMs = DEFAULT_VERCEL_READY_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_VERCEL_READY_POLL_MS,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  now = () => Date.now()
} = {}) {
  if (!deploymentRef) {
    return {
      ok: false,
      deploymentRef: null,
      state: null,
      timedOut: false,
      unparsed: true,
      inspect: null
    };
  }
  const started = now();
  for (;;) {
    const result = await inspect(deploymentRef);
    const state = parseInspectReadyState(result?.stdout);
    const kind = classifyDeploymentState(state);
    if (kind === 'ready') {
      return { ok: true, deploymentRef, state, timedOut: false, inspect: result };
    }
    if (kind === 'failed') {
      return { ok: false, deploymentRef, state, timedOut: false, inspect: result };
    }
    if (kind !== 'pending') {
      return {
        ok: false,
        deploymentRef,
        state,
        timedOut: false,
        unparsed: true,
        inspect: result
      };
    }
    if (now() - started >= timeoutMs) {
      return { ok: false, deploymentRef, state, timedOut: true, inspect: result };
    }
    const remaining = timeoutMs - (now() - started);
    await sleep(Math.max(0, Math.min(pollIntervalMs, remaining)));
    if (now() - started >= timeoutMs) {
      return { ok: false, deploymentRef, state, timedOut: true, inspect: result };
    }
  }
}

export function projectAddArgv(projectName) {
  return ['project', 'add', projectName];
}

export function projectLinkArgv(projectName) {
  return ['link', '--yes', '--project', projectName];
}

export function projectInspectArgv() {
  return ['project', 'inspect', '--json'];
}

function shellWord(value) {
  const text = String(value);
  if (/^[A-Za-z0-9._:@%+=,/~-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function projectAddDisplay(projectName) {
  return `vercel project add ${shellWord(projectName)}`;
}

export function projectLinkDisplay(projectName) {
  return `vercel link --yes --project ${shellWord(projectName)}`;
}

export function plannedEnsureCommands(projectName) {
  return [
    {
      argv: projectAddArgv(projectName),
      display: projectAddDisplay(projectName),
      note: 'idempotent — Vercel CLI exits 0 when the project already exists (HTTP 409). Skipped if this directory is already linked to this project name.'
    },
    {
      argv: projectLinkArgv(projectName),
      display: projectLinkDisplay(projectName),
      note: 'skipped if this directory is already linked to this project name. A different linked project fails closed (no retarget).'
    }
  ];
}

export function projectNamesMatch(left, right) {
  const a = asTrimmed(left).toLowerCase();
  const b = asTrimmed(right).toLowerCase();
  return Boolean(a) && a === b;
}

export function projectAddOk(result) {
  if (!result) return false;
  if (result.code === 0) return true;
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  return /already exists/i.test(text) || /\b409\b/.test(text);
}

export function readLinkedProject(cwd, {
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync
} = {}) {
  const file = path.join(cwd, '.vercel', 'project.json');
  if (!existsSync(file)) {
    return {
      linked: false,
      projectName: null,
      projectId: null,
      orgId: null,
      unreadable: false
    };
  }
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return {
      linked: true,
      projectName: null,
      projectId: null,
      orgId: null,
      unreadable: true
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      linked: true,
      projectName: null,
      projectId: null,
      orgId: null,
      unreadable: true
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      linked: true,
      projectName: null,
      projectId: null,
      orgId: null,
      unreadable: true
    };
  }
  return {
    linked: true,
    projectName: asTrimmed(parsed.projectName) || null,
    projectId: asTrimmed(parsed.projectId) || null,
    orgId: asTrimmed(parsed.orgId) || null,
    unreadable: false
  };
}

export function parseProjectInspectName(stdout) {
  const text = asTrimmed(stdout);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    const name = parsed?.name || parsed?.project?.name;
    return asTrimmed(name) || null;
  } catch {
    const match = text.match(/^\s*Name\s+(\S+)/im);
    return match ? match[1] : null;
  }
}

export function formatWrongProjectStop({ linkedName, projectName }) {
  return [
    `This directory is linked to Vercel project "${linkedName}", not "${projectName}".`,
    'Refusing to retarget another customer (no project add, no vercel link, no env changes).',
    `Pass --project ${linkedName} if that link is the customer you mean,`,
    `or use a checkout that is unlinked or already linked to ${projectName}.`,
    'Do not delete .vercel/project.json unless you have confirmed which customer it belongs to.'
  ].join('\n');
}

export function formatUnreadableLinkStop({ projectName }) {
  return [
    'This directory has .vercel/project.json but the linked project name could not be read.',
    `Refusing to retarget it onto ${projectName}.`,
    'Confirm which customer the link belongs to before removing .vercel/project.json.'
  ].join('\n');
}

export function formatEnsureFailure({ projectName, phase, code }) {
  return [
    `Failed to ${phase} Vercel project ${projectName} (vercel exit ${code}).`,
    'No env vars were changed.',
    VERCEL_GITHUB_LIMIT,
    'If the CLI cannot create the project (team permissions or scope), create it in the',
    'dashboard under the same team, then re-run. Do not attach this customer to another project.',
    `  vercel link --yes --project ${projectName}`
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
    ensureCommands: plannedEnsureCommands(projectName),
    envCommands,
    listProduction: {
      argv: listProductionArgv(),
      display: 'vercel ls --environment production'
    },
    redeployDisplay: 'vercel redeploy <latest-production-deployment> --yes',
    deployFallbackDisplay: 'vercel deploy --prod --yes',
    inspectDisplay: DEPLOYMENT_INSPECT_DISPLAY,
    readyWaitNote: readyWaitNote(),
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
    `  [ ] Ensure project ${projectName} (create if missing; reuse if it exists)`,
    `  [ ] Link this directory to ${projectName} (skip if already linked to that name)`,
    '  [ ] Stop if this directory is linked to a different project (do not retarget)',
    ...CUSTOMER_ENV_KEYS.flatMap((key) => VERCEL_ENV_TARGETS.map(
      (target) => `  [ ] Set ${key} on ${target}`
    )),
    `  [ ] Leave ${DEMO_PERSONA_SWITCHER_KEY} unset`,
    '  [ ] Redeploy so env takes effect',
    '  [ ] Wait until that Production deployment is Ready',
    '',
    'Commands that --apply would run (secrets stay in the shell / stdin, never argv):',
    `  ${plan.whoami.display}`,
    ...plan.ensureCommands.flatMap((cmd) => (
      cmd.note ? [`  ${cmd.display}`, `    (${cmd.note})`] : [`  ${cmd.display}`]
    )),
    ...plan.envCommands.map((cmd) => `  ${cmd.display}`),
    `  ${plan.listProduction.display}`,
    `  ${plan.redeployDisplay}`,
    `  (if no production deployment yet: ${plan.deployFallbackDisplay})`,
    `  ${plan.inspectDisplay}`,
    `    (${plan.readyWaitNote})`,
    '',
    VERCEL_GITHUB_LIMIT,
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
    'Production:     Ready',
    'DEMO_PERSONA_SWITCHER left unset',
    VERCEL_GITHUB_LIMIT,
    '',
    'Next (same TURSO_* already in this shell):',
    '  npm run provision:customer -- --with-org --email admin@customer.com --password \'…\'',
    `  BASE_URL=${url} npm run smoke`,
    '',
    'Secrets stay in this shell and in Vercel env — not in git.'
  ];
  return `${lines.join('\n')}\n`;
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

export async function ensureVercelProjectLink({
  projectName,
  cwd,
  runCommand,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
  stdout,
  stderr,
  env = process.env
} = {}) {
  const linked = readLinkedProject(cwd, { existsSync, readFileSync });
  if (linked.unreadable) {
    write(stderr, `${formatUnreadableLinkStop({ projectName })}\n`);
    return { ok: false, code: 1, skipped: false };
  }

  if (linked.linked) {
    let linkedName = linked.projectName;
    if (!linkedName) {
      write(
        stdout,
        'Linked .vercel/project.json has no projectName. Confirming with vercel project inspect --json…\n'
      );
      const inspected = await runCommand(projectInspectArgv());
      printCommandOutput(stdout, inspected.stdout, env);
      if (inspected.code !== 0) {
        write(
          stderr,
          'Could not confirm the linked Vercel project name (vercel project inspect --json failed).\n'
            + `Refusing to retarget this directory onto ${projectName}.\n`
        );
        printCommandOutput(stderr, inspected.stderr || inspected.stdout, env);
        return { ok: false, code: inspected.code || 1, skipped: false };
      }
      linkedName = parseProjectInspectName(inspected.stdout);
      if (!linkedName) {
        write(
          stderr,
          'vercel project inspect did not return a project name.\n'
            + `Refusing to retarget this directory onto ${projectName}.\n`
        );
        return { ok: false, code: 1, skipped: false };
      }
    }
    if (!projectNamesMatch(linkedName, projectName)) {
      write(stderr, `${formatWrongProjectStop({ linkedName, projectName })}\n`);
      return { ok: false, code: 1, skipped: false, wrongProject: true };
    }
    write(stdout, `Already linked to ${projectName} — skipping project add and link.\n`);
    return { ok: true, code: 0, skipped: true };
  }

  write(
    stdout,
    `Ensuring Vercel project ${projectName} (create if missing, reuse if it exists)…\n`
  );
  const added = await runCommand(projectAddArgv(projectName));
  printCommandOutput(stdout, added.stdout, env);
  if (!projectAddOk(added)) {
    write(stderr, `${formatEnsureFailure({ projectName, phase: 'create', code: added.code })}\n`);
    printCommandOutput(stderr, added.stderr || added.stdout, env);
    return { ok: false, code: added.code || 1, skipped: false };
  }
  if (added.code !== 0) {
    write(stdout, `Project ${projectName} already exists — reusing it.\n`);
  }

  write(stdout, `Linking this directory to ${projectName}…\n`);
  const link = await runCommand(projectLinkArgv(projectName));
  printCommandOutput(stdout, link.stdout, env);
  if (link.code !== 0) {
    write(stderr, `${formatEnsureFailure({ projectName, phase: 'link', code: link.code })}\n`);
    printCommandOutput(stderr, link.stderr || link.stdout, env);
    return { ok: false, code: link.code || 1, skipped: false };
  }
  return { ok: true, code: 0, skipped: false, linked: true };
}

export async function runVercelCustomerCli({
  argv = [],
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  cwd = process.cwd(),
  spawnFn = spawn,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
  sleep,
  now,
  pollIntervalMs = DEFAULT_VERCEL_READY_POLL_MS
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

  const ensured = await ensureVercelProjectLink({
    projectName,
    cwd,
    existsSync,
    readFileSync,
    stdout,
    stderr,
    env,
    runCommand: (commandArgs) => runVercelCommand(commandArgs, runOpts)
  });
  if (!ensured.ok) return ensured.code || 1;

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
  let deployStdout;
  if (target?.uid) {
    const redeploy = await runVercelCommand(redeployArgv(target.uid), runOpts);
    printCommandOutput(stdout, redeploy.stdout, env);
    if (redeploy.code !== 0) {
      write(stderr, `vercel redeploy failed (exit ${redeploy.code}).\n`);
      printCommandOutput(stderr, redeploy.stderr || redeploy.stdout, env);
      return 1;
    }
    deployStdout = redeploy.stdout;
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
    deployStdout = deployed.stdout;
  }

  const deploymentRef = pickDeploymentRef(deployStdout, { projectName });
  if (!deploymentRef) {
    write(stderr, `${formatMissingDeploymentRef()}\n`);
    return 1;
  }

  const timeoutMs = resolveReadyTimeoutMs(env);
  write(
    stdout,
    `Waiting for Production deployment ${deploymentRef} to become Ready`
      + ` (timeout ${timeoutMs} ms)…\n`
  );
  const waited = await waitForDeploymentReady({
    deploymentRef,
    timeoutMs,
    pollIntervalMs,
    sleep,
    now,
    inspect: (ref) => runVercelCommand(deploymentInspectArgv(ref), runOpts)
  });
  if (!waited.ok) {
    write(stderr, `${formatDeploymentWaitFailure({ ...waited, timeoutMs, env })}\n`);
    if (!waited.unparsed && waited.inspect?.stderr) {
      printCommandOutput(stderr, waited.inspect.stderr, env);
    }
    return 1;
  }
  write(stdout, `Production deployment ${deploymentRef} is Ready.\n`);

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
    redeployed: deploymentRef
  }));
  return 0;
}
