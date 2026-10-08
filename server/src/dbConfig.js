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
  constructor(message, { statusCode = 503, code } = {}) {
    super(message);
    this.name = 'TursoConfigError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** Exact opt-in. Any other value, including `1` or `true`, does not open production from Preview. */
export const PREVIEW_PRODUCTION_DB_ALLOW_ENV = 'ALLOW_PREVIEW_PRODUCTION_DATABASE';
export const PREVIEW_PRODUCTION_DB_ALLOW_VALUE = 'allow';

export function normalizeDatabaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let candidate = raw;
  if (candidate.startsWith('libsql://')) candidate = `https://${candidate.slice('libsql://'.length)}`;
  else if (candidate.startsWith('turso://')) candidate = `https://${candidate.slice('turso://'.length)}`;
  try {
    const parsed = new URL(candidate);
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = '';
    parsed.search = '';
    parsed.username = '';
    parsed.password = '';
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/$/, '');
    return parsed.toString();
  } catch {
    return raw.replace(/\/$/, '').toLowerCase();
  }
}

export function databaseHost(value) {
  const normalized = normalizeDatabaseUrl(value);
  try {
    return new URL(normalized).host;
  } catch {
    return '';
  }
}

function nonEmpty(value) {
  const text = String(value || '').trim();
  return text || null;
}

export function allowPreviewProductionDatabase(env = process.env) {
  return String(env[PREVIEW_PRODUCTION_DB_ALLOW_ENV] || '').trim() === PREVIEW_PRODUCTION_DB_ALLOW_VALUE;
}

function logPreviewRefusal(code, message) {
  console.error(`ProcureFlow preview database refused: ${code}. ${message}`);
}

function logPreviewEscape(host) {
  console.error(
    'ALLOW_PREVIEW_PRODUCTION_DATABASE=allow — PREVIEW IS SERVING THE PRODUCTION DATABASE. '
    + `Host: ${host || '(unset)'}. Remove this variable and set TURSO_PREVIEW_DATABASE_URL `
    + 'to a different Turso database before any customer uses Preview.'
  );
}

export const TURSO_REQUIRED_MSG =
  'Vercel deploys require TURSO_DATABASE_URL and TURSO_AUTH_TOKEN '
  + '(ephemeral local SQLite is not supported). Set both on the Vercel project '
  + 'for Production and Preview (or All Environments), then Redeploy.';

export function loadDbConfig(env = process.env) {
  const onVercel = runningOnVercel(env);
  const vercelEnv = nonEmpty(env.VERCEL_ENV);
  const productionUrl = nonEmpty(env.TURSO_DATABASE_URL);
  const productionToken = nonEmpty(env.TURSO_AUTH_TOKEN);
  const sqlitePath = env.PROCUREMENT_DB_PATH || defaultSqlitePath();
  const base = {
    onVercel,
    vercelEnv,
    sqlitePath,
    preferHttp: preferTursoHttp(env),
    previewDatabase: false,
    previewBlocked: null,
    allowPreviewProductionDatabase: false
  };

  if (vercelEnv === 'preview') {
    return loadPreviewDbConfig(env, base, productionUrl, productionToken);
  }

  const useTurso = Boolean(productionUrl && productionToken);
  return {
    ...base,
    tursoUrl: productionUrl,
    tursoAuthToken: productionToken,
    useTurso
  };
}

function loadPreviewDbConfig(env, base, productionUrl, productionToken) {
  const comparisonUrl = nonEmpty(env.TURSO_PRODUCTION_DATABASE_URL) || productionUrl;
  if (allowPreviewProductionDatabase(env)) {
    logPreviewEscape(databaseHost(productionUrl));
    return {
      ...base,
      tursoUrl: productionUrl,
      tursoAuthToken: productionToken,
      useTurso: Boolean(productionUrl && productionToken),
      allowPreviewProductionDatabase: true,
      previewDatabase: false
    };
  }

  const previewUrl = nonEmpty(env.TURSO_PREVIEW_DATABASE_URL);
  const previewToken = nonEmpty(env.TURSO_PREVIEW_AUTH_TOKEN);
  if (!previewUrl || !previewToken) {
    const message = 'Preview database is not configured. Set TURSO_PREVIEW_DATABASE_URL and '
      + 'TURSO_PREVIEW_AUTH_TOKEN on the Vercel Preview environment. '
      + 'Refusing to open TURSO_DATABASE_URL.';
    logPreviewRefusal('preview_db_unconfigured', message);
    return {
      ...base,
      tursoUrl: null,
      tursoAuthToken: null,
      useTurso: false,
      previewBlocked: { code: 'preview_db_unconfigured', message }
    };
  }

  if (!comparisonUrl) {
    const message = 'Preview cannot verify that its database is not production. '
      + 'Set TURSO_PRODUCTION_DATABASE_URL to the production libsql URL (no token) on Preview, '
      + 'or leave TURSO_DATABASE_URL set to that production URL for comparison only.';
    logPreviewRefusal('preview_db_unverified', message);
    return {
      ...base,
      tursoUrl: null,
      tursoAuthToken: null,
      useTurso: false,
      previewBlocked: { code: 'preview_db_unverified', message }
    };
  }

  if (normalizeDatabaseUrl(previewUrl) === normalizeDatabaseUrl(comparisonUrl)) {
    const host = databaseHost(previewUrl) || '(unparseable)';
    const message = `Preview database URL equals the production database (${host}). Refusing to serve.`;
    logPreviewRefusal('preview_db_matches_production', message);
    return {
      ...base,
      tursoUrl: null,
      tursoAuthToken: null,
      useTurso: false,
      previewBlocked: { code: 'preview_db_matches_production', message }
    };
  }

  return {
    ...base,
    tursoUrl: previewUrl,
    tursoAuthToken: previewToken,
    useTurso: true,
    previewDatabase: true
  };
}

export function assertDeployableConfig(config = loadDbConfig()) {
  if (config.previewBlocked) {
    throw new TursoConfigError(config.previewBlocked.message, { code: config.previewBlocked.code });
  }
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
