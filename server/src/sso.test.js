import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { SignedXml } from 'xml-crypto';
import { createMemoryDatabase } from './db.js';
import { createApp } from './app.js';
import { loadDbConfig } from './dbConfig.js';
import {
  DEMO_SEED_PASSWORD,
  hashPassword,
  loadAuthConfig,
  parseCookies,
  verifySessionToken
} from './auth.js';

const ACS = 'https://customer.example/api/auth/saml/acs';
const SP_ENTITY = 'https://customer.example/saml';
const IDP_ISSUER = 'https://idp.example/metadata';
const CLIENT_ID = 'procureflow-test';
const CLIENT_SECRET = 'test-secret';
const REDIRECT_URI = 'https://customer.example/api/auth/oidc/callback';

function makeCertPair(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-saml-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', keyPath, '-out', certPath,
    '-days', '2', '-nodes', '-subj', `/CN=${name}`
  ], { stdio: 'ignore' });
  return {
    key: fs.readFileSync(keyPath, 'utf8'),
    cert: fs.readFileSync(certPath, 'utf8')
  };
}

const IDP_CERT = makeCertPair('procureflow-test-idp');
const OTHER_CERT = makeCertPair('procureflow-other');

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', async () => {
      try {
        const { port } = server.address();
        await fn(`http://127.0.0.1:${port}`);
        server.close(() => resolve());
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

function authFrom(env) {
  return loadAuthConfig(env, {
    sessionSecret: 'test-session-secret',
    bcryptRounds: 4,
    cookieSecure: false,
    demoPersonaSwitcher: false
  });
}

function appFor(db, env) {
  return createApp({ db, config: loadDbConfig({}), authConfig: authFrom(env) });
}

async function seedUsers(db) {
  db.exec(`
    INSERT INTO departments (id, code, name) VALUES (1, 'MKT', 'Marketing');
    INSERT INTO users (id, name, email, role, department_id, title, approval_limit, status) VALUES
      (1, 'Alice Chen', 'alice@example.com', 'requester', 1, 'Specialist', 0, 'active'),
      (5, 'Elena Rostova', 'elena@example.com', 'admin', 1, 'CFO', 0, 'active');
  `);
  const hash = await hashPassword(DEMO_SEED_PASSWORD, 4);
  const insert = db.prepare(`INSERT INTO user_credentials (user_id, password_hash) VALUES (?, ?)`);
  insert.run(1, hash);
  insert.run(5, hash);
}

function sessionFrom(response) {
  const list = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [];
  const joined = list.map((cookie) => String(cookie).split(';')[0]).join('; ');
  const cookies = parseCookies(joined);
  return {
    header: list.join('\n'),
    cookie: joined,
    session: verifySessionToken(cookies.pf_session, 'test-session-secret')
  };
}

async function readJson(response) {
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body, ...sessionFrom(response) };
}

function oidcEnv(issuer, extra = {}) {
  return {
    IDENTITY_PROVIDER: 'oidc',
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_CLIENT_SECRET: CLIENT_SECRET,
    APP_BASE_URL: 'https://customer.example',
    OIDC_ALLOW_INSECURE: '1',
    ...extra
  };
}

function samlEnv(extra = {}) {
  return {
    IDENTITY_PROVIDER: 'saml',
    SAML_ENTRY_POINT: 'https://idp.example/sso',
    SAML_IDP_CERT: IDP_CERT.cert,
    SAML_IDP_ISSUER: IDP_ISSUER,
    SAML_SP_ENTITY_ID: SP_ENTITY,
    APP_BASE_URL: 'https://customer.example',
    ...extra
  };
}

