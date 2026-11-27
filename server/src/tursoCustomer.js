/**
 * Create or reuse one Turso group and two classic libSQL databases per
 * customer (production + preview), then mint the production shell exports
 * Vercel needs (URL, database token, SESSION_SECRET).
 *
 * Isolation stays one Turso group + one production DB + one preview DB +
 * one Vercel project per customer (not org_id). New databases are created
 * only in group procureflow-<slug>. Does not migrate, seed, call Vercel,
 * invalidate tokens, or destroy a database.
 * Dry-run never invents secrets. --apply prints production exports to stdout only.
 *
 *   npm run turso:customer -- --slug acme
 *   npm run turso:customer -- --slug acme --apply
 */

import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { reusedSessionSecretError } from './auth.js';
import {
  customerShellGuardError,
  previewDatabaseName,
  SECRET_SLUG_ENV
} from './customerShellGuard.js';
import {
  defaultProjectName,
  normalizeSlug,
  redactSecrets,
  runProcess,
  suggestedBaseUrl
} from './vercelCustomer.js';

export const DEFAULT_DB_PREFIX = 'procureflow-';

export const DEFAULT_TURSO_GROUP = 'default';

/** Optional operator override. Not a deployment variable and not read by the app. */
export const TURSO_MAX_GROUPS_ENV = 'TURSO_MAX_GROUPS';

export const PREVIEW_DATABASE_URL_NAME = 'TURSO_PREVIEW_DATABASE_URL';

export const PREVIEW_AUTH_TOKEN_NAME = 'TURSO_PREVIEW_AUTH_TOKEN';

export const DEFAULT_GROUP_REUSE_NOTE = 'Databases that already live in Turso\'s default group stay there until a person recreates them in group procureflow-<slug>. This command reuses them as-is. It does not move them, does not destroy them, and does not run `turso db tokens invalidate` (that invalidates every token in the group).';

export const WILL_MINT_PLACEHOLDER = '<will mint on --apply>';

