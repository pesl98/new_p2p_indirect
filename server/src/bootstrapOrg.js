/**
 * Idempotent org skeleton: default cost centers + FY budgets.
 *
 * Never seeds, never creates users/suppliers/catalog/PRs, never wipes.
 * Department heads stay null — map them in Admin → Department Approvers
 * after users exist. There is no create-department UI; this CLI is the
 * operator path.
 *
 * Usage:
 *   npm run bootstrap-org
 *   npm run bootstrap-org -- --fiscal-year 2026 --budget-cents 10000000
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase } from './db.js';
import { formatCents } from './money.js';
import { assertCustomerDbConfig, runProvisionCli } from './provision.js';

export const DEFAULT_FISCAL_YEAR = 2026;
export const DEFAULT_BUDGET_CENTS = 10_000_000;

/** Default cost centers (codes are the idempotency key). Names match the onboarding docs. */
export const DEFAULT_ORG_DEPARTMENTS = Object.freeze([
  Object.freeze({ code: 'MKT', name: 'Marketing' }),
  Object.freeze({ code: 'ITE', name: 'IT' }),
  Object.freeze({ code: 'FAC', name: 'Facilities' }),
  Object.freeze({ code: 'HRP', name: 'HR' }),
  Object.freeze({ code: 'ADM', name: 'Finance' })
]);

export const BOOTSTRAP_ORG_HELP = `ProcureFlow org skeleton (cost centers + FY budgets)

Usage:
  npm run bootstrap-org -- [--fiscal-year 2026] [--budget-cents 10000000] [--turso] [--json]
  npm run bootstrap-org -- --force-budget
  npm run provision:customer -- --with-org [--email … --password …]

  Applies schema first (same as npm run db:migrate), then inserts the
  default five cost centers by code. Idempotent: never wipes. Existing
  department rows are skipped (never renamed). Missing FY budgets are
  inserted; existing budget totals are left alone unless --force-budget.

  Does NOT create users, credentials, suppliers, catalog, PRs, or demo
  personas. Never pass --seed (that is the destructive demo wipe).

  Default skeleton:
    MKT Marketing, ITE IT, FAC Facilities, HRP HR, ADM Finance
    FY ${DEFAULT_FISCAL_YEAR} total_budget = ${DEFAULT_BUDGET_CENTS} cents (${formatUsdFromCents(DEFAULT_BUDGET_CENTS)})
    committed_amount / actual_spent = 0
    approver_user_id left unset (map heads in Admin → Department Approvers)

Flags:
  --fiscal-year <n>     Budget fiscal year (default ${DEFAULT_FISCAL_YEAR}; match hardcoded joins)
  --budget-cents <n>    total_budget for newly created rows (default ${DEFAULT_BUDGET_CENTS})
  --force-budget        Update total_budget on existing FY rows to --budget-cents.
                        Does not touch committed_amount or actual_spent.
  --turso               Require Turso (fail if TURSO_* are unset)
  --json                Machine-readable summary (no secrets)
  --help, -h            Show this help

Env (same as db:migrate / bootstrap-admin / provision:customer):
  TURSO_DATABASE_URL + TURSO_AUTH_TOKEN   Turso HTTP (both required together)
  PROCUREMENT_DB_PATH                     Local SQLite file

Three tiers:
  empty schema     npm run db:migrate
  org skeleton     npm run bootstrap-org          (this command; non-destructive)
  demo wipe        npm run seed                   (DESTRUCTIVE personas)

See docs/DEPLOY_MANUAL.md (cost centers). docs/CUSTOMER_ONBOARDING.md and docs/DEPLOYMENT.md point there.
`;

