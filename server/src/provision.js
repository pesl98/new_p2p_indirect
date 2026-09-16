/**
 * Customer provision helpers: one isolated database per customer (not org_id).
 *
 * Dual-mode stays honest: omit TURSO_* for local SQLite; set both URL and token
 * for Turso HTTP. Partial Turso credentials fail closed (no silent SQLite).
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  TURSO_REQUIRED_MSG,
  TursoConfigError,
  assertDeployableConfig,
  loadDbConfig
} from './dbConfig.js';
import { openDatabase } from './db.js';

export { TURSO_REQUIRED_MSG, TursoConfigError };

/** Tables created by schema.sql (CREATE TABLE IF NOT EXISTS). Extra columns come from db.js migrations. */
export const EXPECTED_TABLES = [
  'approval_delegations',
  'approval_requests',
  'audit_logs',
  'budgets',
  'catalog_items',
  'contract_items',
  'contracts',
  'departments',
  'goods_receipt_items',
  'goods_receipts',
  'invoice_duplicate_flags',
  'invoice_exception_dispositions',
  'invoice_items',
  'invoices',
  'match_results',
  'payment_run_items',
  'payment_runs',
  'po_change_order_items',
  'po_change_orders',
  'po_items',
  'purchase_orders',
  'purchase_requisitions',
  'requisition_items',
  'service_entry_sheet_items',
  'service_entry_sheets',
  'suppliers',
  'user_credentials',
  'users'
];

export const PARTIAL_TURSO_MSG =
  'TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must both be set to use Turso, '
  + 'or both omitted to use local SQLite. Partial credentials are refused '
  + '(fail-closed: ProcureFlow will not silently open a local SQLite file).';

export const MIGRATE_HELP = `ProcureFlow customer database

Usage:
  npm run db:migrate -- [--seed] [--turso] [--json]
  npm run db:status  -- [--turso] [--json]

  --seed           After schema/migrations, run the demo seed (DESTRUCTIVE wipe).
                   Omit for a real customer (empty tables).
  --turso          Require Turso (fail if TURSO_* are unset). Same as --require-turso.
  --json           Machine-readable health object (no secrets).

Env:
  TURSO_DATABASE_URL + TURSO_AUTH_TOKEN   Turso HTTP (both required together)
  PROCUREMENT_DB_PATH                     Local SQLite file (default server/data/procurement.db)

Isolation: one Turso database or SQLite file per customer. No org_id row tenancy.
Empty tenant: after migrate, create the first admin (UI or npm run bootstrap-admin).
Then: BASE_URL=http://127.0.0.1:5000 npm run smoke
See docs/CUSTOMER_ONBOARDING.md (operator runbook) and docs/DEPLOYMENT.md.
`;

export function tursoCredentialState(env = process.env) {
  const url = String(env.TURSO_DATABASE_URL || '').trim();
  const token = String(env.TURSO_AUTH_TOKEN || '').trim();
  if (url && token) return 'complete';
  if (url || token) return 'partial';
  return 'absent';
}

/**
 * Fail-closed for customer provision / migrate / status.
 * Does not change laptop demo fallback in loadDbConfig itself: only callers
 * that go through this helper refuse a half-configured Turso pair.
 */
export function assertCustomerDbConfig(env = process.env, { requireTurso = false } = {}) {
  const state = tursoCredentialState(env);
  if (state === 'partial') {
    throw new TursoConfigError(PARTIAL_TURSO_MSG);
  }
  if (requireTurso && state !== 'complete') {
    throw new TursoConfigError(TURSO_REQUIRED_MSG);
  }
  const config = loadDbConfig(env);
  assertDeployableConfig(config);
  return config;
}

export function parseProvisionArgs(argv = []) {
  const flags = new Set();
  const unknown = [];
  for (const arg of argv) {
    if (arg === '--seed') flags.add('seed');
    else if (arg === '--turso' || arg === '--require-turso') flags.add('requireTurso');
    else if (arg === '--json') flags.add('json');
    else if (arg === '--help' || arg === '-h') flags.add('help');
    else unknown.push(arg);
  }
  return {
    seed: flags.has('seed'),
    requireTurso: flags.has('requireTurso'),
    json: flags.has('json'),
    help: flags.has('help'),
    unknown
  };
}