export const TURSO_CUSTOMER_HELP = `ProcureFlow Turso customer database (classic libSQL)

Usage:
  npm run turso:customer -- --slug acme
  npm run turso:customer -- --slug acme --dry-run
  npm run turso:customer -- --slug acme --apply
  npm run turso:customer -- --db procureflow-acme --apply
  npm run turso:customer -- --slug acme --json

  --slug <customer>     Required unless --db can derive it. Default DB name
                        is procureflow-<slug> (lowercase). Group name is
                        procureflow-<slug>. Preview DB is <db>-preview.
  --db <name>           Override the production Turso database name (or derive
                        --slug from a procureflow-<slug> name). Preview name
                        is that name plus -preview.
  --location <code>     Passed only to \`turso group create\` when the group
                        is missing. Omitted unless you set it. No fleet region
                        is hard-coded. An existing group is not moved.
  --max-groups <n>      Optional group-quota override (non-negative integer).
                        Same as ${TURSO_MAX_GROUPS_ENV} in the environment;
                        this flag wins when both are set. Not a deployment
                        variable. When the quota is known (from this override
                        or from \`turso group list\` output) and one new group
                        would exceed it, --apply exits non-zero and does not
                        create the databases in the default group.
  --dry-run             Print the planned turso commands + export placeholders
                        (default). Exit 0. Never calls Turso. No network required.
                        Does not invent or print fake secrets.
  --apply               Read \`turso group list\`, create or reuse group
                        procureflow-<slug>, create or reuse the production and
                        preview databases in that group, mint a production
                        database token, generate SESSION_SECRET unless already
                        set in this shell, and print shell-ready production
                        exports. Preview env names are printed. Preview env
                        values are not written to Vercel.
                        A SESSION_SECRET already set must be at least 32
                        characters or this command refuses it (the value is
                        not printed). Generate: openssl rand -hex 32
                        Requires Turso CLI and turso auth login.
  --json                Machine-readable summary. Tokens are redacted to the
                        last 4 characters in JSON. On --apply, full export
                        lines are still printed on human stdout.
  --help, -h            Show this help

Does not migrate, seed, call Vercel, or destroy a database.
Does not call \`turso db tokens invalidate\` or \`turso db destroy\`.
Classic libSQL only — never passes --tursodb. New databases are never
created in the org default group.
Token is turso db tokens create (production database token), not an org JWT.
Preview URL name ${PREVIEW_DATABASE_URL_NAME} is reported for a later step.
This command does not mint a preview token and does not write preview env.

Shell guard (before any Turso process): a TURSO_DATABASE_URL already in
this shell must name procureflow-<slug> (or --db). TURSO_PREVIEW_DATABASE_URL,
when set, must name that database plus -preview. TURSO_AUTH_TOKEN,
TURSO_PREVIEW_AUTH_TOKEN, SESSION_SECRET, PORTAL_TOKEN_SECRET, CRON_SECRET,
and WEBHOOK_SIGNING_SECRET, when set, require ${SECRET_SLUG_ENV} equal to
the slug. A host such as procureflow-beta with --slug acme exits non-zero.
The message names the variable and the slug and does not print the value.
${SECRET_SLUG_ENV} is not a secret and is not written to Vercel.

Happy path:
  Preferred: npm run onboard:customer -- --slug <slug> [--apply --email … --password …]
  1. npm run turso:customer -- --slug <slug>            # dry-run
  2. npm run turso:customer -- --slug <slug> --apply    # print exports
  3. npm run vercel:customer -- --slug <slug>           # dry-run (project add + link + env)
  4. npm run vercel:customer -- --slug <slug> --apply   # ensure project, link, env, redeploy
  5. npm run provision:customer -- --with-org --email … --password …
  6. BASE_URL=https://procureflow-<slug>.vercel.app npm run smoke
  GitHub auto-deploy is not connected by vercel project add.

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

export function defaultDatabaseName(slug) {
  const normalized = asTrimmed(slug).toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith(DEFAULT_DB_PREFIX)) return normalized;
  return `${DEFAULT_DB_PREFIX}${normalized}`;
}

export function normalizeDatabaseName(raw) {
  const name = asTrimmed(raw).toLowerCase();
  if (!name) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) return null;
  if (name.length > 64) return null;
  return name;
}

export function slugFromDatabaseName(dbName) {
  const name = asTrimmed(dbName).toLowerCase();
  if (!name) return null;
  if (name.startsWith(DEFAULT_DB_PREFIX) && name.length > DEFAULT_DB_PREFIX.length) {
    return normalizeSlug(name.slice(DEFAULT_DB_PREFIX.length));
  }
  return normalizeSlug(name);
}

export function resolveCustomerIdentity({ slug, db } = {}) {
  const rawSlug = asTrimmed(slug);
  const rawDb = asTrimmed(db);

  let resolvedSlug = rawSlug ? normalizeSlug(rawSlug) : null;
  if (rawSlug && !resolvedSlug) {
    return { error: 'invalid-slug', slug: rawSlug, db: rawDb || null };
  }

  let dbName = rawDb ? normalizeDatabaseName(rawDb) : null;
  if (rawDb && !dbName) {
    return { error: 'invalid-db', slug: resolvedSlug, db: rawDb };
  }

  if (!resolvedSlug && dbName) {
    resolvedSlug = slugFromDatabaseName(dbName);
    if (!resolvedSlug) {
      return { error: 'slug-required', slug: null, db: dbName };
    }
  }

  if (!resolvedSlug) {
    return { error: 'slug-required', slug: null, db: dbName };
  }

  if (!dbName) {
    dbName = defaultDatabaseName(resolvedSlug);
  }

  const projectName = defaultProjectName(resolvedSlug);
  return {
    error: null,
    slug: resolvedSlug,
    dbName,
    projectName,
    baseUrl: suggestedBaseUrl(projectName)
  };
}

export function parseTursoCustomerArgs(argv = []) {
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
    if (
      arg === '--slug' || arg.startsWith('--slug=')
      || arg === '--db' || arg.startsWith('--db=')
      || arg === '--location' || arg.startsWith('--location=')
      || arg === '--max-groups' || arg.startsWith('--max-groups=')
    ) {
      const rawKey = arg.replace(/^--/, '').split('=')[0];
      const key = rawKey === 'max-groups' ? 'maxGroups' : rawKey;
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
    json: flags.has('json'),
    tursodb: flags.has('tursodb'),
    slug: values.slug != null ? String(values.slug).trim() : null,
    db: values.db != null ? String(values.db).trim() : null,
    location: values.location != null ? String(values.location).trim() : null,
    maxGroups: values.maxGroups != null ? String(values.maxGroups).trim() : null,
    unknown
  };
}

export function customerGroupName(slug) {
  const normalized = asTrimmed(slug).toLowerCase();
  if (!normalized) return null;
  return `${DEFAULT_DB_PREFIX}${normalized}`;
}

export function normalizeLocation(raw) {
  if (raw == null || asTrimmed(raw) === '') {
    return { error: 'missing', location: null };
  }
  const location = asTrimmed(raw).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(location)) {
    return { error: 'invalid', location: null };
  }
  return { error: null, location };
}

export function parseMaxGroups(raw) {
  if (raw == null || asTrimmed(raw) === '') {
    return { set: false, error: null, value: null };
  }
  const text = asTrimmed(raw);
  if (!/^\d+$/.test(text)) {
    return { set: true, error: 'invalid', value: null };
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    return { set: true, error: 'invalid', value: null };
  }
  return { set: true, error: null, value };
}

export function resolveMaxGroups({ flag, env = {} } = {}) {
  const fromFlag = parseMaxGroups(flag);
  if (fromFlag.set) return { ...fromFlag, source: 'flag' };
  const fromEnv = parseMaxGroups(env[TURSO_MAX_GROUPS_ENV]);
  if (fromEnv.set) return { ...fromEnv, source: 'env' };
  return { set: false, error: null, value: null, source: null };
}

function displayCommand(argv) {
  return `turso ${argv.join(' ')}`;
}

export function plannedTursoCommands(dbName, { slug, location = null } = {}) {
  const resolvedSlug = slug || slugFromDatabaseName(dbName);
  const groupName = customerGroupName(resolvedSlug);
  const previewName = previewDatabaseName(dbName);
  const groupArgv = ['group', 'create', groupName];
  if (location) groupArgv.push('--location', location);
  const prodCreate = ['db', 'create', dbName, '--group', groupName];
  const previewCreate = ['db', 'create', previewName, '--group', groupName];
  return [
    {
      kind: 'whoami',
      argv: ['auth', 'whoami'],
      display: 'turso auth whoami'
    },
    {
      kind: 'group-list',
      argv: ['group', 'list'],
      display: 'turso group list',
      note: 'read groups and quota before any create'
    },
    {
      kind: 'group-create',
      argv: groupArgv,
      display: displayCommand(groupArgv),
      note: 'only if the group is missing and a new group fits the quota'
    },
    {
      kind: 'show',
      argv: ['db', 'show', dbName],
      display: `turso db show ${dbName}`,
      note: 'existence check; reuse if present, including a database already in the default group'
    },
    {
      kind: 'create',
      argv: prodCreate,
      display: displayCommand(prodCreate),
      note: 'only if missing; never --tursodb; never the default group'
    },
    {
      kind: 'show-preview',
      argv: ['db', 'show', previewName],
      display: `turso db show ${previewName}`,
      note: 'existence check for the preview database'
    },
    {
      kind: 'create-preview',
      argv: previewCreate,
      display: displayCommand(previewCreate),
      note: 'only if missing; never --tursodb; never the default group'
    },
    {
      kind: 'url',
      argv: ['db', 'show', dbName, '--url'],
      display: `turso db show ${dbName} --url`
    },
    {
      kind: 'token',
      argv: ['db', 'tokens', 'create', dbName],
      display: `turso db tokens create ${dbName}`,
      note: 'production database token, not an org JWT; preview token is not minted here'
    }
  ];
}

function parseGroupListJson(text) {
  const start = text.search(/[[{]/);
  if (start === -1) return null;
  const slice = text.slice(start);
  let parsed;
  try {
    parsed = JSON.parse(slice);
  } catch {
    const end = Math.max(slice.lastIndexOf(']'), slice.lastIndexOf('}'));
    if (end === -1) return null;
    try {
      parsed = JSON.parse(slice.slice(0, end + 1));
    } catch {
      return null;
    }
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : (parsed && Array.isArray(parsed.groups) ? parsed.groups : null);
  if (!rows) return null;
  const groups = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const name = asTrimmed(row.name || row.Name).toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) continue;
    const locations = Array.isArray(row.locations)
      ? row.locations.join(', ')
      : asTrimmed(row.locations || row.location || row.primary || '');
    groups.push({ name, locations });
  }
  return groups;
}

export function parseTursoGroupList(stdout) {
  const text = asTrimmed(stdout);
  if (!text) return [];
  const fromJson = parseGroupListJson(text);
  if (fromJson) return fromJson;
  const groups = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^[-+|=\s]+$/.test(trimmed)) continue;
    if (/^(name|group)\b/i.test(trimmed) && /location/i.test(trimmed)) continue;
    if (/\bgroups?\b/i.test(trimmed) && /\d/.test(trimmed)) continue;
    if (/^\d+\b/.test(trimmed)) continue;
    const cols = trimmed.includes('\t') || /\s{2,}/.test(trimmed)
      ? trimmed.split(/\s{2,}|\t+/).map((part) => part.trim()).filter(Boolean)
      : trimmed.split(/\s+/);
    const name = asTrimmed(cols[0]).toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) continue;
    if (/^(name|locations|primary|version)$/.test(name)) continue;
    groups.push({
      name,
      locations: cols.slice(1).join(' ')
    });
  }
  return groups;
}

export function parseTursoGroupQuota(stdout) {
  const text = asTrimmed(stdout);
  if (!text) return { max: null, used: null };
  let max = null;
  let used = null;
  const ratio = text.match(/(\d+)\s+of\s+(\d+)\s+groups?/i)
    || text.match(/(\d+)\s*\/\s*(\d+)\s*groups?/i)
    || text.match(/groups?\s*[:=]\s*(\d+)\s*\/\s*(\d+)/i);
  if (ratio) {
    used = Number(ratio[1]);
    max = Number(ratio[2]);
  }
  const maxOnly = text.match(/"(?:quota|max_groups|maxGroups|group_limit|groupLimit)"\s*:\s*(\d+)/)
    || text.match(/\b(?:max(?:imum)?|quota|limit)\s+groups?\s*[:=]?\s*(\d+)/i)
    || text.match(/\bgroups?\s+(?:quota|limit|max(?:imum)?)\s*[:=]?\s*(\d+)/i);
  if (max == null && maxOnly) max = Number(maxOnly[1]);
  return { max, used };
}

export function parseTursoDbGroup(stdout) {
  const text = asTrimmed(stdout);
  if (!text) return null;
  const labeled = text.match(/^\s*group\s*:\s*([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\s*$/im);
  if (labeled) return labeled[1].toLowerCase();
  const json = text.match(/"group"\s*:\s*"([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)"/i);
  if (json) return json[1].toLowerCase();
  return null;
}

export function isDefaultTursoGroup(name) {
  return asTrimmed(name).toLowerCase() === DEFAULT_TURSO_GROUP;
}

/**
 * True when creating one missing group would pass a known quota.
 * A null max means the quota could not be determined.
 */
export function groupQuotaWouldBlock({
  groupExists,
  mustCreateGroup,
  groupCount,
  parsedUsed = null,
  maxGroups = null
} = {}) {
  const used = Math.max(Number(groupCount) || 0, parsedUsed == null ? 0 : Number(parsedUsed));
  if (!mustCreateGroup || groupExists || maxGroups == null) {
    return { blocked: false, used, max: maxGroups };
  }
  return { blocked: used + 1 > maxGroups, used, max: maxGroups };
}

export function generateSessionSecret({ randomBytesFn = randomBytes } = {}) {
  return randomBytesFn(32).toString('hex');
}

export function resolveSessionSecret(env = {}, { randomBytesFn = randomBytes } = {}) {
  const tooShort = reusedSessionSecretError(env);
  if (tooShort) throw tooShort;
  const existing = asTrimmed(env.SESSION_SECRET);
  if (existing) {
    return { value: existing, source: 'reuse-from-env' };
  }
  return {
    value: generateSessionSecret({ randomBytesFn }),
    source: 'minted'
  };
}

export function redactSecretTail(value) {
  const text = asTrimmed(value);
  if (!text) return null;
  const tail = text.slice(-4);
  return `…${tail}`;
}

export function shellExportLine(key, value) {
  const escaped = String(value).replace(/'/g, `'\\''`);
  return `export ${key}='${escaped}'`;
}

