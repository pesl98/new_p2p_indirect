/**
 * Per-customer SSO configuration.
 *
 * One deployment and one database per customer. IdP endpoints and secrets
 * come from the environment (this file). The tenant_settings row only stores
 * the provisioning switch and the default least-privilege role — never a
 * client secret or IdP certificate.
 *
 * Missing or invalid SSO settings stay `ready: false`. Callers must not mint
 * a session from that state.
 */

const ROLES = ['requester', 'approver', 'procurement', 'finance', 'admin'];

export function loadSsoConfig(env = process.env) {
  const identityProvider = normalizeIdentityProvider(env.IDENTITY_PROVIDER);
  const localFlag = parseFlag(env.LOCAL_LOGIN, true);
  const appBaseUrl = cleanOrigin(env.APP_BASE_URL);
  const problems = [];

  if (identityProvider === 'invalid') {
    problems.push('IDENTITY_PROVIDER');
  }

  const provisioningFlag = parseFlag(env.SSO_PROVISIONING, false);
  const roleRaw = String(env.SSO_DEFAULT_ROLE || '').trim().toLowerCase();
  let defaultRole = null;
  let defaultRoleInvalid = false;
  if (roleRaw) {
    if (ROLES.includes(roleRaw)) defaultRole = roleRaw;
    else defaultRoleInvalid = true;
  }

  const config = {
    identityProvider,
    localLogin: localFlag === true,
    appBaseUrl,
    provisioningEnabled: provisioningFlag === true,
    provisioningFlagInvalid: provisioningFlag === null,
    defaultRole,
    defaultRoleInvalid,
    problems,
    ready: false,
    oidc: null,
    saml: null
  };

  if (identityProvider === 'oidc') {
    config.oidc = readOidc(env, appBaseUrl, problems);
  } else if (identityProvider === 'saml') {
    config.saml = readSaml(env, appBaseUrl, problems);
  }

  config.ready = (identityProvider === 'oidc' || identityProvider === 'saml')
    && problems.length === 0
    && (identityProvider === 'oidc' ? Boolean(config.oidc) : Boolean(config.saml));
  return config;
}

export function normalizeIdentityProvider(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw || raw === 'local') return 'local';
  if (raw === 'oidc' || raw === 'saml') return raw;
  return 'invalid';
}

function readOidc(env, appBaseUrl, problems) {
  const allowInsecure = parseFlag(env.OIDC_ALLOW_INSECURE, false) === true;
  const issuer = parseIssuer(env.OIDC_ISSUER, allowInsecure);
  const clientId = cleanToken(env.OIDC_CLIENT_ID);
  const clientSecret = String(env.OIDC_CLIENT_SECRET || '').trim();
  const explicitRedirect = parseHttpUrl(env.OIDC_REDIRECT_URI);
  const base = appBaseUrl || (explicitRedirect ? explicitRedirect.origin : null);
  const redirectUri = explicitRedirect
    ? explicitRedirect.toString()
    : (base ? joinPath(base, '/api/auth/oidc/callback') : null);
  const scopes = readScopes(env.OIDC_SCOPES);

  if (!issuer) problems.push('OIDC_ISSUER');
  if (!clientId) problems.push('OIDC_CLIENT_ID');
  if (!clientSecret) problems.push('OIDC_CLIENT_SECRET');
  if (!redirectUri) problems.push('OIDC_REDIRECT_URI');
  if (!scopes) problems.push('OIDC_SCOPES');
  if (parseFlag(env.OIDC_ALLOW_INSECURE, false) === null) problems.push('OIDC_ALLOW_INSECURE');
  if (!base) problems.push('APP_BASE_URL');

  if (!issuer || !clientId || !clientSecret || !redirectUri || !scopes || !base) return null;
  return {
    issuer,
    clientId,
    clientSecret,
    redirectUri,
    scopes,
    allowInsecure,
    appBaseUrl: base
  };
}

