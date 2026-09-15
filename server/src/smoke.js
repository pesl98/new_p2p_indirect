/**
 * Post-provision HTTP smoke checks for a customer deploy.
 *
 * Hits the same public URLs as scripts/provision-customer.md so operators
 * can replace copy-paste curl with `npm run smoke`. Does not open the DB
 * and does not shell out to turso/vercel.
 */

export const DEFAULT_BASE_URL = 'http://127.0.0.1:5000';
export const DEFAULT_TIMEOUT_MS = 15000;

export const SMOKE_HELP = `ProcureFlow post-provision smoke

Usage:
  npm run smoke -- [--base-url URL] [--email EMAIL --password PASS] [--json]
  BASE_URL=https://<customer>.vercel.app npm run smoke

Checks (exit 1 if any fail):
  GET /api/health          status=ok, db=sqlite|turso-http
  GET /api/auth/config     auth=session, bootstrapNeeded boolean
  GET /api/users           JSON array (empty tenant → [])
  GET /api/auth/me         401 without a session cookie
  GET /api/departments     JSON array
  GET /api/catalog         JSON array
  POST /api/auth/login     optional, when --email/--password (or SMOKE_*) set
  GET  /api/auth/me        optional, session user after login

Env:
  BASE_URL                 Default ${DEFAULT_BASE_URL}
  SMOKE_EMAIL / SMOKE_PASSWORD   Optional login check after bootstrap
  SMOKE_TIMEOUT_MS         Per-request timeout (default ${DEFAULT_TIMEOUT_MS})

Does not seed. Real customer: db:migrate → bootstrap-admin → smoke.
See docs/DEPLOYMENT.md and scripts/provision-customer.md.
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

export function parseSmokeArgs(argv = []) {
  const flags = {
    json: false,
    help: false,
    unknown: []
  };
  let baseUrl;
  let email;
  let password;
  let timeoutMs;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      flags.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
      continue;
    }
    if (arg === '--base-url' || arg.startsWith('--base-url=')
      || arg === '--url' || arg.startsWith('--url=')) {
      const taken = takeFlagValue(argv, i, arg);
      baseUrl = taken.value === true ? '' : taken.value;
      i = taken.nextIndex;
      continue;
    }
    if (arg === '--email' || arg.startsWith('--email=')) {
      const taken = takeFlagValue(argv, i, arg);
      email = taken.value === true ? '' : taken.value;
      i = taken.nextIndex;
      continue;
    }
    if (arg === '--password' || arg.startsWith('--password=')) {
      const taken = takeFlagValue(argv, i, arg);
      password = taken.value === true ? '' : taken.value;
      i = taken.nextIndex;
      continue;
    }
    if (arg === '--timeout' || arg === '--timeout-ms' || arg.startsWith('--timeout=')) {
      const taken = takeFlagValue(argv, i, arg);
      timeoutMs = taken.value === true ? '' : taken.value;
      i = taken.nextIndex;
      continue;
    }
    flags.unknown.push(arg);
  }

  return {
    ...flags,
    baseUrl: asTrimmed(baseUrl) || null,
    email: asTrimmed(email) || null,
    password: password == null ? null : String(password),
    timeoutMs: timeoutMs == null || timeoutMs === '' ? null : Number(timeoutMs)
  };
}

export function resolveSmokeOptions(argv = [], env = process.env) {
  const args = parseSmokeArgs(argv);
  const timeoutRaw = args.timeoutMs ?? env.SMOKE_TIMEOUT_MS;
  const timeoutMs = Number(timeoutRaw);
  return {
    ...args,
    baseUrl: args.baseUrl || asTrimmed(env.BASE_URL) || DEFAULT_BASE_URL,
    email: args.email || asTrimmed(env.SMOKE_EMAIL) || null,
    password: args.password != null && args.password !== ''
      ? args.password
      : (env.SMOKE_PASSWORD != null && String(env.SMOKE_PASSWORD) !== ''
        ? String(env.SMOKE_PASSWORD)
        : null),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS
  };
}

export function normalizeBaseUrl(url) {
  const raw = asTrimmed(url);
  if (!raw) {
    throw new Error('BASE_URL is required (example: http://127.0.0.1:5000 or https://<customer>.vercel.app)');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`BASE_URL is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`BASE_URL must be http or https (got ${parsed.protocol || 'none'})`);
  }
  parsed.hash = '';
  let href = parsed.toString();
  if (href.endsWith('/') && parsed.pathname === '/') {
    href = href.slice(0, -1);
  } else {
    href = href.replace(/\/+$/, '');
  }
  return href;
}

