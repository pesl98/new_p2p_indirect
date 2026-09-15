/**
 * Non-destructive customer org bootstrap (departments, users, budgets).
 *
 * GET /api/users and GET /api/departments are read-only — there is no REST
 * create path. Operators load a customer's org from a JSON file via
 * `npm run db:bootstrap -- --file …`. This does not drop tables or run seed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { requireIntegerCents } from './money.js';
import { openDatabase } from './db.js';
import {
  assertCustomerDbConfig,
  collectDbHealth,
  formatDbHealth
} from './provision.js';

export const USER_ROLES = ['requester', 'approver', 'procurement', 'finance', 'admin'];

export const BOOTSTRAP_HELP = `ProcureFlow customer org bootstrap (non-destructive)

Usage:
  npm run db:bootstrap -- --file scripts/customer-org.example.json
  npm run db:bootstrap -- --file ./acme-org.json [--turso] [--json]

  --file PATH      JSON org spec (required). See scripts/customer-org.example.json
  --turso          Require Turso (fail if TURSO_* are unset)
  --json           Machine-readable result (no secrets)

This INSERT-skips existing department codes, user emails, and budget years.
It does not wipe data and is not npm run seed.

GET /api/users and GET /api/departments cannot create the first rows.
Persona switcher is still demo auth, not SSO.
`;

export class BootstrapError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BootstrapError';
  }
}

function write(stream, text) {
  if (!stream) return;
  if (typeof stream.write === 'function') stream.write(text);
}

function asText(value, field) {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new BootstrapError(`${field} is required`);
  }
  return text;
}

function optionalCents(value, field, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  try {
    const n = requireIntegerCents(value, field);
    if (n < 0) throw new BootstrapError(`${field} must be >= 0`);
    return n;
  } catch (error) {
    throw new BootstrapError(error.message);
  }
}

function requiredCents(value, field) {
  try {
    const n = requireIntegerCents(value, field);
    if (n < 0) throw new BootstrapError(`${field} must be >= 0`);
    return n;
  } catch (error) {
    throw new BootstrapError(error.message);
  }
}

export function parseBootstrapArgs(argv = []) {
  let file = null;
  const flags = new Set();
  const unknown = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file' || arg === '-f') {
      const next = argv[i + 1];
      if (!next || String(next).startsWith('-')) {
        throw new BootstrapError('--file requires a path');
      }
      file = next;
      i += 1;
    } else if (arg.startsWith('--file=')) {
      file = arg.slice('--file='.length);
      if (!file) throw new BootstrapError('--file requires a path');
    } else if (arg === '--turso' || arg === '--require-turso') {
      flags.add('requireTurso');
    } else if (arg === '--json') {
      flags.add('json');
    } else if (arg === '--help' || arg === '-h') {
      flags.add('help');
    } else {
      unknown.push(arg);
    }
  }
  return {
    file,
    requireTurso: flags.has('requireTurso'),
    json: flags.has('json'),
    help: flags.has('help'),
    unknown
  };
}

/**
 * Normalize and validate a customer org JSON object (not yet written to DB).
 */
