/**
 * OIDC authorization-code login (PKCE + state + nonce).
 *
 * Token checks (signature, issuer, audience, expiry, nonce) are done by
 * openid-client. This module only stores the transaction and maps the
 * verified subject onto pf_session.
 */

import crypto from 'crypto';
import * as client from 'openid-client';
import {
  SsoError,
  classifyProviderError,
  completeSsoLogin,
  consumeSsoRequest,
  recordProviderFailure,
  saveSsoRequest
} from './sso.js';

const configurations = new Map();

export async function startOidcLogin(db, sso) {
  assertOidcReady(sso);
  let oidc;
  try {
    oidc = await configurationFor(sso.oidc);
  } catch (error) {
    throw await recordProviderFailure(db, 'oidc', error);
  }
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();
  const nonce = client.randomNonce();
  const redirectUrl = client.buildAuthorizationUrl(oidc, {
    redirect_uri: sso.oidc.redirectUri,
    scope: sso.oidc.scopes,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce
  });
  await saveSsoRequest(db, {
    id: state,
    provider: 'oidc',
    payload: JSON.stringify({
      nonce,
      codeVerifier,
      redirectUri: sso.oidc.redirectUri
    })
  });
  return redirectUrl.toString();
}

export async function finishOidcLogin(db, sso, query) {
  assertOidcReady(sso);
  const state = oneString(query?.state);
  const code = oneString(query?.code);
  if (oneString(query?.error)) {
    const error = new SsoError('sso_token_invalid');
    await recordProviderFailure(db, 'oidc', error);
    throw error;
  }

  const row = await consumeSsoRequest(db, state, 'oidc');
  if (!row || !code) {
    const error = new SsoError('sso_state_invalid');
    await recordProviderFailure(db, 'oidc', error);
    throw error;
  }

  let stored;
  try {
    stored = JSON.parse(row.payload);
  } catch {
    stored = null;
  }
  if (!stored?.nonce || !stored?.codeVerifier || !stored?.redirectUri) {
    const error = new SsoError('sso_state_invalid');
    await recordProviderFailure(db, 'oidc', error);
    throw error;
  }

  const callbackUrl = new URL(stored.redirectUri);
  callbackUrl.searchParams.set('code', code);
  callbackUrl.searchParams.set('state', state);
  const iss = oneString(query?.iss);
  if (iss) callbackUrl.searchParams.set('iss', iss);

  let tokens;
  try {
    const oidc = await configurationFor(sso.oidc);
    tokens = await client.authorizationCodeGrant(oidc, callbackUrl, {
      pkceCodeVerifier: stored.codeVerifier,
      expectedState: state,
      expectedNonce: stored.nonce
    });
  } catch (error) {
    const wrapped = classifyProviderError(error);
    await recordProviderFailure(db, 'oidc', wrapped);
    throw wrapped;
  }

  const claims = typeof tokens.claims === 'function' ? tokens.claims() : null;
  if (!claims || typeof claims.sub !== 'string' || !claims.sub.trim()) {
    const error = new SsoError('sso_token_invalid');
    await recordProviderFailure(db, 'oidc', error);
    throw error;
  }

  const jti = typeof claims.jti === 'string' ? claims.jti.trim() : '';
  const assertionId = jti || crypto.createHash('sha256').update(String(tokens.id_token || '')).digest('hex');
  return completeSsoLogin(db, sso, {
    provider: 'oidc',
    subject: claims.sub.trim(),
    email: typeof claims.email === 'string' ? claims.email : null,
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    name: typeof claims.name === 'string' ? claims.name : null,
    assertionId
  });
}

function assertOidcReady(sso) {
  if (!sso || sso.identityProvider !== 'oidc' || !sso.ready || !sso.oidc) {
    throw new SsoError('sso_not_configured', 503);
  }
}

function oneString(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

async function configurationFor(oidc) {
  const key = `${oidc.issuer}\n${oidc.clientId}\n${oidc.clientSecret}\n${oidc.allowInsecure ? '1' : '0'}`;
  const cached = configurations.get(key);
  if (cached) return cached;
  const pending = discover(oidc);
  configurations.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    configurations.delete(key);
    throw error;
  }
}

async function discover(oidc) {
  // openid-client validates iss/aud/exp/nonce on the ID token, but signature
  // verification is opt-in. enableNonRepudiationChecks checks the JWS against
  // the issuer JWKS (application-level non-repudiation).
  const execute = [client.enableNonRepudiationChecks];
  if (oidc.allowInsecure) execute.unshift(client.allowInsecureRequests);
  const config = await client.discovery(
    new URL(oidc.issuer),
    oidc.clientId,
    oidc.clientSecret,
    undefined,
    { execute, timeout: 8 }
  );
  config.timeout = 8;
  return config;
}