export function describeFetchError(error, url) {
  const cause = error?.cause;
  const code = cause?.code || error?.code;
  const message = error?.message || String(error);
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(message)) {
    return `Cannot reach ${url} (connection refused). Start the app locally (npm start) or set BASE_URL to the customer Vercel hostname.`;
  }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError'
    || /aborted|timeout/i.test(message)) {
    return `Timed out requesting ${url}. Check the URL and that the deploy is up.`;
  }
  return `Request to ${url} failed: ${message}`;
}

export function sessionCookieFromHeaders(headers) {
  if (!headers) return '';
  const raw = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : (headers.get?.('set-cookie') ? [headers.get('set-cookie')] : []);
  const parts = (raw || [])
    .map((cookie) => String(cookie).split(';')[0].trim())
    .filter(Boolean);
  const session = parts.filter((part) => part.startsWith('pf_session='));
  return (session.length ? session : parts).join('; ');
}

function configErrorHint(status, json, text) {
  const errName = json?.error || '';
  const detail = json?.detail || (typeof text === 'string' ? text.slice(0, 180) : '');
  if (status === 503 || /TursoConfigError/i.test(errName) || /TURSO_/i.test(detail)) {
    return `HTTP ${status}${errName ? ` ${errName}` : ''}`
      + `${detail ? `: ${String(detail).replace(/\s+/g, ' ').trim()}` : ''}. `
      + 'Set TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, and SESSION_SECRET on Production and Preview, then Redeploy.';
  }
  return null;
}

function fail(name, message, extra = {}) {
  return { ok: false, name, message, ...extra };
}

function pass(name, detail, extra = {}) {
  return { ok: true, name, detail, ...extra };
}

export function checkHealthResponse({ status, json, text } = {}) {
  const hint = configErrorHint(status, json, text);
  if (hint) return fail('GET /api/health', hint, { status });
  if (status !== 200) {
    return fail('GET /api/health', `expected HTTP 200, got ${status}`, { status });
  }
  if (!json || json.status !== 'ok') {
    return fail('GET /api/health', 'expected JSON { status: "ok" }', { status, json });
  }
  if (json.db !== 'sqlite' && json.db !== 'turso-http') {
    return fail('GET /api/health', `unexpected db mode "${json.db}" (want sqlite or turso-http)`, { status, json });
  }
  return pass('GET /api/health', `db=${json.db}`, { status, json });
}

export function checkAuthConfigResponse({ status, json, text } = {}) {
  const hint = configErrorHint(status, json, text);
  if (hint) return fail('GET /api/auth/config', hint, { status });
  if (status !== 200) {
    return fail('GET /api/auth/config', `expected HTTP 200, got ${status}`, { status });
  }
  if (!json || json.auth !== 'session') {
    return fail('GET /api/auth/config', 'expected JSON { auth: "session" }', { status, json });
  }
  if (typeof json.bootstrapNeeded !== 'boolean') {
    return fail('GET /api/auth/config', 'expected bootstrapNeeded boolean', { status, json });
  }
  if (typeof json.demoPersonaSwitcher !== 'boolean') {
    return fail('GET /api/auth/config', 'expected demoPersonaSwitcher boolean', { status, json });
  }
  const tenant = json.bootstrapNeeded ? 'empty tenant (bootstrapNeeded)' : 'users present';
  const switcher = json.demoPersonaSwitcher ? 'demoPersonaSwitcher=on' : 'demoPersonaSwitcher=off';
  return pass('GET /api/auth/config', `${tenant}, ${switcher}`, { status, json });
}

export function checkUsersResponse({ status, json, text } = {}, { bootstrapNeeded } = {}) {
  const hint = configErrorHint(status, json, text);
  if (hint) return fail('GET /api/users', hint, { status });
  if (status !== 200) {
    return fail('GET /api/users', `expected HTTP 200, got ${status}`, { status });
  }
  if (!Array.isArray(json)) {
    return fail('GET /api/users', 'expected a JSON array', { status, json });
  }
  const leaked = json.some((row) => row && Object.prototype.hasOwnProperty.call(row, 'password_hash'));
  if (leaked) {
    return fail('GET /api/users', 'response leaked password_hash', { status });
  }
  if (bootstrapNeeded === true && json.length !== 0) {
    return fail(
      'GET /api/users',
      `auth/config said bootstrapNeeded but /api/users returned ${json.length} row(s)`,
      { status }
    );
  }
  if (bootstrapNeeded === false && json.length === 0) {
    return fail(
      'GET /api/users',
      'auth/config said users exist but /api/users returned []',
      { status }
    );
  }
  const label = json.length === 0 ? '0 users (empty tenant)' : `${json.length} user(s)`;
  return pass('GET /api/users', label, { status, json });
}