function readSaml(env, appBaseUrl, problems) {
  const allowInsecure = parseFlag(env.SAML_ALLOW_INSECURE, false) === true;
  const entryPoint = parseHttpUrl(env.SAML_ENTRY_POINT, allowInsecure ? 'http' : 'https');
  const idpCert = normalizeCertificate(env.SAML_IDP_CERT);
  const idpIssuer = cleanEntityId(env.SAML_IDP_ISSUER);
  const spEntityId = cleanEntityId(env.SAML_SP_ENTITY_ID);
  const explicitAcs = parseHttpUrl(env.SAML_ACS_URL);
  const base = appBaseUrl || (explicitAcs ? explicitAcs.origin : null);
  const acsUrl = explicitAcs
    ? explicitAcs.toString()
    : (base ? joinPath(base, '/api/auth/saml/acs') : null);
  const audience = cleanEntityId(env.SAML_AUDIENCE) || spEntityId;
  const wantAssertions = parseFlag(env.SAML_WANT_ASSERTIONS_SIGNED, true);
  const wantResponse = parseFlag(env.SAML_WANT_RESPONSE_SIGNED, false);

  if (!entryPoint) problems.push('SAML_ENTRY_POINT');
  if (!idpCert) problems.push('SAML_IDP_CERT');
  if (!idpIssuer) problems.push('SAML_IDP_ISSUER');
  if (!spEntityId) problems.push('SAML_SP_ENTITY_ID');
  if (!acsUrl) problems.push('SAML_ACS_URL');
  if (!audience) problems.push('SAML_AUDIENCE');
  if (!base) problems.push('APP_BASE_URL');
  if (wantAssertions === null) problems.push('SAML_WANT_ASSERTIONS_SIGNED');
  if (wantResponse === null) problems.push('SAML_WANT_RESPONSE_SIGNED');
  if (wantAssertions === false && wantResponse === false) {
    problems.push('SAML_SIGNATURE_REQUIRED');
  }
  if (parseFlag(env.SAML_ALLOW_INSECURE, false) === null) problems.push('SAML_ALLOW_INSECURE');

  if (!entryPoint || !idpCert || !idpIssuer || !spEntityId || !acsUrl || !audience || !base) {
    return null;
  }
  if (wantAssertions === null || wantResponse === null) return null;
  if (wantAssertions === false && wantResponse === false) return null;

  return {
    entryPoint: entryPoint.toString(),
    idpCert,
    idpIssuer,
    spEntityId,
    acsUrl,
    audience,
    wantAssertionsSigned: wantAssertions === true,
    wantResponseSigned: wantResponse === true,
    appBaseUrl: base
  };
}

function readScopes(value) {
  const raw = String(value ?? '').trim();
  const scopes = raw ? raw.split(/\s+/).filter(Boolean) : ['openid', 'email', 'profile'];
  if (!scopes.includes('openid')) return null;
  return scopes.join(' ');
}

function parseFlag(value, defaultValue) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return defaultValue;
  if (raw === '1' || raw === 'true' || raw === 'yes') return true;
  if (raw === '0' || raw === 'false' || raw === 'no') return false;
  return null;
}

function cleanOrigin(value) {
  const url = parseHttpUrl(value);
  if (!url) return null;
  return url.origin;
}

function joinPath(origin, pathname) {
  const url = new URL(origin);
  url.pathname = pathname;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function parseIssuer(value, allowInsecure) {
  const url = parseHttpUrl(value, allowInsecure ? 'http' : 'https');
  if (!url) return null;
  if (url.username || url.password) return null;
  url.hash = '';
  url.search = '';
  let href = url.toString();
  if (url.pathname === '/' && href.endsWith('/')) href = href.slice(0, -1);
  return href;
}

function parseHttpUrl(value, protocol = 'any') {
  const text = String(value ?? '').trim();
  if (!text || /\s/.test(text)) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (protocol === 'https' && url.protocol !== 'https:') return null;
  if (protocol === 'http' && url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  url.hash = '';
  return url;
}

function cleanToken(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 512 || /[\s\u0000]/.test(text)) return null;
  return text;
}

function cleanEntityId(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 512 || /\s/.test(text)) return null;
  if (text.startsWith('urn:')) return text;
  return parseHttpUrl(text) ? text.replace(/\/$/, '') : null;
}

export function normalizeCertificate(value) {
  let text = String(value ?? '').trim();
  if (!text) return null;
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  text = text.replace(/\\n/g, '\n').trim();
  if (!text.includes('BEGIN CERTIFICATE')) {
    const body = text.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/=]+$/.test(body) || body.length < 64) return null;
    const lines = body.match(/.{1,64}/g) || [];
    text = `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
  }
  if (!text.includes('BEGIN CERTIFICATE') || !text.includes('END CERTIFICATE')) return null;
  return text.endsWith('\n') ? text : `${text}\n`;
}