async function startIdp() {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const { privateKey: badKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  let issuer = '';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, issuer || 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code']
      }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      const fail = (description) => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant', error_description: description }));
      };
      if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET) {
        return fail('client authentication failed');
      }
      if (form.get('redirect_uri') !== REDIRECT_URI) return fail('redirect_uri mismatch');
      let payload;
      try {
        payload = JSON.parse(Buffer.from(form.get('code') || '', 'base64url').toString());
      } catch {
        return fail('code rejected');
      }
      const verifier = form.get('code_verifier') || '';
      const actual = crypto.createHash('sha256').update(verifier).digest('base64url');
      if (actual !== payload.challenge) return fail('PKCE verification failed');
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        nonce: payload.nonce,
        name: payload.name || 'SSO User',
        role: 'admin'
      };
      if (payload.email != null) claims.email = payload.email;
      if (payload.email_verified != null) claims.email_verified = payload.email_verified;
      const token = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(issuer)
        .setAudience(payload.aud || CLIENT_ID)
        .setSubject(payload.sub)
        .setIssuedAt(payload.expired ? now - 600 : now)
        .setExpirationTime(payload.expired ? now - 120 : now + 300)
        .setJti(payload.jti || crypto.randomUUID())
        .sign(payload.sign === 'bad' ? badKey : privateKey);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        access_token: 'access-token',
        token_type: 'Bearer',
        expires_in: 300,
        id_token: token
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  issuer = `http://127.0.0.1:${port}`;
  return {
    issuer,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function codeFor(fields) {
  return Buffer.from(JSON.stringify(fields)).toString('base64url');
}

async function beginOidc(base) {
  const start = await fetch(`${base}/api/auth/oidc/start`, { redirect: 'manual' });
  const failure = start.status === 302 ? '' : await start.text();
  assert.equal(start.status, 302, failure);
  const loc = new URL(start.headers.get('location'));
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(loc.searchParams.get('code_challenge'));
  assert.ok(loc.searchParams.get('state'));
  assert.ok(loc.searchParams.get('nonce'));
  return {
    state: loc.searchParams.get('state'),
    nonce: loc.searchParams.get('nonce'),
    challenge: loc.searchParams.get('code_challenge')
  };
}

async function callbackOidc(base, { state, code, extra = {} }) {
  const url = new URL(`${base}/api/auth/oidc/callback`);
  if (state != null) url.searchParams.set('state', state);
  if (code != null) url.searchParams.set('code', code);
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    redirect: 'manual'
  });
  return readJson(response);
}

async function withOidc(extraEnv, fn) {
  const db = await createMemoryDatabase();
  await seedUsers(db);
  const idp = await startIdp();
  try {
    const app = appFor(db, oidcEnv(idp.issuer, extraEnv));
    await withServer(app, async (base) => {
      await fn({ base, db, issuer: idp.issuer });
    });
  } finally {
    await idp.close();
  }
}

function signXml(xml, elementId, privateKey) {
  const sig = new SignedXml({
    privateKey,
    publicCert: IDP_CERT.cert,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#'
  });
  sig.addReference({
    xpath: `//*[@ID='${elementId}']`,
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/2001/10/xml-exc-c14n#'
    ],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    uri: `#${elementId}`
  });
  sig.computeSignature(xml, {
    location: { reference: `//*[@ID='${elementId}']`, action: 'append' }
  });
  return sig.getSignedXml();
}

function samlResponseXml({
  inResponseTo,
  assertionId,
  nameId = 'alice@example.com',
  email = 'alice@example.com',
  audience = SP_ENTITY,
  recipient = ACS,
  notOnOrAfter,
  notBefore
}) {
  const now = Date.now();
  const issue = new Date(now).toISOString();
  const later = notOnOrAfter || new Date(now + 5 * 60 * 1000).toISOString();
  const before = notBefore || new Date(now - 60 * 1000).toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_resp${assertionId}" Version="2.0" IssueInstant="${issue}" Destination="${recipient}" InResponseTo="${inResponseTo}">
  <saml:Issuer>${IDP_ISSUER}</saml:Issuer>
  <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
  <saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${issue}">
    <saml:Issuer>${IDP_ISSUER}</saml:Issuer>
    <saml:Subject>
      <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameId}</saml:NameID>
      <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
        <saml:SubjectConfirmationData InResponseTo="${inResponseTo}" Recipient="${recipient}" NotOnOrAfter="${later}"/>
      </saml:SubjectConfirmation>
    </saml:Subject>
    <saml:Conditions NotBefore="${before}" NotOnOrAfter="${later}">
      <saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction>
    </saml:Conditions>
    <saml:AttributeStatement>
      <saml:Attribute Name="email"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute>
      <saml:Attribute Name="role"><saml:AttributeValue>admin</saml:AttributeValue></saml:Attribute>
    </saml:AttributeStatement>
  </saml:Assertion>