export function checkUnauthenticatedMeResponse({ status, json, text } = {}) {
  const hint = configErrorHint(status, json, text);
  if (hint) return fail('GET /api/auth/me', hint, { status });
  if (status !== 401) {
    return fail('GET /api/auth/me', `expected HTTP 401 without a session, got ${status}`, { status, json });
  }
  return pass('GET /api/auth/me', '401 unauthenticated (session gate ok)', { status });
}

export function checkJsonArrayResponse(name, { status, json, text } = {}) {
  const hint = configErrorHint(status, json, text);
  if (hint) return fail(name, hint, { status });
  if (status !== 200) {
    return fail(name, `expected HTTP 200, got ${status}`, { status });
  }
  if (!Array.isArray(json)) {
    return fail(name, 'expected a JSON array', { status, json });
  }
  return pass(name, `${json.length} row(s)`, { status, json });
}

export function checkLoginResponse({ status, json, cookie } = {}) {
  if (status !== 200 || !json?.user) {
    const err = json?.error || `HTTP ${status}`;
    return fail('POST /api/auth/login', `login failed (${err})`, { status, json });
  }
  if (!cookie || !/pf_session=/.test(cookie)) {
    return fail('POST /api/auth/login', 'login succeeded but no pf_session cookie', { status });
  }
  if (Object.prototype.hasOwnProperty.call(json.user, 'password_hash')) {
    return fail('POST /api/auth/login', 'login leaked password_hash', { status });
  }
  return pass('POST /api/auth/login', `signed in as ${json.user.email || json.user.name}`, {
    status,
    json,
    cookie
  });
}

export function checkAuthenticatedMeResponse({ status, json } = {}, { email } = {}) {
  if (status !== 200 || !json?.user) {
    return fail('GET /api/auth/me (session)', `expected session user, got HTTP ${status}`, { status, json });
  }
  if (email && String(json.user.email).toLowerCase() !== String(email).toLowerCase()) {
    return fail(
      'GET /api/auth/me (session)',
      `expected ${email}, got ${json.user.email}`,
      { status, json }
    );
  }
  return pass('GET /api/auth/me (session)', `user=${json.user.email}`, { status, json });
}

async function requestJson(fetchFn, url, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs
} = {}) {
  const options = {
    method,
    headers: {
      Accept: 'application/json',
      ...headers
    }
  };
  if (body != null) options.body = body;
  if (timeoutMs) {
    options.signal = AbortSignal.timeout(timeoutMs);
  }
  const response = await fetchFn(url, options);
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return {
    status: response.status,
    ok: response.ok,
    json,
    text,
    cookie: sessionCookieFromHeaders(response.headers)
  };
}