export function parseOrgSpec(input) {
  const spec = typeof input === 'string' ? JSON.parse(input) : input;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new BootstrapError('org spec must be a JSON object');
  }
  const departmentsIn = Array.isArray(spec.departments) ? spec.departments : null;
  const usersIn = Array.isArray(spec.users) ? spec.users : null;
  if (!departmentsIn || departmentsIn.length === 0) {
    throw new BootstrapError('org spec must include at least one department');
  }
  if (!usersIn || usersIn.length === 0) {
    throw new BootstrapError('org spec must include at least one user');
  }

  let fiscalYear = 2026;
  if (spec.fiscal_year !== undefined && spec.fiscal_year !== null && spec.fiscal_year !== '') {
    const n = Number(spec.fiscal_year);
    if (!Number.isInteger(n) || n < 2000) {
      throw new BootstrapError('fiscal_year must be an integer year (ProcureFlow queries currently assume 2026)');
    }
    fiscalYear = n;
  }

  const departments = [];
  const codes = new Set();
  for (const [index, row] of departmentsIn.entries()) {
    const label = `departments[${index}]`;
    const code = asText(row?.code, `${label}.code`).toUpperCase();
    if (codes.has(code)) {
      throw new BootstrapError(`duplicate department code: ${code}`);
    }
    codes.add(code);
    departments.push({
      code,
      name: asText(row?.name, `${label}.name`),
      approverEmail: row?.approver_email ? asText(row.approver_email, `${label}.approver_email`) : null,
      totalBudgetCents: requiredCents(row?.total_budget_cents, `${label}.total_budget_cents`)
    });
  }

  const users = [];
  const emails = new Set();
  for (const [index, row] of usersIn.entries()) {
    const label = `users[${index}]`;
    const email = asText(row?.email, `${label}.email`);
    const emailKey = email.toLowerCase();
    if (emails.has(emailKey)) {
      throw new BootstrapError(`duplicate user email: ${email}`);
    }
    emails.add(emailKey);
    const role = asText(row?.role, `${label}.role`);
    if (!USER_ROLES.includes(role)) {
      throw new BootstrapError(`${label}.role must be one of: ${USER_ROLES.join(', ')}`);
    }
    const departmentCode = asText(row?.department_code, `${label}.department_code`).toUpperCase();
    if (!codes.has(departmentCode)) {
      throw new BootstrapError(`${label}.department_code ${departmentCode} is not in departments[]`);
    }
    users.push({
      name: asText(row?.name, `${label}.name`),
      email,
      role,
      departmentCode,
      title: row?.title == null || row?.title === '' ? null : String(row.title),
      approvalLimitCents: optionalCents(row?.approval_limit_cents, `${label}.approval_limit_cents`, 0)
    });
  }

  for (const dept of departments) {
    if (!dept.approverEmail) continue;
    const match = users.find((user) => user.email.toLowerCase() === dept.approverEmail.toLowerCase());
    if (!match) {
      throw new BootstrapError(
        `department ${dept.code} approver_email ${dept.approverEmail} must match a user in this file`
      );
    }
  }

  return {
    customer: spec.customer ? String(spec.customer) : null,
    fiscalYear,
    departments,
    users
  };
}

export function loadOrgSpecFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new BootstrapError(`org file not found: ${resolved}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new BootstrapError(`org file is not valid JSON: ${error.message}`);
  }
  return parseOrgSpec(parsed);
}

async function countTable(db, sql, ...params) {
  const row = await db.prepare(sql).get(...params);
  return Number(row?.n ?? 0);
}

/**
 * Insert departments, users, and budgets. Existing unique keys are skipped
 * (code / email / department+year). Does not DROP tables or rewrite names.
 */
export async function bootstrapCustomerOrg(db, specInput) {
  const spec = specInput.departments && specInput.users && specInput.fiscalYear
    ? specInput
    : parseOrgSpec(specInput);

  const summary = {
    customer: spec.customer,
    fiscalYear: spec.fiscalYear,
    created: { departments: 0, users: 0, budgets: 0, approverMappings: 0 },
    skipped: { departments: 0, users: 0, budgets: 0, approverMappings: 0 },
    destructive: false
  };

  await db.transaction(async () => {
    const deptIds = new Map();

    for (const dept of spec.departments) {
      const existing = await db.prepare(`SELECT id FROM departments WHERE code = ?`).get(dept.code);
      if (existing?.id) {
        deptIds.set(dept.code, existing.id);
        summary.skipped.departments += 1;
        continue;
      }
      const inserted = await db.prepare(
        `INSERT INTO departments (code, name) VALUES (?, ?)`
      ).run(dept.code, dept.name);
      deptIds.set(dept.code, Number(inserted.lastInsertRowid));
      summary.created.departments += 1;
    }

    for (const user of spec.users) {
      const existing = await db.prepare(
        `SELECT id FROM users WHERE lower(email) = lower(?)`
      ).get(user.email);
      if (existing?.id) {
        summary.skipped.users += 1;
        continue;
      }
      const departmentId = deptIds.get(user.departmentCode);
      await db.prepare(`
        INSERT INTO users (name, email, role, department_id, title, approval_limit)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        user.name,
        user.email,
        user.role,
        departmentId,
        user.title,
        user.approvalLimitCents
      );
      summary.created.users += 1;
    }

    for (const dept of spec.departments) {
      const departmentId = deptIds.get(dept.code);
      const existingBudget = await db.prepare(
        `SELECT id FROM budgets WHERE department_id = ? AND fiscal_year = ?`
      ).get(departmentId, spec.fiscalYear);
      if (existingBudget?.id) {
        summary.skipped.budgets += 1;
      } else {
        await db.prepare(`
          INSERT INTO budgets (department_id, fiscal_year, total_budget, committed_amount, actual_spent)
          VALUES (?, ?, ?, 0, 0)
        `).run(departmentId, spec.fiscalYear, dept.totalBudgetCents);
        summary.created.budgets += 1;
      }

      if (!dept.approverEmail) continue;
      const approver = await db.prepare(
        `SELECT id FROM users WHERE lower(email) = lower(?)`
      ).get(dept.approverEmail);
      if (!approver?.id) {
        throw new BootstrapError(
          `department ${dept.code} approver_email ${dept.approverEmail} was not found after user insert`
        );
      }
      const current = await db.prepare(
        `SELECT approver_user_id FROM departments WHERE id = ?`
      ).get(departmentId);
      if (current?.approver_user_id == null) {
        await db.prepare(
          `UPDATE departments SET approver_user_id = ? WHERE id = ?`
        ).run(approver.id, departmentId);
        summary.created.approverMappings += 1;
      } else {
        summary.skipped.approverMappings += 1;
      }
    }
  });

  summary.userCount = await countTable(db, `SELECT COUNT(*) AS n FROM users`);
  summary.departmentCount = await countTable(db, `SELECT COUNT(*) AS n FROM departments`);
  return summary;
}

