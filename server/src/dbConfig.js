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

/** Hostname only: lower case, no port, no path, no query. */
export function databaseHostname(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const rewritten = raw.replace(/^(?:libsql|turso|wss|ws|http):\/\//i, 'https://');
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(rewritten) ? rewritten : `https://${rewritten}`;
  try {
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * First DNS label of a `*.turso.io` host. Legacy `db-org.turso.io` and
 * regional `db-org.aws-eu-west-1.turso.io` share that label.
 */
export function tursoDatabaseLabel(hostname) {
  const parts = String(hostname || '').toLowerCase().split('.').filter(Boolean);
  if (parts.length < 3) return null;
  if (parts.at(-2) !== 'turso' || parts.at(-1) !== 'io') return null;
  return parts[0] || null;
}

/** Same database host, ignoring scheme, port, path, and query. */
export function sameDatabaseHost(left, right) {
  const a = databaseHostname(left);
  const b = databaseHostname(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const labelA = tursoDatabaseLabel(a);
  const labelB = tursoDatabaseLabel(b);
  return Boolean(labelA && labelA === labelB);
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

function previewRefusal(base, code, message) {
  logPreviewRefusal(code, message);
  return {
    ...base,
    tursoUrl: null,
    tursoAuthToken: null,
    useTurso: false,
    previewBlocked: { code, message }
  };
}

function loadPreviewDbConfig(env, base, productionUrl, productionToken) {
  const comparisonUrl = nonEmpty(env.TURSO_PRODUCTION_DATABASE_URL) || productionUrl;
  const previewUrl = nonEmpty(env.TURSO_PREVIEW_DATABASE_URL);
  const previewToken = nonEmpty(env.TURSO_PREVIEW_AUTH_TOKEN);
  const pair = Boolean(previewUrl && previewToken);
  let block = null;

  if (!pair) {
    block = {
      code: 'preview_db_unconfigured',
      message: 'Preview database is not configured. Set TURSO_PREVIEW_DATABASE_URL and '
        + 'TURSO_PREVIEW_AUTH_TOKEN on the Vercel Preview environment. '
        + 'Refusing to open another database or local SQLite.'
    };
  } else if (comparisonUrl && sameDatabaseHost(previewUrl, comparisonUrl)) {
    const host = databaseHostname(previewUrl) || '(unparseable)';
    block = {
      code: 'preview_db_matches_production',
      message: `Preview database host equals the production database (${host}). Refusing to serve.`
    };
  } else if (productionToken && previewToken === productionToken) {
    block = {
      code: 'preview_db_token_matches_production',
      message: 'Preview auth token equals the production auth token. Refusing to serve.'
    };
  }

  if (!block) {
    return {
      ...base,
      tursoUrl: previewUrl,
      tursoAuthToken: previewToken,
      useTurso: true,
      previewDatabase: true
    };
  }

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

  return previewRefusal(base, block.code, block.message);
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
