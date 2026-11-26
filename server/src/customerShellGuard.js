/**
 * Stop a shell that still holds another customer's Turso URL or a generated
 * secret from driving onboard:customer, turso:customer, or vercel:customer.
 *
 * PROCUREFLOW_SECRET_SLUG is an operator-shell label. It is not a deployment
 * variable and these commands do not write it to Vercel.
 *
 * Host check uses the same hostname rules as sameDatabaseHost (scheme, port,
 * path, and query ignored; name.turso.io and name.<region>.turso.io match).
 * Turso's hostname is <database>-<org>, so a first label of
 * procureflow-<slug>-<org> is this database. The preview database
 * procureflow-<slug>-preview is not accepted as the production URL.
 * The message names the variable and the slug. It never includes a secret,
 * a token, or the raw URL.
 */

import { databaseHostname, sameDatabaseHost, tursoDatabaseLabel } from './dbConfig.js';

export const SECRET_SLUG_ENV = 'PROCUREFLOW_SECRET_SLUG';

/** Generated secrets. Present in the shell only when labeled for this slug. */
export const GENERATED_SECRET_KEYS = Object.freeze([
  'SESSION_SECRET',
  'PORTAL_TOKEN_SECRET',
  'CRON_SECRET',
  'WEBHOOK_SIGNING_SECRET'
]);

/**
 * Values the guard and the Vercel CLI output redaction treat as secret.
 * URLs are included so a refused command cannot echo them.
 */
export const SHELL_VALUE_KEYS = Object.freeze([
  'TURSO_DATABASE_URL',
  'TURSO_AUTH_TOKEN',
  'TURSO_PREVIEW_DATABASE_URL',
  'TURSO_PREVIEW_AUTH_TOKEN',
  ...GENERATED_SECRET_KEYS
]);

const SLUG_SHAPE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

function asTrimmed(value) {
  return value == null ? '' : String(value).trim();
}

export function previewDatabaseName(dbName) {
  const name = asTrimmed(dbName).toLowerCase();
  if (!name) return '';
  if (name.endsWith('-preview')) return name;
  return `${name}-preview`;
}

/** Database label safe to put in an error. Not a URL and not a token. */
export function safeDatabaseLabel(url) {
  const label = tursoDatabaseLabel(databaseHostname(url));
  if (!label) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) return null;
  if (label.length > 80) return null;
  return label;
}

/**
 * True when `url` is `dbName` on Turso: the first DNS label is `dbName`
 * (including a regional host) or `dbName-<org>`. A production name does not
 * match the preview database `dbName-preview`.
 */
export function urlNamesDatabase(url, dbName) {
  const name = asTrimmed(dbName).toLowerCase();
  if (!name || !asTrimmed(url)) return false;
  if (sameDatabaseHost(url, `libsql://${name}.turso.io`)) return true;
  const label = tursoDatabaseLabel(databaseHostname(url));
  if (!label || !label.startsWith(`${name}-`)) return false;
  const rest = label.slice(name.length + 1);
  if (!rest) return false;
  if (!name.endsWith('-preview') && (rest === 'preview' || rest.startsWith('preview-'))) {
    return false;
  }
  return true;
}

function labelRepeatsASecret(raw, env) {
  for (const key of SHELL_VALUE_KEYS) {
    const value = asTrimmed(env[key]);
    if (value && value === raw) return true;
  }
  return false;
}

function secretSlugState(env, slug) {
  const raw = asTrimmed(env[SECRET_SLUG_ENV]);
  if (!raw) return { ok: false, shown: 'unset' };
  if (!SLUG_SHAPE.test(raw) || raw.length > 48 || labelRepeatsASecret(raw, env)) {
    return { ok: false, shown: 'not a customer slug (value not printed)' };
  }
  const normalized = raw.toLowerCase();
  if (normalized === slug) return { ok: true, shown: normalized };
  return { ok: false, shown: normalized };
}

function urlMismatchMessage(key, slug, dbName, url) {
  const label = safeDatabaseLabel(url);
  const found = label ? `; host names ${label}` : '';
  return `${key} does not belong to slug ${slug}: expected database ${dbName}${found}. `
    + 'The value was not printed.';
}

function secretSlugMessage(key, slug, shown) {
  return `${key} is set but ${SECRET_SLUG_ENV} is ${shown}, not ${slug}. The value was not printed.`;
}

/**
 * @returns {Error|null} Error whose message names variables and slugs only.
 */
export function customerShellGuardError({ env = {}, slug, dbName } = {}) {
  const customer = asTrimmed(slug).toLowerCase();
  const database = asTrimmed(dbName).toLowerCase();
  if (!customer || !database) return null;

  const slugState = secretSlugState(env, customer);
  const problems = [];
  const pairs = [
    {
      urlKey: 'TURSO_DATABASE_URL',
      tokenKey: 'TURSO_AUTH_TOKEN',
      expected: database
    },
    {
      urlKey: 'TURSO_PREVIEW_DATABASE_URL',
      tokenKey: 'TURSO_PREVIEW_AUTH_TOKEN',
      expected: previewDatabaseName(database)
    }
  ];

  for (const pair of pairs) {
    const url = asTrimmed(env[pair.urlKey]);
    const token = asTrimmed(env[pair.tokenKey]);
    const urlOk = Boolean(url) && urlNamesDatabase(url, pair.expected);
    if (url && !urlOk) {
      problems.push(urlMismatchMessage(pair.urlKey, customer, pair.expected, url));
    }
    if (token && !url) {
      problems.push(
        `${pair.tokenKey} is set but ${pair.urlKey} is not set for slug ${customer}. `
        + 'The value was not printed.'
      );
    } else if (token && !urlOk) {
      problems.push(
        `${pair.tokenKey} is set but ${pair.urlKey} does not match slug ${customer}. `
        + 'The value was not printed.'
      );
    } else if (token && !slugState.ok) {
      problems.push(secretSlugMessage(pair.tokenKey, customer, slugState.shown));
    }
  }

  for (const key of GENERATED_SECRET_KEYS) {
    if (!asTrimmed(env[key])) continue;
    if (slugState.ok) continue;
    problems.push(secretSlugMessage(key, customer, slugState.shown));
  }

  if (!problems.length) return null;
  const error = new Error(
    `${problems.join('\n')}\nNo Turso or Vercel command was run.`
  );
  error.code = 'customer_shell_mismatch';
  return error;
}