export function formatBootstrapResult(summary, health) {
  const lines = [
    'ProcureFlow customer org bootstrap',
    `  customer:    ${summary.customer || '(unnamed)'}`,
    `  fiscal_year: ${summary.fiscalYear}`,
    `  created:     depts ${summary.created.departments}, users ${summary.created.users}, budgets ${summary.created.budgets}, approvers ${summary.created.approverMappings}`,
    `  skipped:     depts ${summary.skipped.departments}, users ${summary.skipped.users}, budgets ${summary.skipped.budgets}, approvers ${summary.skipped.approverMappings} (already present; not overwritten)`,
    `  totals:      ${summary.departmentCount} departments, ${summary.userCount} users`,
    '  writes:      JSON import only — GET /api/users and GET /api/departments cannot create rows',
    '  destructive: no (unlike npm run seed)'
  ];
  if (health) {
    lines.push(`  db:          ${health.mode}, tables ${health.tableCount}/${health.expectedTableCount}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function runBootstrapCli({
  argv = [],
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  openDatabaseFn = openDatabase,
  loadSpecFn = loadOrgSpecFile
} = {}) {
  let args;
  try {
    args = parseBootstrapArgs(argv);
  } catch (error) {
    write(stderr, `${error.message}\n`);
    return 1;
  }
  if (args.help) {
    write(stdout, BOOTSTRAP_HELP);
    return 0;
  }
  if (args.unknown.length) {
    write(stderr, `Unknown argument: ${args.unknown[0]}\n${BOOTSTRAP_HELP}`);
    return 1;
  }
  if (!args.file) {
    write(stderr, `--file is required\n${BOOTSTRAP_HELP}`);
    return 1;
  }

  try {
    const config = assertCustomerDbConfig(env, { requireTurso: args.requireTurso });
    const spec = loadSpecFn(args.file);
    const db = await openDatabaseFn(config, { migrate: true });
    const summary = await bootstrapCustomerOrg(db, spec);
    const health = await collectDbHealth(db, config);
    const payload = { ...summary, health };
    if (args.json) {
      write(stdout, `${JSON.stringify(payload, null, 2)}\n`);
    } else {
      write(stdout, formatBootstrapResult(summary, health));
      write(stdout, formatDbHealth(health, 'bootstrap'));
    }
    return health.ok ? 0 : 1;
  } catch (error) {
    write(stderr, `${error.message}\n`);
    return 1;
  }
}