</samlp:Response>`;
}

async function beginSaml(base, db) {
  const before = await db.prepare(`SELECT id FROM sso_requests WHERE provider = 'saml'`).all();
  const known = new Set(before.map((row) => row.id));
  const start = await fetch(`${base}/api/auth/saml/start`, { redirect: 'manual' });
  const failure = start.status === 302 ? '' : await start.text();
  assert.equal(start.status, 302, failure);
  assert.match(start.headers.get('location') || '', /^https:\/\/idp\.example\/sso\?/);
  const rows = await db.prepare(`SELECT id FROM sso_requests WHERE provider = 'saml'`).all();
  const created = rows.filter((row) => !known.has(row.id));
  assert.equal(created.length, 1);
  return created[0].id;
}

async function postSaml(base, xml) {
  const response = await fetch(`${base}/api/auth/saml/acs`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ SAMLResponse: Buffer.from(xml).toString('base64') }),
    redirect: 'manual'
  });
  return readJson(response);
}

function signedSaml(options, { badSignature = false } = {}) {
  const xml = samlResponseXml(options);
  return signXml(xml, options.assertionId, badSignature ? OTHER_CERT.key : IDP_CERT.key);
}

describe('SSO configuration fails closed', () => {
  test('missing OIDC settings do not mint a session', async () => {
    const db = await createMemoryDatabase();
    await seedUsers(db);
    const app = appFor(db, {
      IDENTITY_PROVIDER: 'oidc',
      APP_BASE_URL: 'https://customer.example'
    });
    await withServer(app, async (base) => {
      const start = await readJson(await fetch(`${base}/api/auth/oidc/start`, {
        headers: { Accept: 'application/json' },
        redirect: 'manual'
      }));
      assert.equal(start.status, 503);
      assert.equal(start.body.code, 'sso_not_configured');
      assert.equal(start.session, null);

      const callback = await callbackOidc(base, { state: 'none', code: 'none' });
      assert.equal(callback.status, 503);
      assert.equal(callback.body.code, 'sso_not_configured');
      assert.equal(callback.session, null);

      const config = await readJson(await fetch(`${base}/api/auth/config`));
      assert.equal(config.body.identityProvider, 'oidc');
      assert.equal(config.body.ssoReady, false);
      assert.equal(config.body.localLogin, true);
    });
  });

  test('an unreachable OIDC issuer fails closed and sets no cookie', async () => {
    const db = await createMemoryDatabase();
    await seedUsers(db);
    const app = appFor(db, oidcEnv('https://idp.invalid'));
    await withServer(app, async (base) => {
      const start = await readJson(await fetch(`${base}/api/auth/oidc/start`, {
        headers: { Accept: 'application/json' },
        redirect: 'manual'
      }));
      assert.equal(start.status, 503);
      assert.equal(start.body.code, 'sso_idp_unavailable');
      assert.equal(start.session, null);
      const event = await db.prepare(`SELECT outcome, reason FROM sso_login_events`).get();
      assert.equal(event.outcome, 'failure');
      assert.equal(event.reason, 'sso_idp_unavailable');
    });
  });

  test('missing SAML settings do not mint a session', async () => {
    const db = await createMemoryDatabase();
    const app = appFor(db, { IDENTITY_PROVIDER: 'saml', APP_BASE_URL: 'https://customer.example' });
    await withServer(app, async (base) => {
      const start = await readJson(await fetch(`${base}/api/auth/saml/start`, {
        headers: { Accept: 'application/json' },
        redirect: 'manual'
      }));
      assert.equal(start.status, 503);
      assert.equal(start.body.code, 'sso_not_configured');
      assert.equal(start.session, null);
      const acs = await postSaml(base, '<xml/>');
      assert.equal(acs.status, 503);
      assert.equal(acs.session, null);
    });
  });

  test('an unknown IDENTITY_PROVIDER does not fall open, and password login still works', async () => {
    const db = await createMemoryDatabase();
    await seedUsers(db);
    const app = appFor(db, { IDENTITY_PROVIDER: 'persona' });
    await withServer(app, async (base) => {
      const start = await readJson(await fetch(`${base}/api/auth/oidc/start`, {
        headers: { Accept: 'application/json' },
        redirect: 'manual'
      }));
      assert.equal(start.status, 503);
      assert.equal(start.session, null);
      const login = await readJson(await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'alice@example.com', password: DEMO_SEED_PASSWORD })
      }));
      assert.equal(login.status, 200, login.body.error);
      assert.equal(login.session.userId, 1);
    });
  });

  test('unsigned signature policy is rejected at config time', () => {
    const config = loadAuthConfig({
      IDENTITY_PROVIDER: 'saml',
      SAML_ENTRY_POINT: 'https://idp.example/sso',
      SAML_IDP_CERT: IDP_CERT.cert,
      SAML_IDP_ISSUER: IDP_ISSUER,
      SAML_SP_ENTITY_ID: SP_ENTITY,
      APP_BASE_URL: 'https://customer.example',
      SAML_WANT_ASSERTIONS_SIGNED: '0',
      SAML_WANT_RESPONSE_SIGNED: '0'
    }, { sessionSecret: 'test-session-secret' });
    assert.equal(config.sso.ready, false);
    assert.ok(config.sso.problems.includes('SAML_SIGNATURE_REQUIRED'));
  });
});

describe('OIDC callback', () => {
  test('mints pf_session for a mapped user and ignores the role claim', async () => {
    await withOidc({}, async ({ base, db }) => {
      const started = await beginOidc(base);
      const result = await callbackOidc(base, {
        state: started.state,
        code: codeFor({
          challenge: started.challenge,
          nonce: started.nonce,
          sub: 'oidc-alice',
          email: 'Alice@example.com',
          email_verified: true,
          name: 'Alice Chen',
          jti: 'jti-alice-1'
        }),
        extra: { role: 'admin' }
      });
      assert.equal(result.status, 200, result.body.error || result.body.code);
      assert.equal(result.body.user.email, 'alice@example.com');
      assert.equal(result.body.user.role, 'requester');
      assert.equal(result.session.userId, 1);
      assert.match(result.header, /HttpOnly/i);
      assert.equal('password_hash' in result.body.user, false);

      const me = await readJson(await fetch(`${base}/api/auth/me`, {
        headers: { Cookie: result.cookie }
      }));
      assert.equal(me.status, 200);
      assert.equal(me.body.user.id, 1);

      const link = await db.prepare(`SELECT user_id, subject FROM user_identities WHERE provider = 'oidc'`).get();
      assert.equal(link.user_id, 1);
      assert.equal(link.subject, 'oidc-alice');
      const events = await db.prepare(`SELECT outcome, user_id FROM sso_login_events`).all();
      assert.equal(events.length, 1);
      assert.equal(events[0].outcome, 'success');
      assert.equal(events[0].user_id, 1);

      const again = await beginOidc(base);
      const linked = await callbackOidc(base, {
        state: again.state,
        code: codeFor({
          challenge: again.challenge,
          nonce: again.nonce,
          sub: 'oidc-alice',
          email: 'someone-else@example.com',
          email_verified: false,
          jti: 'jti-alice-2'
        })
      });
      assert.equal(linked.status, 200, linked.body.code);
      assert.equal(linked.session.userId, 1);
    });
  });

  test('rejects an unknown user when provisioning is off', async () => {
    await withOidc({}, async ({ base, db }) => {
      const started = await beginOidc(base);
      const result = await callbackOidc(base, {
        state: started.state,
        code: codeFor({
          challenge: started.challenge,
          nonce: started.nonce,
          sub: 'oidc-new',
          email: 'new.person@example.com',
          email_verified: true,
          jti: 'jti-new'
        })
      });
      assert.equal(result.status, 403);
      assert.equal(result.body.code, 'sso_user_unknown');
      assert.equal(result.session, null);
      const count = await db.prepare(`SELECT COUNT(*) AS n FROM users`).get();
      assert.equal(Number(count.n), 2);
      const event = await db.prepare(`SELECT outcome, reason FROM sso_login_events`).get();
      assert.equal(event.outcome, 'failure');
      assert.equal(event.reason, 'sso_user_unknown');
    });
  });

  test('rejects an unverified email even when the address matches a user', async () => {
    await withOidc({}, async ({ base, db }) => {
      const started = await beginOidc(base);
      const result = await callbackOidc(base, {
        state: started.state,
        code: codeFor({
          challenge: started.challenge,
          nonce: started.nonce,
          sub: 'oidc-unverified',
          email: 'alice@example.com',
          email_verified: false,
          jti: 'jti-unverified'
        })
      });
      assert.equal(result.status, 401);
      assert.equal(result.body.code, 'sso_email_unverified');
      assert.equal(result.session, null);
      const links = await db.prepare(`SELECT COUNT(*) AS n FROM user_identities`).get();
      assert.equal(Number(links.n), 0);
    });
  });

  test('rejects a bad state, nonce, signature, audience, expiry, and PKCE verifier', async () => {
    await withOidc({}, async ({ base, db }) => {
      const badState = await beginOidc(base);
      const stateResult = await callbackOidc(base, {
        state: 'not-the-issued-state',
        code: codeFor({
          challenge: badState.challenge,
          nonce: badState.nonce,
          sub: 'oidc-alice',
          email: 'alice@example.com',
          email_verified: true
        })
      });
      assert.equal(stateResult.status, 401);
      assert.equal(stateResult.body.code, 'sso_state_invalid');
      assert.equal(stateResult.session, null);

      const badNonce = await beginOidc(base);
      const nonceResult = await callbackOidc(base, {
        state: badNonce.state,
        code: codeFor({
          challenge: badNonce.challenge,
          nonce: 'wrong-nonce',
          sub: 'oidc-alice',
          email: 'alice@example.com',
          email_verified: true,
          jti: 'jti-nonce'
        })
      });
      assert.equal(nonceResult.status, 401);
      assert.equal(nonceResult.body.code, 'sso_nonce_invalid');
      assert.equal(nonceResult.session, null);

      const badSig = await beginOidc(base);
      const sigResult = await callbackOidc(base, {
        state: badSig.state,
        code: codeFor({
          challenge: badSig.challenge,
          nonce: badSig.nonce,
          sub: 'oidc-alice',
          email: 'alice@example.com',
          email_verified: true,
          sign: 'bad',
          jti: 'jti-sig'
        })
      });
      assert.equal(sigResult.status, 401);
      assert.equal(sigResult.body.code, 'sso_signature_invalid');
      assert.equal(sigResult.session, null);

      const badAud = await beginOidc(base);
      const audResult = await callbackOidc(base, {
        state: badAud.state,
        code: codeFor({
          challenge: badAud.challenge,
          nonce: badAud.nonce,
          sub: 'oidc-alice',
          email: 'alice@example.com',
          email_verified: true,
          aud: 'other-client',
          jti: 'jti-aud'
        })
      });
      assert.equal(audResult.status, 401);
      assert.equal(audResult.body.code, 'sso_audience_invalid');
      assert.equal(audResult.session, null);

      const expired = await beginOidc(base);
      const expResult = await callbackOidc(base, {
        state: expired.state,
        code: codeFor({
          challenge: expired.challenge,
          nonce: expired.nonce,
          sub: 'oidc-alice',
          email: 'alice@example.com',
          email_verified: true,
          expired: true,
          jti: 'jti-exp'
        })
      });
      assert.equal(expResult.status, 401);
      assert.equal(expResult.body.code, 'sso_expired');
      assert.equal(expResult.session, null);

      const pkce = await beginOidc(base);
      const row = await db.prepare(`SELECT payload FROM sso_requests WHERE id = ?`).get(pkce.state);
      const payload = JSON.parse(row.payload);
      payload.codeVerifier = 'b'.repeat(48);
      await db.prepare(`UPDATE sso_requests SET payload = ? WHERE id = ?`).run(JSON.stringify(payload), pkce.state);
      const pkceResult = await callbackOidc(base, {
        state: pkce.state,
        code: codeFor({
          challenge: pkce.challenge,
          nonce: pkce.nonce,
          sub: 'oidc-alice',
          email: 'alice@example.com',
          email_verified: true,
          jti: 'jti-pkce'
        })
      });
      assert.equal(pkceResult.status, 401);
      assert.equal(pkceResult.body.code, 'sso_pkce_invalid');
      assert.equal(pkceResult.session, null);
    });
  });

  test('rejects a replayed jti', async () => {
    await withOidc({}, async ({ base }) => {
      const first = await beginOidc(base);
      const ok = await callbackOidc(base, {
        state: first.state,
        code: codeFor({
          challenge: first.challenge,
          nonce: first.nonce,
          sub: 'oidc-alice',
          email: 'alice@example.com',
          email_verified: true,
          jti: 'jti-replayed'
        })
      });
      assert.equal(ok.status, 200, ok.body.code);
      const second = await beginOidc(base);
      const replay = await callbackOidc(base, {
        state: second.state,
        code: codeFor({
          challenge: second.challenge,
          nonce: second.nonce,
          sub: 'oidc-alice',
          email: 'alice@example.com',
          email_verified: true,
          jti: 'jti-replayed'
        })
      });
      assert.equal(replay.status, 401);
      assert.equal(replay.body.code, 'sso_replay');
      assert.equal(replay.session, null);
    });
  });

  test('just-in-time provisioning uses the default requester role, not the claim', async () => {
    await withOidc({}, async ({ base, db }) => {
      await db.prepare(`UPDATE tenant_settings SET sso_provisioning = 1, sso_default_role = 'requester'`).run();
      const started = await beginOidc(base);
      const result = await callbackOidc(base, {
        state: started.state,
        code: codeFor({
          challenge: started.challenge,
          nonce: started.nonce,
          sub: 'oidc-jit',
          email: 'new.person@example.com',
          email_verified: true,
          name: 'New Person',
          jti: 'jti-jit'
        }),
        extra: { role: 'admin' }
      });
      assert.equal(result.status, 200, result.body.code);
      assert.equal(result.body.user.role, 'requester');
      assert.equal(result.body.user.email, 'new.person@example.com');
      assert.equal(result.body.user.has_password, 0);
      assert.equal(result.session.userId, result.body.user.id);
      const stored = await db.prepare(`SELECT role FROM users WHERE email = ?`).get('new.person@example.com');
      assert.equal(stored.role, 'requester');
    });
  });

  test('a bad default role fails closed instead of provisioning', async () => {
    await withOidc({ SSO_PROVISIONING: '1', SSO_DEFAULT_ROLE: 'superuser' }, async ({ base, db }) => {
      const started = await beginOidc(base);
      const result = await callbackOidc(base, {
        state: started.state,
        code: codeFor({
          challenge: started.challenge,
          nonce: started.nonce,
          sub: 'oidc-bad-role',
          email: 'bad.role@example.com',
          email_verified: true,
          jti: 'jti-bad-role'
        })
      });
      assert.equal(result.status, 503);
      assert.equal(result.body.code, 'sso_provisioning_misconfigured');
      assert.equal(result.session, null);
      const row = await db.prepare(`SELECT id FROM users WHERE email = ?`).get('bad.role@example.com');
      assert.equal(row, undefined);
    });
  });

  test('password login still works, and Sprint 1 still rejects a missing session', async () => {
    await withOidc({}, async ({ base }) => {
      const login = await readJson(await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'elena@example.com', password: DEMO_SEED_PASSWORD })
      }));
      assert.equal(login.status, 200, login.body.error);
      assert.equal(login.body.user.role, 'admin');
      assert.equal(login.session.userId, 5);

      const users = await readJson(await fetch(`${base}/api/users`));
      assert.equal(users.status, 401);
      const health = await readJson(await fetch(`${base}/api/health`));
      assert.equal(health.status, 200);
    });

    const db = await createMemoryDatabase();
    await seedUsers(db);
    const app = appFor(db, oidcEnv('http://127.0.0.1:9', {
      LOCAL_LOGIN: '0',
      OIDC_ISSUER: 'https://idp.example',
      OIDC_ALLOW_INSECURE: '0'
    }));
    await withServer(app, async (base) => {
      const login = await readJson(await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'alice@example.com', password: DEMO_SEED_PASSWORD })
      }));
      assert.equal(login.status, 403);
      assert.equal(login.body.code, 'local_login_disabled');
      assert.equal(login.session, null);
      const users = await readJson(await fetch(`${base}/api/users`));
      assert.equal(users.status, 401);
    });
  });

  test('only an admin can enable provisioning, and a body role is ignored', async () => {
    await withOidc({}, async ({ base, db }) => {
      const anon = await readJson(await fetch(`${base}/api/auth/sso-settings`, { method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sso_provisioning: true, role: 'admin' })
      }));
      assert.equal(anon.status, 401);

      const alice = await readJson(await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'alice@example.com', password: DEMO_SEED_PASSWORD })
      }));
      const denied = await readJson(await fetch(`${base}/api/auth/sso-settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: alice.cookie },
        body: JSON.stringify({ sso_provisioning: true, role: 'admin' })
      }));
      assert.equal(denied.status, 403);

      const elena = await readJson(await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'elena@example.com', password: DEMO_SEED_PASSWORD })
      }));
      const saved = await readJson(await fetch(`${base}/api/auth/sso-settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: elena.cookie },
        body: JSON.stringify({ sso_provisioning: true, role: 'admin' })
      }));
      assert.equal(saved.status, 200, saved.body.error);
      assert.equal(saved.body.provisioning, true);
      assert.equal(saved.body.defaultRole, 'requester');
      const row = await db.prepare(`SELECT sso_default_role FROM tenant_settings WHERE id = 1`).get();
      assert.equal(row.sso_default_role, 'requester');
    });
  });
});

describe('SAML callback', () => {
  test('mints pf_session for a mapped user and ignores the role attribute', async () => {
    const db = await createMemoryDatabase();
    await seedUsers(db);
    const app = appFor(db, samlEnv());
    await withServer(app, async (base) => {
      const requestId = await beginSaml(base, db);
      const assertionId = `_assert${crypto.randomBytes(6).toString('hex')}`;
      const result = await postSaml(base, signedSaml({
        inResponseTo: requestId,
        assertionId,
        nameId: 'alice@example.com',
        email: 'alice@example.com'
      }));
      assert.equal(result.status, 200, `${result.body.code || ''} ${result.body.error || ''} ${result.body.raw || ''}`);
      assert.equal(result.body.user.role, 'requester');
      assert.equal(result.session.userId, 1);
      const me = await readJson(await fetch(`${base}/api/auth/me`, { headers: { Cookie: result.cookie } }));
      assert.equal(me.status, 200);
      assert.equal(me.body.user.email, 'alice@example.com');
      const stored = await db.prepare(`SELECT role FROM users WHERE id = 1`).get();
      assert.equal(stored.role, 'requester');
      const event = await db.prepare(`SELECT outcome FROM sso_login_events`).get();
      assert.equal(event.outcome, 'success');

      const meta = await fetch(`${base}/api/auth/saml/metadata`);
      assert.equal(meta.status, 200);
      const xml = await meta.text();
      assert.match(xml, /EntityDescriptor/);
      assert.match(xml, /customer\.example\/saml/);
    });
  });

  test('rejects an unknown user when provisioning is off', async () => {
    const db = await createMemoryDatabase();
    await seedUsers(db);
    const app = appFor(db, samlEnv());
    await withServer(app, async (base) => {
      const requestId = await beginSaml(base, db);
      const result = await postSaml(base, signedSaml({
        inResponseTo: requestId,
        assertionId: `_unknown${crypto.randomBytes(4).toString('hex')}`,
        nameId: 'nobody@example.com',
        email: 'nobody@example.com'
      }));
      assert.equal(result.status, 403);
      assert.equal(result.body.code, 'sso_user_unknown');
      assert.equal(result.session, null);
    });
  });

  test('rejects a bad signature, audience, recipient, expiry, and replayed assertion', async () => {
    const db = await createMemoryDatabase();
    await seedUsers(db);
    const app = appFor(db, samlEnv());
    await withServer(app, async (base) => {
      const sigRequest = await beginSaml(base, db);
      const sig = await postSaml(base, signedSaml({
        inResponseTo: sigRequest,
        assertionId: `_sig${crypto.randomBytes(4).toString('hex')}`
      }, { badSignature: true }));
      assert.equal(sig.status, 401);
      assert.equal(sig.body.code, 'sso_signature_invalid');
      assert.equal(sig.session, null);

      const audRequest = await beginSaml(base, db);
      const aud = await postSaml(base, signedSaml({
        inResponseTo: audRequest,
        assertionId: `_aud${crypto.randomBytes(4).toString('hex')}`,
        audience: 'https://evil.example/saml'
      }));
      assert.equal(aud.status, 401);
      assert.equal(aud.body.code, 'sso_audience_invalid');
      assert.equal(aud.session, null);

      const recipientRequest = await beginSaml(base, db);
      const recipient = await postSaml(base, signedSaml({
        inResponseTo: recipientRequest,
        assertionId: `_rec${crypto.randomBytes(4).toString('hex')}`,
        recipient: 'https://evil.example/acs'
      }));
      assert.equal(recipient.status, 401);
      assert.equal(recipient.body.code, 'sso_recipient_invalid');
      assert.equal(recipient.session, null);

      const expiredRequest = await beginSaml(base, db);
      const past = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const earlier = new Date(Date.now() - 20 * 60 * 1000).toISOString();
      const expired = await postSaml(base, signedSaml({
        inResponseTo: expiredRequest,
        assertionId: `_exp${crypto.randomBytes(4).toString('hex')}`,
        notOnOrAfter: past,
        notBefore: earlier
      }));
      assert.equal(expired.status, 401);
      assert.equal(expired.body.code, 'sso_expired');
      assert.equal(expired.session, null);

      const assertionId = `_replay${crypto.randomBytes(4).toString('hex')}`;
      const firstRequest = await beginSaml(base, db);
      const first = await postSaml(base, signedSaml({ inResponseTo: firstRequest, assertionId }));
      assert.equal(first.status, 200, first.body.code || first.body.raw);
      const secondRequest = await beginSaml(base, db);
      const replay = await postSaml(base, signedSaml({ inResponseTo: secondRequest, assertionId }));
      assert.equal(replay.status, 401);
      assert.equal(replay.body.code, 'sso_replay');
      assert.equal(replay.session, null);

      const users = await readJson(await fetch(`${base}/api/users`));
      assert.equal(users.status, 401);
    });
  });
});
