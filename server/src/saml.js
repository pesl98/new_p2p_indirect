/**
 * SAML 2.0 SP-initiated login.
 *
 * @node-saml/node-saml checks the signature, audience, NotOnOrAfter, and
 * InResponseTo (replay of the AuthnRequest). Recipient is checked here
 * because the library does not. A second use of the same assertion ID is
 * rejected in sso.js.
 */

import { SAML, ValidateInResponseTo } from '@node-saml/node-saml';
import {
  SsoError,
  SSO_REQUEST_TTL_SECONDS,
  classifyProviderError,
  completeSsoLogin,
  recordProviderFailure,
  samlRequestCache
} from './sso.js';

const EMAIL_ATTRIBUTES = [
  'email',
  'mail',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'urn:oid:0.9.2342.19200300.100.1.3'
];

const NAME_ATTRIBUTES = [
  'displayName',
  'name',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'
];

export async function startSamlLogin(db, sso) {
  assertSamlReady(sso);
  const saml = createSaml(sso.saml, db);
  return saml.getAuthorizeUrlAsync('', undefined, {});
}

export async function finishSamlLogin(db, sso, body) {
  assertSamlReady(sso);
  const samlResponse = typeof body?.SAMLResponse === 'string' ? body.SAMLResponse.trim() : '';
  if (!samlResponse) {
    const error = new SsoError('sso_token_invalid');
    await recordProviderFailure(db, 'saml', error);
    throw error;
  }

  const saml = createSaml(sso.saml, db);
  let result;
  try {
    result = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse });
  } catch (error) {
    const wrapped = classifyProviderError(error);
    await recordProviderFailure(db, 'saml', wrapped);
    throw wrapped;
  }

  const profile = result?.profile;
  if (!profile || result.loggedOut) {
    const error = new SsoError('sso_token_invalid');
    await recordProviderFailure(db, 'saml', error);
    throw error;
  }

  let checked;
  try {
    checked = assertSamlProfile(profile, sso.saml);
  } catch (error) {
    const wrapped = error instanceof SsoError ? error : classifyProviderError(error);
    await recordProviderFailure(db, 'saml', wrapped, {
      subject: typeof profile.nameID === 'string' ? profile.nameID : null
    });
    throw wrapped;
  }

  return completeSsoLogin(db, sso, {
    provider: 'saml',
    subject: checked.subject,
    email: checked.email,
    emailVerified: Boolean(checked.email),
    name: checked.name,
    assertionId: checked.assertionId
  });
}

export function samlMetadataXml(db, sso) {
  assertSamlReady(sso);
  return createSaml(sso.saml, db).generateServiceProviderMetadata(null, null);
}

function assertSamlReady(sso) {
  if (!sso || sso.identityProvider !== 'saml' || !sso.ready || !sso.saml) {
    throw new SsoError('sso_not_configured', 503);
  }
}

function createSaml(samlConfig, db) {
  return new SAML({
    issuer: samlConfig.spEntityId,
    audience: samlConfig.audience,
    callbackUrl: samlConfig.acsUrl,
    entryPoint: samlConfig.entryPoint,
    idpCert: samlConfig.idpCert,
    idpIssuer: samlConfig.idpIssuer,
    identifierFormat: null,
    wantAssertionsSigned: samlConfig.wantAssertionsSigned,
    wantAuthnResponseSigned: samlConfig.wantResponseSigned,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: SSO_REQUEST_TTL_SECONDS * 1000,
    cacheProvider: samlRequestCache(db),
    disableRequestedAuthnContext: true,
    signatureAlgorithm: 'sha256',
    acceptedClockSkewMs: 120000,
    authnRequestBinding: 'HTTP-Redirect'
  });
}

export function assertSamlProfile(profile, samlConfig) {
  const assertion = profile.getAssertion?.()?.Assertion;
  if (!assertion) throw new SsoError('sso_token_invalid');

  const assertionId = String(assertion.$?.ID || '').trim();
  if (!assertionId) throw new SsoError('sso_token_invalid');

  const subject = typeof profile.nameID === 'string' ? profile.nameID.trim() : '';
  if (!subject) throw new SsoError('sso_token_invalid');

  if (String(profile.issuer || '') !== samlConfig.idpIssuer) {
    throw new SsoError('sso_token_invalid');
  }

  const confirmations = assertion.Subject?.[0]?.SubjectConfirmation || [];
  let recipientOk = false;
  let notOnOrAfter = '';
  for (const confirmation of confirmations) {
    const data = confirmation?.SubjectConfirmationData?.[0]?.$;
    if (!data) continue;
    if (data.Recipient === samlConfig.acsUrl) {
      recipientOk = true;
      if (data.NotOnOrAfter) notOnOrAfter = String(data.NotOnOrAfter);
    }
  }
  if (!recipientOk) throw new SsoError('sso_recipient_invalid');
  if (!notOnOrAfter && assertion.Conditions?.[0]?.$?.NotOnOrAfter) {
    notOnOrAfter = String(assertion.Conditions[0].$.NotOnOrAfter);
  }
  if (!notOnOrAfter) throw new SsoError('sso_expired');

  return {
    assertionId,
    subject,
    email: samlEmail(profile),
    name: firstString(profile, NAME_ATTRIBUTES)
  };
}

function samlEmail(profile) {
  const fromAttribute = firstString(profile, EMAIL_ATTRIBUTES);
  if (fromAttribute.includes('@')) return fromAttribute;
  const format = String(profile.nameIDFormat || '');
  const nameId = typeof profile.nameID === 'string' ? profile.nameID.trim() : '';
  if (format === 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' && nameId.includes('@')) {
    return nameId;
  }
  return null;
}

function firstString(profile, names) {
  for (const name of names) {
    const value = profile?.[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}