export async function runSmokeChecks({
  baseUrl,
  fetchFn = fetch,
  email = null,
  password = null,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const origin = normalizeBaseUrl(baseUrl);
  const checks = [];
  const wantLogin = Boolean(email && password);

  const get = (path, extra) => requestJson(fetchFn, `${origin}${path}`, {
    timeoutMs,
    ...extra
  });

  try {
    checks.push(checkHealthResponse(await get('/api/health')));
  } catch (error) {
    checks.push(fail('GET /api/health', describeFetchError(error, `${origin}/api/health`)));
    return summarize(origin, checks);
  }

  let authConfig;
  try {
    const result = await get('/api/auth/config');
    authConfig = result.json;
    checks.push(checkAuthConfigResponse(result));
  } catch (error) {
    checks.push(fail('GET /api/auth/config', describeFetchError(error, `${origin}/api/auth/config`)));
    return summarize(origin, checks);
  }

  try {
    checks.push(checkUsersResponse(await get('/api/users'), {
      bootstrapNeeded: authConfig?.bootstrapNeeded
    }));
  } catch (error) {
    checks.push(fail('GET /api/users', describeFetchError(error, `${origin}/api/users`)));
  }

  try {
    checks.push(checkUnauthenticatedMeResponse(await get('/api/auth/me')));
  } catch (error) {
    checks.push(fail('GET /api/auth/me', describeFetchError(error, `${origin}/api/auth/me`)));
  }

  try {
    checks.push(checkJsonArrayResponse('GET /api/departments', await get('/api/departments')));
  } catch (error) {
    checks.push(fail('GET /api/departments', describeFetchError(error, `${origin}/api/departments`)));
  }

  try {
    checks.push(checkJsonArrayResponse('GET /api/catalog', await get('/api/catalog')));
  } catch (error) {
    checks.push(fail('GET /api/catalog', describeFetchError(error, `${origin}/api/catalog`)));
  }

  if (wantLogin) {
    try {
      const login = await get('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const loginCheck = checkLoginResponse(login);
      checks.push(loginCheck);
      if (loginCheck.ok) {
        const me = await get('/api/auth/me', {
          headers: { Cookie: login.cookie }
        });
        checks.push(checkAuthenticatedMeResponse(me, { email }));
      }
    } catch (error) {
      checks.push(fail('POST /api/auth/login', describeFetchError(error, `${origin}/api/auth/login`)));
    }
  } else if (authConfig?.bootstrapNeeded) {
    checks.push(pass(
      'POST /api/auth/login',
      'skipped (empty tenant; bootstrap-admin first, or pass --email/--password)',
      { skipped: true }
    ));
  }

  return summarize(origin, checks);
}

function summarize(baseUrl, checks) {
  const failed = checks.filter((check) => !check.ok);
  const skipped = checks.filter((check) => check.skipped);
  const passed = checks.filter((check) => check.ok && !check.skipped);
  return {
    ok: failed.length === 0,
    baseUrl,
    checks,
    passed: passed.length,
    failed: failed.length,
    skipped: skipped.length
  };
}

export function formatSmokeReport(result) {
  const lines = [`ProcureFlow smoke — ${result.baseUrl}`];
  for (const check of result.checks) {
    if (check.skipped) {
      lines.push(`  SKIP  ${check.name}  (${check.detail})`);
      continue;
    }
    if (check.ok) {
      lines.push(`  PASS  ${check.name}${check.detail ? `  (${check.detail})` : ''}`);
    } else {
      lines.push(`  FAIL  ${check.name}  ${check.message}`);
    }
  }
  if (result.ok) {
    const skipBit = result.skipped ? `, ${result.skipped} skipped` : '';
    lines.push(`OK — ${result.passed} check(s) passed${skipBit}`);
  } else {
    lines.push(`FAILED — ${result.failed} check(s) failed, ${result.passed} passed`);
  }
  return `${lines.join('\n')}\n`;
}

export function publicSmokeResult(result) {
  return {
    ok: result.ok,
    baseUrl: result.baseUrl,
    passed: result.passed,
    failed: result.failed,
    skipped: result.skipped || 0,
    checks: result.checks.map((check) => ({
      name: check.name,
      ok: check.ok,
      skipped: Boolean(check.skipped),
      detail: check.detail || null,
      message: check.message || null,
      status: check.status ?? null
    }))
  };
}

export async function runSmokeCli({
  argv = [],
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  fetchFn = fetch
} = {}) {
  const options = resolveSmokeOptions(argv, env);
  if (options.help) {
    write(stdout, SMOKE_HELP);
    return 0;
  }
  if (options.unknown.length) {
    write(stderr, `Unknown argument: ${options.unknown[0]}\n${SMOKE_HELP}`);
    return 1;
  }
  if ((options.email && !options.password) || (!options.email && options.password)) {
    write(stderr, 'Login check requires both --email and --password (or SMOKE_EMAIL and SMOKE_PASSWORD).\n');
    return 1;
  }

  let result;
  try {
    result = await runSmokeChecks({
      baseUrl: options.baseUrl,
      fetchFn,
      email: options.email,
      password: options.password,
      timeoutMs: options.timeoutMs
    });
  } catch (error) {
    write(stderr, `${error.message || error}\n`);
    return 1;
  }

  if (options.json) {
    write(stdout, `${JSON.stringify(publicSmokeResult(result), null, 2)}\n`);
  } else {
    write(stdout, formatSmokeReport(result));
  }
  return result.ok ? 0 : 1;
}
