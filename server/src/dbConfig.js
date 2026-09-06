/**
 * Dual-mode DB settings: local SQLite by default, Turso HTTP when env is set.
 * Vercel (VERCEL / VERCEL_ENV) refuses ephemeral local sqlite.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const schemaPath = path.join(__dirname, 'schema.sql');

export const DEFAULT_SQLITE_FILENAME = 'procurement.db';

export function defaultSqlitePath() {
  return path.join(__dirname, '../data', DEFAULT_SQLITE_FILENAME);
}

export function runningOnVercel(env = process.env) {
  return Boolean(env.VERCEL || env.VERCEL_ENV);
}

export function preferTursoHttp(env = process.env) {
  const flag = String(env.PROCUREFLOW_LIBSQL_HTTP || '').trim().toLowerCase();
  if (flag === '1' || flag === 'true' || flag === 'yes') return true;
  if (flag === '0' || flag === 'false' || flag === 'no') return false;
  // Always HTTP when Turso is selected — never load a native libsql wheel.
  return true;
}

export class TursoConfigError extends Error {
  constructor(message, { statusCode = 503 } = {}) {
    super(message);
    this.name = 'TursoConfigError';
    this.statusCode = statusCode;
  }
}

export const TURSO_REQUIRED_MSG =
  'Vercel deploys require TURSO_DATABASE_URL and TURSO_AUTH_TOKEN '
  + '(ephemeral local SQLite is not supported). Set both on the Vercel project '
  + 'for Production and Preview (or All Environments), then Redeploy.';

export function loadDbConfig(env = process.env) {
  const onVercel = runningOnVercel(env);
  const tursoUrl = String(env.TURSO_DATABASE_URL || '').trim() || null;
  const tursoAuthToken = String(env.TURSO_AUTH_TOKEN || '').trim() || null;
  const useTurso = Boolean(tursoUrl && tursoAuthToken);
  const sqlitePath = env.PROCUREMENT_DB_PATH || defaultSqlitePath();
  return {
    onVercel,
    tursoUrl,
    tursoAuthToken,
    useTurso,
    sqlitePath,
    preferHttp: preferTursoHttp(env)
  };
}

export function assertDeployableConfig(config = loadDbConfig()) {
  if (config.onVercel && !config.useTurso) {
    throw new TursoConfigError(TURSO_REQUIRED_MSG);
  }
  return config;
}

export function ensureSqliteDataDir(sqlitePath) {
  if (!sqlitePath || sqlitePath === ':memory:') return;
  const dir = path.dirname(sqlitePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
