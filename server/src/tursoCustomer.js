/**
 * Create or reuse one classic libSQL Turso database per customer and mint
 * the shell exports Vercel needs (URL, database token, SESSION_SECRET).
 *
 * Isolation stays one Turso DB + one Vercel project per customer (not org_id).
 * Does not migrate, seed, call Vercel, or destroy a database.
 * Dry-run never invents secrets. --apply prints real exports to stdout only.
 *
 *   npm run turso:customer -- --slug acme
 *   npm run turso:customer -- --slug acme --apply
 */

import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  defaultProjectName,
  normalizeSlug,
  runProcess,
  suggestedBaseUrl
} from './vercelCustomer.js';

export const DEFAULT_DB_PREFIX = 'procureflow-';

export const WILL_MINT_PLACEHOLDER = '<will mint on --apply>';

export const TURSO_CUSTOMER_HELP = `ProcureFlow Turso customer database (classic libSQL)

Usage:
  npm run turso:customer -- --slug acme
  npm run turso:customer -- --slug acme --dry-run
  npm run turso:customer -- --slug acme --apply
  npm run turso:customer -- --db procureflow-acme --apply
  npm run turso:customer -- --slug acme --json

  --slug <customer>     Required unless --db can derive it. Default DB name
                        is procureflow-<slug> (lowercase).
  --db <name>           Override Turso database name (or derive --slug from
                        a procureflow-<slug> name).
  --dry-run             Print the planned turso commands + export placeholders
                        (default). Exit 0. Never calls Turso. No network required.
                        Does not invent or print fake secrets.
  --apply               Create the DB if missing (reuse if it exists), mint a
                        database token, generate SESSION_SECRET unless already
                        set in this shell, and print shell-ready exports.
                        Requires Turso CLI and turso auth login.
  --json                Machine-readable summary. Tokens are redacted to the
                        last 4 characters in JSON. On --apply, full export
                        lines are still printed on human stdout.
  --help, -h            Show this help

Does not migrate, seed, call Vercel, or destroy a database.
Classic libSQL only — never passes --tursodb.
Token is turso db tokens create (database token), not an org JWT.

Happy path:
  Preferred: npm run onboard:customer -- --slug <slug> [--apply --email … --password …]
  1. npm run turso:customer -- --slug <slug>            # dry-run
  2. npm run turso:customer -- --slug <slug> --apply    # print exports
  3. npm run vercel:customer -- --slug <slug>           # dry-run (project add + link + env)
  4. npm run vercel:customer -- --slug <slug> --apply   # ensure project, link, env, redeploy
  5. npm run provision:customer -- --with-org --email … --password …
  6. BASE_URL=https://procureflow-<slug>.vercel.app npm run smoke
  GitHub auto-deploy is not connected by vercel project add.

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
    unknown
  };
}

export function plannedTursoCommands(dbName) {
  return [
    {
      kind: 'whoami',
      argv: ['auth', 'whoami'],
      display: 'turso auth whoami'
    },
    {
      kind: 'show',
      argv: ['db', 'show', dbName],
      display: `turso db show ${dbName}`,
      note: 'existence check; reuse if present'
    },
    {
      kind: 'create',
      argv: ['db', 'create', dbName],
      display: `turso db create ${dbName}`,
      note: 'only if missing; never --tursodb'
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
      note: 'database token, not org JWT'
    }
  ];
}

export function generateSessionSecret({ randomBytesFn = randomBytes } = {}) {
  return randomBytesFn(32).toString('hex');
}

export function resolveSessionSecret(env = {}, { randomBytesFn = randomBytes } = {}) {
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

export function formatDryRunReport({
  slug,
  dbName,
  projectName,
  env = process.env
} = {}) {
  const commands = plannedTursoCommands(dbName);
  const sessionSet = Boolean(asTrimmed(env.SESSION_SECRET));
  const lines = [
    'ProcureFlow Turso customer database (dry-run — no Turso mutation)',
    '',
    `Customer slug:  ${slug}`,
    `Database name:  ${dbName}`,
    `Vercel project: ${projectName} (vercel:customer --apply creates/links it; this command never calls Vercel)`,
    '',
    'Isolation: one classic libSQL database per customer. Never --tursodb.',
    'Token: turso db tokens create (database token), not an org JWT.',
    'Existing databases are reused. This command never destroys a DB.',
    '',
    'Commands --apply would run:',
    ...commands.flatMap((cmd) => (
      cmd.note ? [`  ${cmd.display}`, `    (${cmd.note})`] : [`  ${cmd.display}`]
    )),
    '',
    'Exports you will need (placeholders — secrets are not invented in dry-run):',
    `  export TURSO_DATABASE_URL='${WILL_MINT_PLACEHOLDER}'`,
    `  export TURSO_AUTH_TOKEN='${WILL_MINT_PLACEHOLDER}'`,
    sessionSet
      ? '  export SESSION_SECRET=\'<reuse existing SESSION_SECRET from this environment — not printed>\''
      : `  export SESSION_SECRET='${WILL_MINT_PLACEHOLDER}'`,
    '',
    sessionSet
      ? 'SESSION_SECRET is already set in this environment and will be reused (not rotated).'
      : 'SESSION_SECRET will mint on --apply (32-byte hex) unless you export one first.',
    '',
    'Does not migrate, seed, call Vercel, or destroy a database.',
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
  sessionSource
} = {}) {
  const lines = [
    'ProcureFlow Turso customer database applied',
    '',
    `Customer slug:  ${slug}`,
    `Database name:  ${dbName}`,
    `Database:       ${created ? 'created (classic libSQL)' : 'reused (already existed)'}`,
    `SESSION_SECRET: ${sessionSource === 'reuse-from-env' ? 'reused from this environment' : 'minted (32-byte hex)'}`,
    'Token:          database token from turso db tokens create (not an org JWT)',
    '',
    'Copy the export lines above into this shell (and a password manager).',
    'Secrets are printed once on stdout — not written to git.',
    '',
    'Next:',
    `  npm run vercel:customer -- --slug ${slug} --apply   # project add + link if needed, then env`,
    '  npm run provision:customer -- --with-org --email admin@customer.com --password \'…\'',
    `  BASE_URL=${suggestedBaseUrl(projectName)} npm run smoke`
  ];
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
  sessionSource = null
} = {}) {
  const apply = mode === 'apply';
  const sessionSet = Boolean(asTrimmed(sessionSecret));
  return {
    ok: true,
    mode,
    slug,
    dbName,
    projectName,
    created: apply ? Boolean(created) : null,
    reused: apply ? !created : null,
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
    commands: plannedTursoCommands(dbName).map((cmd) => cmd.display),
    note: apply
      ? 'JSON redacts TURSO_AUTH_TOKEN and SESSION_SECRET to last 4 chars. Full values are on the export lines above.'
      : 'Dry-run does not invent secrets. Use --apply to mint URL, database token, and SESSION_SECRET.'
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

function printCommandOutput(stream, text) {
  const redacted = asTrimmed(text);
  if (redacted) write(stream, `${redacted}\n`);
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

  if (!args.apply) {
    write(stdout, formatDryRunReport({ slug, dbName, projectName, env }));
    if (args.json) {
      write(stdout, `${JSON.stringify(buildJsonSummary({
        mode: 'dry-run',
        slug,
        dbName,
        projectName,
        sessionSecret: env.SESSION_SECRET
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

  write(stdout, `Applying Turso database for ${dbName} (classic libSQL)…\n`);

  const whoami = await runTursoCommand(['auth', 'whoami'], runOpts);
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
    printCommandOutput(stderr, whoami.stderr || whoami.stdout);
    return finish(1);
  }
  printCommandOutput(stdout, whoami.stdout);

  let created = false;
  const shown = await runTursoCommand(['db', 'show', dbName], runOpts);
  if (shown.code === 0) {
    write(stdout, `Database ${dbName} already exists — reusing (will not destroy).\n`);
  } else if (looksLikeMissingDatabase(shown.stdout, shown.stderr)) {
    write(stdout, `Creating classic libSQL database ${dbName} (never --tursodb)…\n`);
    const createdResult = await runTursoCommand(['db', 'create', dbName], runOpts);
    printCommandOutput(stdout, createdResult.stdout);
    if (createdResult.code !== 0) {
      if (looksLikeAlreadyExists(createdResult.stdout, createdResult.stderr)) {
        write(stdout, `Database ${dbName} already exists — reusing (will not destroy).\n`);
      } else {
        write(
          stderr,
          `Failed to create Turso database ${dbName} (turso exit ${createdResult.code}).\n`
            + 'Classic libSQL only — this command never passes --tursodb.\n'
        );
        printCommandOutput(stderr, createdResult.stderr || createdResult.stdout);
        return finish(1);
      }
    } else {
      created = true;
    }
  } else {
    write(
      stderr,
      `Could not check whether Turso database ${dbName} exists (turso exit ${shown.code}).\n`
        + 'Confirm turso auth login and that the name is correct. This command will not destroy a DB.\n'
    );
    printCommandOutput(stderr, shown.stderr || shown.stdout);
    return finish(1);
  }

  const urlResult = await runTursoCommand(['db', 'show', dbName, '--url'], runOpts);
  if (urlResult.code !== 0) {
    write(stderr, `Failed to read URL for ${dbName} (turso db show --url).\n`);
    printCommandOutput(stderr, urlResult.stderr || urlResult.stdout);
    return finish(1);
  }
  const url = parseTursoUrl(urlResult.stdout);
  if (!url) {
    write(stderr, `turso db show ${dbName} --url did not return a libsql/https URL.\n`);
    printCommandOutput(stderr, urlResult.stdout);
    return finish(1);
  }

  const tokenResult = await runTursoCommand(['db', 'tokens', 'create', dbName], runOpts);
  if (tokenResult.code !== 0) {
    write(
      stderr,
      `Failed to mint a database token for ${dbName} (turso db tokens create).\n`
        + 'Need a database token, not an org JWT (do not use turso auth token).\n'
    );
    printCommandOutput(stderr, tokenResult.stderr || tokenResult.stdout);
    return finish(1);
  }
  const token = parseTursoToken(tokenResult.stdout);
  if (!token) {
    write(stderr, `turso db tokens create ${dbName} did not return a token.\n`);
    printCommandOutput(stderr, tokenResult.stdout);
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
  write(stdout, `${shellExportLine('SESSION_SECRET', session.value)}\n\n`);

  write(stdout, formatApplyReport({
    slug,
    dbName,
    projectName,
    created,
    sessionSource: session.source
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
      sessionSource: session.source
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