function formatUsdFromCents(cents) {
  return `$${Number(formatCents(cents)).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

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

function asCount(row) {
  if (row == null) return 0;
  if (typeof row.n === 'number') return row.n;
  if (typeof row.n === 'string') return Number(row.n) || 0;
  const first = Object.values(row)[0];
  return Number(first) || 0;
}

function parseIntegerFlag(value, flag, { min, max } = {}) {
  if (value === true || value == null || value === '') {
    throw new Error(`${flag} requires an integer value.`);
  }
  const raw = String(value).trim();
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${flag} must be an integer (got ${JSON.stringify(value)}).`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${flag} is out of range.`);
  }
  if (min != null && n < min) {
    throw new Error(`${flag} must be >= ${min}.`);
  }
  if (max != null && n > max) {
    throw new Error(`${flag} must be <= ${max}.`);
  }
  return n;
}

export function parseBootstrapOrgArgs(argv = []) {
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
    if (arg === '--json') {
      flags.add('json');
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      flags.add('help');
      continue;
    }
    if (arg === '--force-budget') {
      flags.add('forceBudget');
      continue;
    }
    if (arg === '--fiscal-year' || arg.startsWith('--fiscal-year=')
      || arg === '--budget-cents' || arg.startsWith('--budget-cents=')) {
      const key = arg.replace(/^--/, '').split('=')[0];
      const mapped = key === 'fiscal-year' ? 'fiscalYear' : 'budgetCents';
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
    json: flags.has('json'),
    help: flags.has('help'),
    forceBudget: flags.has('forceBudget'),
    fiscalYear: values.fiscalYear != null ? values.fiscalYear : null,
    budgetCents: values.budgetCents != null ? values.budgetCents : null,
    unknown
  };
}

export function isMainModule(metaUrl = import.meta.url, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return metaUrl === pathToFileURL(path.resolve(argv1)).href;
  } catch {
    return false;
  }
}

export function formatOrgSummary(result) {
  const list = (codes) => (codes.length ? codes.join(', ') : '(none)');
  const forceNote = result.forceBudget
    ? 'existing totals updated when --force-budget'
    : 'existing totals left alone';
  const lines = [
    'ProcureFlow org skeleton',
    `  fiscal year:   ${result.fiscalYear}`,
    `  budget cents:  ${result.budgetCents} (${formatUsdFromCents(result.budgetCents)}; ${forceNote})`,
    `  departments:   inserted ${list(result.departments.inserted)}`,
    `  departments:   skipped  ${list(result.departments.skipped)}`,
    `  budgets:       created  ${list(result.budgets.created)}`,
    `  budgets:       present  ${list(result.budgets.alreadyPresent)}`
  ];
  if (result.budgets.updated.length) {
    lines.push(`  budgets:       updated  ${list(result.budgets.updated)}`);
  }
  lines.push(
    `  users:         not modified (${result.userCount} in this database)`,
    '  next:          map department heads in Admin → Department Approvers after users exist',
    '  isolation:     database-per-customer (no org_id row tenancy)'
  );
  return `${lines.join('\n')}\n`;
}

export async function bootstrapOrgSkeleton(db, {
  departments = DEFAULT_ORG_DEPARTMENTS,
  fiscalYear = DEFAULT_FISCAL_YEAR,
  budgetCents = DEFAULT_BUDGET_CENTS,
  forceBudget = false
} = {}) {
  const inserted = [];
  const skipped = [];
  const created = [];
  const alreadyPresent = [];
  const updated = [];

  const applyOne = async (dept) => {
    const existing = await db.prepare(
      `SELECT id, code, name FROM departments WHERE code = ?`
    ).get(dept.code);

    let departmentId;
    if (existing) {
      departmentId = Number(existing.id);
      skipped.push(dept.code);
    } else {
      await db.prepare(
        `INSERT INTO departments (code, name) VALUES (?, ?)`
      ).run(dept.code, dept.name);
      const row = await db.prepare(
        `SELECT id FROM departments WHERE code = ?`
      ).get(dept.code);
      departmentId = Number(row.id);
      inserted.push(dept.code);
    }

    const budget = await db.prepare(
      `SELECT id, total_budget FROM budgets
       WHERE department_id = ? AND fiscal_year = ?`
    ).get(departmentId, fiscalYear);

    if (!budget) {
      await db.prepare(
        `INSERT INTO budgets (department_id, fiscal_year, total_budget, committed_amount, actual_spent)
         VALUES (?, ?, ?, 0, 0)`
      ).run(departmentId, fiscalYear, budgetCents);
      created.push(dept.code);
      return;
    }

    const currentTotal = Number(budget.total_budget);
    if (forceBudget && currentTotal !== budgetCents) {
      await db.prepare(
        `UPDATE budgets SET total_budget = ? WHERE department_id = ? AND fiscal_year = ?`
      ).run(budgetCents, departmentId, fiscalYear);
      updated.push(dept.code);
      return;
    }
    alreadyPresent.push(dept.code);
  };

  if (typeof db.transaction === 'function') {
    await db.transaction(async () => {
      for (const dept of departments) {
        await applyOne(dept);
      }
    })();
  } else {
    for (const dept of departments) {
      await applyOne(dept);
    }
  }

  let userCount = 0;
  try {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM users`).get();
    userCount = asCount(row);
  } catch {
    userCount = 0;
  }

  return {
    ok: true,
    fiscalYear,
    budgetCents,
    forceBudget: Boolean(forceBudget),
    departments: { inserted, skipped },
    budgets: { created, alreadyPresent, updated },
    userCount,
    usersTouched: false,
    seeded: false
  };
}