export function looksLikeMissingDatabase(stdout, stderr) {
  const text = `${asTrimmed(stdout)}\n${asTrimmed(stderr)}`;
  return /not found|does not exist|couldn['’]?t find|could not find|unknown database|no such database|database .* not found/i.test(text);
}

export function looksLikeAlreadyExists(stdout, stderr) {
  const text = `${asTrimmed(stdout)}\n${asTrimmed(stderr)}`;
  return /already exists|already created/i.test(text);
}

export function parseTursoUrl(stdout) {
  const text = asTrimmed(stdout);
  if (!text) return null;
  const match = text.match(/libsql:\/\/[^\s"'`]+/i)
    || text.match(/https:\/\/[^\s"'`]+/i);
  if (match) {
    return match[0].replace(/[.,;]+$/, '');
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (last && !/\s/.test(last) && /:\/\//.test(last)) return last;
  return null;
}

export function parseTursoToken(stdout) {
  const text = asTrimmed(stdout);
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].replace(/^["']|["']$/g, '');
    if (!line || /\s/.test(line)) continue;
    if (line.startsWith('eyJ') || line.length >= 20) return line;
  }
  return null;
}

export function resolveTursoBin(env = process.env) {
  const override = asTrimmed(env.TURSO_CLI);
  return override || 'turso';
}

function previewEnvLines() {
  return [
    'Preview env names for a later Preview step (not written to Vercel by this command):',
    `  ${PREVIEW_DATABASE_URL_NAME}`,
    `  ${PREVIEW_AUTH_TOKEN_NAME}`,
    'Production URL, production token, and SESSION_SECRET are not placed on Preview by this command.'
  ];
}

export function formatDryRunReport({
  slug,
  dbName,
  projectName,
  env = process.env,
  location = null,
  maxGroups = null
} = {}) {
  const groupName = customerGroupName(slug);
  const previewName = previewDatabaseName(dbName);
  const commands = plannedTursoCommands(dbName, { slug, location });
  const sessionSet = Boolean(asTrimmed(env.SESSION_SECRET));
  const lines = [
    'ProcureFlow Turso customer database (dry-run — no Turso mutation)',
    '',
    `Customer slug:  ${slug}`,
    `Group:          ${groupName}`,
    `Database name:  ${dbName}`,
    `Preview DB:     ${previewName}`,
    `Location:       ${location || '(none — pass --location to set the group location; no region is hard-coded)'}`,
    `Vercel project: ${projectName} (vercel:customer --apply creates/links it; this command never calls Vercel)`,
    '',
    'Isolation: one group and two classic libSQL databases per customer. Never --tursodb.',
    'New databases are created only with --group ' + groupName + '. Never in the default group.',
    'Token: turso db tokens create (production database token), not an org JWT.',
    'Existing databases are reused, including ones already in the default group. This command never destroys a DB.',
    DEFAULT_GROUP_REUSE_NOTE,
    '',
    maxGroups == null
      ? 'Group quota: read from `turso group list` on --apply. Optional override: --max-groups or TURSO_MAX_GROUPS (not a deployment variable).'
      : `Group quota override: ${maxGroups} (--max-groups or ${TURSO_MAX_GROUPS_ENV}). Not a deployment variable.`,
    'If one new group would exceed a known quota, --apply stops and does not use the default group.',
    '',
    'Commands --apply would run:',
    ...commands.flatMap((cmd) => (
      cmd.note ? [`  ${cmd.display}`, `    (${cmd.note})`] : [`  ${cmd.display}`]
    )),
    '',
    ...previewEnvLines(),
    '',
    'Exports you will need (placeholders — secrets are not invented in dry-run):',
    `  export TURSO_DATABASE_URL='${WILL_MINT_PLACEHOLDER}'`,
    `  export TURSO_AUTH_TOKEN='${WILL_MINT_PLACEHOLDER}'`,
    sessionSet
      ? '  export SESSION_SECRET=\'<reuse existing SESSION_SECRET from this environment — not printed>\''
      : `  export SESSION_SECRET='${WILL_MINT_PLACEHOLDER}'`,
    `  export ${SECRET_SLUG_ENV}='${slug}'`,
    '',
    `${SECRET_SLUG_ENV} labels this shell. It is not a secret and is not written to Vercel.`,
    'Set it to this slug before reusing a token or a generated secret on the next command.',
    '',
    sessionSet
      ? 'SESSION_SECRET is already set in this environment and will be reused (not rotated).'
      : 'SESSION_SECRET will mint on --apply (32-byte hex) unless you export one first.',
    '',
    'Does not migrate, seed, call Vercel, invalidate tokens, or destroy a database.',
    '',
    'Next:',
    `  npm run turso:customer -- --slug ${slug} --apply`,
    `  npm run vercel:customer -- --slug ${slug} --apply   # project add + link if needed, then env`,
    '  npm run provision:customer -- --with-org --email admin@customer.com --password \'…\'',
    `  BASE_URL=${suggestedBaseUrl(projectName)} npm run smoke`
  ];
  return `${lines.join('\n')}\n`;
}

export function formatApplyReport({
  slug,
  dbName,
  projectName,
  created,
  sessionSource,
  previewDbName,
  previewCreated = null,
  groupName = null,
  groupCreated = null,
  defaultGroupDatabases = []
} = {}) {
  const previewState = previewCreated == null
    ? 'see above'
    : (previewCreated ? 'created (classic libSQL)' : 'reused (already existed)');
  const groupState = groupCreated == null
    ? ''
    : (groupCreated ? 'created' : 'reused (already existed)');
  const lines = [
    'ProcureFlow Turso customer database applied',
    '',
    `Customer slug:  ${slug}`,
    `Group:          ${groupName || customerGroupName(slug)}${groupState ? ` (${groupState})` : ''}`,
    `Database name:  ${dbName}`,
    `Database:       ${created ? 'created (classic libSQL)' : 'reused (already existed)'}`,
    `Preview DB:     ${previewDbName || previewDatabaseName(dbName)} (${previewState})`,
    `SESSION_SECRET: ${sessionSource === 'reuse-from-env' ? 'reused from this environment' : 'minted (32-byte hex)'}`,
    'Token:          production database token from turso db tokens create (not an org JWT)',
    '',
    ...previewEnvLines(),
    '',
    'Copy the export lines above into this shell (and a password manager).',
    'Secrets are printed once on stdout — not written to git.',
    ''
  ];
  if (defaultGroupDatabases.length) {
    lines.push(
      `Still in the default group: ${defaultGroupDatabases.join(', ')}.`,
      DEFAULT_GROUP_REUSE_NOTE,
      ''
    );
  }
  lines.push(
    'Next:',
    `  npm run vercel:customer -- --slug ${slug} --apply   # project add + link if needed, then env`,
    '  npm run provision:customer -- --with-org --email admin@customer.com --password \'…\'',
    `  BASE_URL=${suggestedBaseUrl(projectName)} npm run smoke`
  );
  return `${lines.join('\n')}\n`;
}

export function buildJsonSummary({
  mode,
  slug,
  dbName,
  projectName,
  created = null,
  url = null,
  token = null,
  sessionSecret = null,
  sessionSource = null,
  location = null,
  previewCreated = null,
  groupCreated = null,
  defaultGroupDatabases = []
} = {}) {
  const apply = mode === 'apply';
  const sessionSet = Boolean(asTrimmed(sessionSecret));
  const groupName = customerGroupName(slug);
  const previewDbName = previewDatabaseName(dbName);
  return {
    ok: true,
    mode,
    slug,
    dbName,
    groupName,
    previewDbName,
    previewDatabaseUrlName: PREVIEW_DATABASE_URL_NAME,
    previewAuthTokenName: PREVIEW_AUTH_TOKEN_NAME,
    previewEnvWritten: false,
    location: location || null,
    projectName,
    created: apply ? Boolean(created) : null,
    reused: apply ? !created : null,
    previewCreated: apply ? Boolean(previewCreated) : null,
    groupCreated: apply ? Boolean(groupCreated) : null,
    defaultGroupDatabases: apply ? defaultGroupDatabases : [],
    classicLibsql: true,
    tursodb: false,
    tokenKind: 'database',
    tursoDatabaseUrl: apply ? url : WILL_MINT_PLACEHOLDER,
    tursoAuthToken: apply ? redactSecretTail(token) : WILL_MINT_PLACEHOLDER,
    sessionSecret: apply
      ? redactSecretTail(sessionSecret)
      : (sessionSet ? 'reuse-from-env' : WILL_MINT_PLACEHOLDER),
    sessionSecretSource: apply
      ? sessionSource
      : (sessionSet ? 'reuse-from-env' : 'will-mint-on-apply'),
    commands: plannedTursoCommands(dbName, { slug, location }).map((cmd) => cmd.display),
    note: apply
      ? 'JSON redacts TURSO_AUTH_TOKEN and SESSION_SECRET to last 4 chars. Full values are on the export lines above. Preview env is not written.'
      : 'Dry-run does not invent secrets. Use --apply to mint the production URL, database token, and SESSION_SECRET. Preview env names are reported and not written.'
  };
}

function identityErrorMessage(identity, help = TURSO_CUSTOMER_HELP) {
  if (identity.error === 'invalid-slug') {
    return `Invalid --slug "${identity.slug}". Use a lowercase customer short name (letters, numbers, hyphens), e.g. acme.\n`;
  }
  if (identity.error === 'invalid-db') {
    return `Invalid --db "${identity.db}". Use a lowercase Turso database name (letters, numbers, hyphens), e.g. procureflow-acme.\n`;
  }
  return (
    '--slug is required (example: --slug acme → database procureflow-acme).\n'
      + 'Or pass --db procureflow-acme to derive the slug.\n'
      + help
  );
}

async function runTursoCommand(args, { spawnFn, cwd, env, tursoBin }) {
  return runProcess(tursoBin, args, {
    spawnFn,
    cwd,
    env
  });
}

function printCommandOutput(stream, text, env) {
  const redacted = redactSecrets(asTrimmed(text), env);
  if (redacted) write(stream, `${redacted}\n`);
}

function forbiddenTursoArgv(argv) {
  if (argv.includes('--tursodb') || argv.includes('invalidate') || argv.includes('destroy')) {
    return 'Refusing to run turso db tokens invalidate, turso db destroy, or --tursodb.';
  }
  if (argv[0] === 'db' && argv[1] === 'create') {
    const groupIdx = argv.indexOf('--group');
    const group = groupIdx === -1 ? '' : asTrimmed(argv[groupIdx + 1]);
    if (!group || group === DEFAULT_TURSO_GROUP) {
      return 'Refusing to create a database in the default group.';
    }
  }
  return null;
}

function classifyDbShow(result) {
  if (result.code === 0) return 'exists';
  if (looksLikeMissingDatabase(result.stdout, result.stderr)) return 'missing';
  return 'error';
}

function formatQuotaStop({ groupName, used, max }) {
  const noun = used === 1 ? 'group' : 'groups';
  return [
    `Stopping: creating group ${groupName} would exceed the Turso group quota (${used} ${noun} present, limit ${max}).`,
    'This command does not create the group and does not create databases in the default group.',
    'No create command was run.'
  ].join('\n');
}

export function tursoCustomerCliCode(result) {
  if (result && typeof result === 'object' && typeof result.code === 'number') {
    return result.code;
  }
  return result;
}

export function tursoCustomerExports(result) {
  if (result && typeof result === 'object' && result.exports && typeof result.exports === 'object') {
    return result.exports;
  }
  return null;
}

export async function runTursoCustomerCli({
  argv = [],
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  cwd = process.cwd(),
  spawnFn = spawn,
  randomBytesFn = randomBytes,
  returnResult = false
} = {}) {
  const finish = (code, extras = {}) => (
    returnResult
      ? { code, exports: extras.exports || null }
      : code
  );

  const args = parseTursoCustomerArgs(argv);
  if (args.help) {
    write(stdout, TURSO_CUSTOMER_HELP);
    return finish(0);
  }
  if (args.seed) {
    write(
      stderr,
      'turso:customer never seeds and does not migrate.\n'
        + 'Real customer: turso:customer --apply, then vercel:customer --apply, then npm run provision:customer.\n'
        + 'Demo wipe (destructive): npm run seed\n'
    );
    return finish(1);
  }
  if (args.tursodb) {
    write(
      stderr,
      'turso:customer never passes --tursodb. ProcureFlow uses classic libSQL only.\n'
        + 'Create/reuse with: npm run turso:customer -- --slug <customer> --apply\n'
    );
    return finish(1);
  }
  if (args.unknown.length) {
    write(stderr, `Unknown argument: ${args.unknown[0]}\n${TURSO_CUSTOMER_HELP}`);
    return finish(1);
  }
  if (args.apply && args.dryRunFlag) {
    write(stderr, 'Use either --dry-run (default) or --apply, not both.\n');
    return finish(1);
  }

  const identity = resolveCustomerIdentity({ slug: args.slug, db: args.db });
  if (identity.error) {
    write(stderr, identityErrorMessage(identity));
    return finish(1);
  }

  const { slug, dbName, projectName } = identity;

  const shortSecret = reusedSessionSecretError(env);
  if (shortSecret) {
    write(stderr, `${shortSecret.message}\n`);
    return finish(1);
  }

  const shellGuard = customerShellGuardError({ env, slug, dbName });
  if (shellGuard) {
    write(stderr, `${shellGuard.message}\n`);
    return finish(1);
  }

  const groupName = customerGroupName(slug);
  const previewDbName = previewDatabaseName(dbName);
  if (!normalizeDatabaseName(groupName) || !normalizeDatabaseName(previewDbName) || previewDbName === dbName) {
    write(
      stderr,
      `Preview database name for ${dbName} must be ${dbName}-preview and fit Turso's 64-character name limit. Group ${groupName} must fit the same limit.\n`
    );
    return finish(1);
  }

  let location = null;
  if (args.location != null) {
    const parsedLocation = normalizeLocation(args.location);
    if (parsedLocation.error) {
      write(
        stderr,
        'Invalid --location. Pass a short location code (letters, numbers, hyphens). The value was not printed. No region is hard-coded.\n'
      );
      return finish(1);
    }
    location = parsedLocation.location;
  }

  const maxResolved = resolveMaxGroups({ flag: args.maxGroups, env });
  if (args.maxGroups != null && asTrimmed(args.maxGroups) === '') {
    write(stderr, 'Invalid --max-groups. Use a non-negative integer. The value was not printed.\n');
    return finish(1);
  }
  if (maxResolved.error) {
    const source = maxResolved.source === 'flag' ? '--max-groups' : TURSO_MAX_GROUPS_ENV;
    write(stderr, `Invalid ${source}. Use a non-negative integer. The value was not printed.\n`);
    return finish(1);
  }

  if (!args.apply) {
    write(stdout, formatDryRunReport({
      slug,
      dbName,
      projectName,
      env,
      location,
      maxGroups: maxResolved.value
    }));
    if (args.json) {
      write(stdout, `${JSON.stringify(buildJsonSummary({
        mode: 'dry-run',
        slug,
        dbName,
        projectName,
        sessionSecret: env.SESSION_SECRET,
        location
      }), null, 2)}\n`);
    }
    return finish(0);
  }

  const tursoBin = resolveTursoBin(env);
  const childEnv = { ...process.env, ...env };
  const runOpts = {
    spawnFn,
    cwd,
    env: childEnv,
    tursoBin
  };

  write(stdout, `Applying Turso group ${groupName} and databases ${dbName} + ${previewDbName} (classic libSQL)…\n`);

  async function runChecked(argvParts) {
    const blocked = forbiddenTursoArgv(argvParts);
    if (blocked) {
      write(stderr, `${blocked}\n`);
      return { code: 1, stdout: '', stderr: blocked, refused: true };
    }
    return runTursoCommand(argvParts, runOpts);
  }

  const whoami = await runChecked(['auth', 'whoami']);
  if (whoami.code === 127) {
    write(
      stderr,
      'Turso CLI was not found on PATH. Install it and log in:\n'
        + '  curl -sSfL https://get.tur.so/install.sh | bash\n'
        + '  turso auth login\n'
        + `Dry-run needs no CLI: npm run turso:customer -- --slug ${slug}\n`
    );
    return finish(1);
  }
  if (whoami.code !== 0) {
    write(
      stderr,
      'Turso CLI is not logged in. Run: turso auth login\n'
    );
    printCommandOutput(stderr, whoami.stderr || whoami.stdout, env);
    return finish(1);
  }
  printCommandOutput(stdout, whoami.stdout, env);

  const listed = await runChecked(['group', 'list']);
  if (listed.code !== 0) {
    write(
      stderr,
      `Could not read Turso groups (turso group list, exit ${listed.code}).\n`
        + 'This command will not create databases in the default group.\n'
    );
    printCommandOutput(stderr, listed.stderr || listed.stdout, env);
    return finish(1);
  }
  const listText = `${listed.stdout || ''}\n${listed.stderr || ''}`;
  const groups = parseTursoGroupList(listText);
  const parsedQuota = parseTursoGroupQuota(listText);
  const groupRow = groups.find((group) => group.name === groupName) || null;
  const groupExists = Boolean(groupRow);
  const groupNames = groups.map((group) => group.name);
  write(
    stdout,
    `Turso groups: ${groupNames.length ? groupNames.join(', ') : '(none listed)'}`
      + ` (${groups.length}).\n`
  );

  async function inspectDatabase(name) {
    const shown = await runChecked(['db', 'show', name]);
    const status = classifyDbShow(shown);
    if (status === 'error') {
      write(
        stderr,
        `Could not check whether Turso database ${name} exists (turso exit ${shown.code}).\n`
          + 'Confirm turso auth login and that the name is correct. This command will not destroy a DB.\n'
      );
      printCommandOutput(stderr, shown.stderr || shown.stdout, env);
      return { error: true };
    }
    return {
      error: false,
      status,
      group: status === 'exists' ? parseTursoDbGroup(`${shown.stdout}\n${shown.stderr}`) : null
    };
  }

  const production = await inspectDatabase(dbName);
  if (production.error) return finish(1);
  const preview = await inspectDatabase(previewDbName);
  if (preview.error) return finish(1);

  const mustCreateGroup = !groupExists && (
    production.status === 'missing' || preview.status === 'missing'
  );
  const quotaMax = maxResolved.value != null ? maxResolved.value : parsedQuota.max;
  const quota = groupQuotaWouldBlock({
    groupExists,
    mustCreateGroup,
    groupCount: groups.length,
    parsedUsed: parsedQuota.used,
    maxGroups: quotaMax
  });
  if (quota.blocked) {
    write(stderr, `${formatQuotaStop({ groupName, used: quota.used, max: quota.max })}\n`);
    return finish(1);
  }

  let groupCreated = false;
  if (groupExists) {
    write(stdout, `Group ${groupName} already exists — reusing (will not destroy).\n`);
    if (location && groupRow && asTrimmed(groupRow.locations)) {
      const places = groupRow.locations.toLowerCase().split(/[,\s]+/).filter(Boolean);
      if (!places.includes(location)) {
        write(
          stdout,
          `Group ${groupName} is already at ${groupRow.locations}. --location ${location} was not applied. Groups are not moved.\n`
        );
      }
    }
  } else if (mustCreateGroup) {
    const groupArgv = ['group', 'create', groupName];
    if (location) groupArgv.push('--location', location);
    write(stdout, `Creating group ${groupName}${location ? ` in ${location}` : ''}…\n`);
    const createdGroup = await runChecked(groupArgv);
    printCommandOutput(stdout, createdGroup.stdout, env);
    if (createdGroup.code !== 0) {
      if (looksLikeAlreadyExists(createdGroup.stdout, createdGroup.stderr)) {
        write(stdout, `Group ${groupName} already exists — reusing (will not destroy).\n`);
      } else {
        write(
          stderr,
          `Failed to create Turso group ${groupName} (turso exit ${createdGroup.code}).\n`
            + 'This command does not create databases in the default group.\n'
        );
        printCommandOutput(stderr, createdGroup.stderr || createdGroup.stdout, env);
        return finish(1);
      }
    } else {
      groupCreated = true;
    }
  }

  async function ensureDatabase(name, inspection) {
    if (inspection.status === 'exists') {
      write(stdout, `Database ${name} already exists — reusing (will not destroy).\n`);
      if (isDefaultTursoGroup(inspection.group)) {
        write(stdout, `${name} is in the default group. ${DEFAULT_GROUP_REUSE_NOTE}\n`);
        return { created: false, defaultGroup: true };
      }
      if (inspection.group && inspection.group !== groupName) {
        write(
          stdout,
          `${name} is in group ${inspection.group}, not ${groupName}. It is reused as-is and is not moved.\n`
        );
      }
      return { created: false, defaultGroup: false };
    }
    write(
      stdout,
      `Creating classic libSQL database ${name} in group ${groupName} (never --tursodb)…\n`
    );
    const createdResult = await runChecked(['db', 'create', name, '--group', groupName]);
    printCommandOutput(stdout, createdResult.stdout, env);
    if (createdResult.code !== 0) {
      if (looksLikeAlreadyExists(createdResult.stdout, createdResult.stderr)) {
        write(stdout, `Database ${name} already exists — reusing (will not destroy).\n`);
        return { created: false, defaultGroup: false };
      }
      write(
        stderr,
        `Failed to create Turso database ${name} (turso exit ${createdResult.code}).\n`
          + 'Classic libSQL only — this command never passes --tursodb and does not fall back to the default group.\n'
      );
      printCommandOutput(stderr, createdResult.stderr || createdResult.stdout, env);
      return { error: true };
    }
    return { created: true, defaultGroup: false };
  }

  const productionOutcome = await ensureDatabase(dbName, production);
  if (productionOutcome.error) return finish(1);
  const previewOutcome = await ensureDatabase(previewDbName, preview);
  if (previewOutcome.error) return finish(1);
  const created = productionOutcome.created;
  const defaultGroupDatabases = [dbName, previewDbName].filter((name, index) => (
    index === 0 ? productionOutcome.defaultGroup : previewOutcome.defaultGroup
  ));

  const urlResult = await runChecked(['db', 'show', dbName, '--url']);
  if (urlResult.code !== 0) {
    write(stderr, `Failed to read URL for ${dbName} (turso db show --url).\n`);
    printCommandOutput(stderr, urlResult.stderr || urlResult.stdout, env);
    return finish(1);
  }
  const url = parseTursoUrl(urlResult.stdout);
  if (!url) {
    write(stderr, `turso db show ${dbName} --url did not return a libsql/https URL.\n`);
    printCommandOutput(stderr, urlResult.stdout, env);
    return finish(1);
  }

  const tokenResult = await runChecked(['db', 'tokens', 'create', dbName]);
  if (tokenResult.code !== 0) {
    write(
      stderr,
      `Failed to mint a database token for ${dbName} (turso db tokens create).\n`
        + 'Need a database token, not an org JWT (do not use turso auth token).\n'
    );
    printCommandOutput(stderr, tokenResult.stderr || tokenResult.stdout, env);
    return finish(1);
  }
  const token = parseTursoToken(tokenResult.stdout);
  if (!token) {
    write(stderr, `turso db tokens create ${dbName} did not return a token.\n`);
    printCommandOutput(stderr, tokenResult.stdout, env);
    return finish(1);
  }

  const session = resolveSessionSecret(env, { randomBytesFn });
  if (session.source === 'reuse-from-env') {
    write(stdout, 'SESSION_SECRET is already set in this environment — reusing (not rotated).\n');
  } else {
    write(stdout, 'Generated a new SESSION_SECRET (32-byte hex).\n');
  }

  write(stdout, '\n# Shell-ready exports (copy into this shell; do not commit)\n');
  write(stdout, `${shellExportLine('TURSO_DATABASE_URL', url)}\n`);
  write(stdout, `${shellExportLine('TURSO_AUTH_TOKEN', token)}\n`);
  write(stdout, `${shellExportLine('SESSION_SECRET', session.value)}\n`);
  write(stdout, `${shellExportLine(SECRET_SLUG_ENV, slug)}\n`);
  write(
    stdout,
    `# Preview database ${previewDbName} (group ${groupName}). Not written to Vercel by this command.\n`
      + `# Later Preview env names: ${PREVIEW_DATABASE_URL_NAME} ${PREVIEW_AUTH_TOKEN_NAME}\n\n`
  );

  write(stdout, formatApplyReport({
    slug,
    dbName,
    projectName,
    created,
    sessionSource: session.source,
    previewDbName,
    previewCreated: previewOutcome.created,
    groupName,
    groupCreated,
    defaultGroupDatabases
  }));

  if (args.json) {
    write(stdout, `${JSON.stringify(buildJsonSummary({
      mode: 'apply',
      slug,
      dbName,
      projectName,
      created,
      url,
      token,
      sessionSecret: session.value,
      sessionSource: session.source,
      location,
      previewCreated: previewOutcome.created,
      groupCreated,
      defaultGroupDatabases
    }), null, 2)}\n`);
  }

  return finish(0, {
    exports: {
      TURSO_DATABASE_URL: url,
      TURSO_AUTH_TOKEN: token,
      SESSION_SECRET: session.value
    }
  });
}