/** Host-only Turso URL for logs. Never include query strings or tokens. */
export function redactTursoUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  try {
    const normalized = raw
      .replace(/^libsql:\/\//i, 'https://')
      .replace(/^turso:\/\//i, 'https://');
    const parsed = new URL(normalized);
    const scheme = /^libsql:/i.test(raw) ? 'libsql' : parsed.protocol.replace(/:$/, '');
    return `${scheme}://${parsed.host}`;
  } catch {
    return '(unparseable TURSO_DATABASE_URL)';
  }
}

function asCount(row) {
  if (row == null) return 0;
  if (typeof row.n === 'number') return row.n;
  if (typeof row.n === 'string') return Number(row.n) || 0;
  const first = Object.values(row)[0];
  return Number(first) || 0;
}

export async function collectDbHealth(db, config = {}) {
  const tableRows = await db.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`
  ).all();
  const tables = (tableRows || []).map((row) => row.name).filter(Boolean);
  const missingTables = EXPECTED_TABLES.filter((name) => !tables.includes(name));
  let userCount = 0;
  if (tables.includes('users')) {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM users`).get();
    userCount = asCount(row);
  }
  const mode = db.useTurso ? 'turso-http' : (db.mode || 'sqlite');
  const migrated = missingTables.length === 0;
  return {
    ok: migrated,
    migrated,
    health: migrated ? 'ok' : (tables.length === 0 ? 'empty' : 'incomplete'),
    mode,
    sqlitePath: config.useTurso ? null : (config.sqlitePath || null),
    tursoUrl: config.useTurso ? redactTursoUrl(config.tursoUrl) : null,
    tableCount: tables.length,
    expectedTableCount: EXPECTED_TABLES.length,
    tables,
    missingTables,
    userCount,
    emptyCustomer: userCount === 0,
    seededDemoLikely: userCount >= 8
  };
}

export function formatDbHealth(health, command = 'status') {
  const lines = [
    `ProcureFlow customer database — ${command}`,
    `  health:      ${health.health}${health.ok ? '' : ' (schema missing or incomplete)'}`,
    `  mode:        ${health.mode}`
  ];
  if (health.mode === 'turso-http') {
    lines.push(`  turso:       ${health.tursoUrl || '(set)'}`);
  } else {
    lines.push(`  sqlite:      ${health.sqlitePath || '(default)'}`);
  }
  lines.push(
    `  tables:      ${health.tableCount} (expected ${health.expectedTableCount})`,
    `  users:       ${health.userCount}`,
    `  customer:    ${health.emptyCustomer ? 'empty (no seed)' : (health.seededDemoLikely ? 'has users (typical demo seed is 8 personas)' : 'has users')}`
  );
  if (health.seedRan) {
    lines.push('  seed:        ran (destructive demo wipe + sample data)');
  }
  if (health.missingTables?.length) {
    lines.push(`  missing:     ${health.missingTables.join(', ')}`);
  }
  lines.push('  isolation:   database-per-customer (no org_id row tenancy)');
  return `${lines.join('\n')}\n`;
}

export function defaultSeedScriptPath() {
  return fileURLToPath(new URL('./seed.js', import.meta.url));
}

export function runSeedProcess(env = process.env, {
  spawnFn = spawn,
  scriptPath = defaultSeedScriptPath(),
  execPath = process.execPath
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(execPath, [scriptPath], {
      env: { ...process.env, ...env },
      stdio: 'inherit'
    });
    if (!child || typeof child.on !== 'function') {
      reject(new Error('seed spawn did not return a ChildProcess'));
      return;
    }
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`seed.js exited with code ${code}`));
    });
  });
}

function write(stream, text) {
  if (!stream) return;
  if (typeof stream.write === 'function') stream.write(text);
}

export async function runProvisionCli({
  command,
  argv = [],
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  openDatabaseFn = openDatabase,
  runSeedFn = runSeedProcess
} = {}) {
  if (command !== 'migrate' && command !== 'status') {
    write(stderr, `Unknown command: ${command}\n`);
    return 1;
  }

  const args = parseProvisionArgs(argv);
  if (args.help) {
    write(stdout, MIGRATE_HELP);
    return 0;
  }
  if (args.unknown.length) {
    write(stderr, `Unknown argument: ${args.unknown[0]}\n${MIGRATE_HELP}`);
    return 1;
  }
  if (command === 'status' && args.seed) {
    write(stderr, 'db:status does not accept --seed. Use npm run db:migrate -- --seed\n');
    return 1;
  }

  try {
    const config = assertCustomerDbConfig(env, { requireTurso: args.requireTurso });
    if (command === 'migrate' && args.seed) {
      await runSeedFn(env);
    }
    const db = await openDatabaseFn(config, {
      migrate: command === 'migrate'
    });
    const health = await collectDbHealth(db, config);
    if (command === 'migrate' && args.seed) health.seedRan = true;
    if (args.json) {
      write(stdout, `${JSON.stringify(health, null, 2)}\n`);
    } else {
      write(stdout, formatDbHealth(health, command));
    }
    if (command === 'migrate' && !health.ok) return 1;
    return 0;
  } catch (error) {
    const message = error?.message || String(error);
    write(stderr, `${message}\n`);
    return 1;
  }
}
