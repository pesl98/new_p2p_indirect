import express from 'express';
import { attachSessionCookie, requireAdmin } from '../auth.js';
import { finishOidcLogin, startOidcLogin } from '../oidc.js';
import { finishSamlLogin, samlMetadataXml, startSamlLogin } from '../saml.js';
import { SsoError, classifyProviderError, getSsoPolicy, updateSsoSettings } from '../sso.js';
import { recordSsoSettingsChange } from '../complianceAudit.js';
import { UsersError } from '../usersService.js';

const router = express.Router();

function ssoConfig(req) {
  return req.authConfig?.sso || null;
}

function authSettings(req) {
  return req.authConfig;
}

function wantsJson(req) {
  return String(req.headers.accept || '').includes('application/json');
}

function sendFailure(req, res, error) {
  const ssoError = error instanceof SsoError ? error : classifyProviderError(error);
  if (!(error instanceof SsoError)) console.error(error);
  else if (ssoError.statusCode >= 500) console.error(error);
  const base = ssoConfig(req)?.appBaseUrl || ssoConfig(req)?.oidc?.appBaseUrl || ssoConfig(req)?.saml?.appBaseUrl;
  res.setHeader('Cache-Control', 'no-store');
  if (wantsJson(req) || !base) {
    return res.status(ssoError.statusCode).json({ error: ssoError.message, code: ssoError.code });
  }
  const url = new URL('/', base);
  url.searchParams.set('sso_error', ssoError.code);
  return res.redirect(302, url.toString());
}

function sendSuccess(req, res, user) {
  const config = authSettings(req);
  attachSessionCookie(res, config, user.id);
  res.setHeader('Cache-Control', 'no-store');
  const base = ssoConfig(req)?.appBaseUrl || ssoConfig(req)?.oidc?.appBaseUrl || ssoConfig(req)?.saml?.appBaseUrl;
  if (wantsJson(req) || !base) return res.json({ user });
  return res.redirect(302, new URL('/', base).toString());
}

router.get('/oidc/start', async (req, res) => {
  try {
    const url = await startOidcLogin(req.db, ssoConfig(req));
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, url);
  } catch (error) {
    return sendFailure(req, res, error);
  }
});

router.get('/oidc/callback', async (req, res) => {
  try {
    const user = await finishOidcLogin(req.db, ssoConfig(req), req.query || {});
    return sendSuccess(req, res, user);
  } catch (error) {
    return sendFailure(req, res, error);
  }
});

router.get('/saml/start', async (req, res) => {
  try {
    const url = await startSamlLogin(req.db, ssoConfig(req));
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, url);
  } catch (error) {
    return sendFailure(req, res, error);
  }
});

router.post('/saml/acs', async (req, res) => {
  try {
    const user = await finishSamlLogin(req.db, ssoConfig(req), req.body || {});
    return sendSuccess(req, res, user);
  } catch (error) {
    return sendFailure(req, res, error);
  }
});

router.get('/saml/metadata', (req, res) => {
  try {
    const xml = samlMetadataXml(req.db, ssoConfig(req));
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/xml');
    return res.send(xml);
  } catch (error) {
    return sendFailure(req, res, error);
  }
});

router.get('/sso-settings', requireAdmin, async (req, res) => {
  try {
    const sso = ssoConfig(req);
    const policy = await getSsoPolicy(req.db, sso);
    res.json({
      identityProvider: sso?.identityProvider || 'local',
      ssoReady: Boolean(sso?.ready),
      problems: sso?.problems || [],
      provisioning: policy.settingsProvisioning,
      provisioningFromEnv: policy.fromEnv,
      defaultRole: policy.settingsRole,
      effectiveProvisioning: policy.provisioning,
      effectiveDefaultRole: policy.defaultRole
    });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ error: error.message });
  }
});

router.put('/sso-settings', requireAdmin, async (req, res) => {
  try {
    const saved = await updateSsoSettings(req.db, req.body || {});
    await recordSsoSettingsChange(req.db, req.user, saved);
    const policy = await getSsoPolicy(req.db, ssoConfig(req));
    res.json({
      provisioning: Number(saved.sso_provisioning) === 1,
      defaultRole: saved.sso_default_role,
      effectiveProvisioning: policy.provisioning,
      effectiveDefaultRole: policy.defaultRole
    });
  } catch (error) {
    const status = error.statusCode
      || (error instanceof UsersError || error instanceof SsoError ? 400 : 500);
    if (status >= 500) console.error(error);
    res.status(status).json({ error: error.message });
  }
});

export default router;