export async function runBootstrapOrgCli({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  openDatabaseFn = openDatabase,
  runMigrateFn,
  skipMigrate = false
} = {}) {
  const args = parseBootstrapOrgArgs(argv);
  if (args.help) {
    write(stdout, BOOTSTRAP_ORG_HELP);
    return 0;
  }
  if (args.seed) {
    write(
      stderr,
      'bootstrap-org never seeds. It only inserts missing cost centers and FY budgets.\n'
        + 'Demo wipe (destructive): npm run seed\n'
    );
    return 1;
  }
  if (args.unknown.length) {
    write(stderr, `Unknown argument: ${args.unknown[0]}\n${BOOTSTRAP_ORG_HELP}`);
    return 1;
  }

  let fiscalYear = DEFAULT_FISCAL_YEAR;
  let budgetCents = DEFAULT_BUDGET_CENTS;
  try {
    if (args.fiscalYear != null) {
      fiscalYear = parseIntegerFlag(args.fiscalYear, '--fiscal-year', { min: 1, max: 9999 });
    }
    if (args.budgetCents != null) {
      budgetCents = parseIntegerFlag(args.budgetCents, '--budget-cents', { min: 0 });
    }
  } catch (error) {
    write(stderr, `${error.message}\n`);
    return 1;
  }

  if (!skipMigrate) {
    const migrateArgv = [];
    if (args.requireTurso) migrateArgv.push('--turso');
    // Keep migrate output out of --json so the only stdout object is the org summary.
    const migrateStdout = args.json ? { write() {} } : stdout;
    const migrate = runMigrateFn || ((opts) => runProvisionCli({ command: 'migrate', ...opts }));
    const migrateCode = await migrate({
      argv: migrateArgv,
      env,
      stdout: migrateStdout,
      stderr
    });
    if (migrateCode !== 0) return migrateCode;
  }

  try {
    const dbConfig = assertCustomerDbConfig(env, { requireTurso: args.requireTurso });
    const db = await openDatabaseFn(dbConfig, { migrate: true });
    const result = await bootstrapOrgSkeleton(db, {
      fiscalYear,
      budgetCents,
      forceBudget: args.forceBudget
    });
    if (args.json) {
      write(stdout, `${JSON.stringify(result, null, 2)}\n`);
    } else {
      write(stdout, formatOrgSummary(result));
    }
    return 0;
  } catch (error) {
    write(stderr, `${error?.message || error}\n`);
    return 1;
  }
}

if (isMainModule()) {
  process.exit(await runBootstrapOrgCli());
}
