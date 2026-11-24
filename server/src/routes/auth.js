import express from 'express';
import {
  clearSessionCookie,
  issueSessionCookie,
  loadAuthConfig
} from '../auth.js';
import {
  UsersError,
  authenticateUser,
  bootstrapFirstAdmin,
  changeOwnPassword,
  countUsers
} from '../usersService.js';
import { MasterDataError } from '../masterData.js';
import {
  appendComplianceEvent,
  recordBootstrapAdmin,
  recordLocalLoginFailure,
  recordLocalLoginSuccess,
  recordLogout,
  recordUserChange
} from '../complianceAudit.js';
import { bootstrapHttpRefusal } from '../bootstrapToken.js';
import { clearSuccessfulLoginAccount } from '../loginRateLimit.js';
import ssoRouter from './sso.js';

const router = express.Router();

function sendError(res, error) {
  const status = error.statusCode
    || (error instanceof UsersError || error instanceof MasterDataError ? error.statusCode : 500);
  if (status >= 500) console.error(error);
  res.status(status).json({ error: error.message });
}

function authConfig(req) {
  return req.authConfig || loadAuthConfig();
}

function setSessionCookie(req, res, user) {
  issueSessionCookie(res, authConfig(req), user);
}

router.get('/config', async (req, res) => {
  try {
    const config = authConfig(req);
    const userCount = await countUsers(req.db);
    res.json({
      auth: 'session',
      identityProvider: config.identityProvider || 'local',
      ssoReady: Boolean(config.sso?.ready),
      localLogin: config.localLogin !== false,
      demoPersonaSwitcher: Boolean(config.demoPersonaSwitcher),
      bootstrapNeeded: userCount === 0,
      currency: req.currency
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/me', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required', user: null });
    }
    res.json({ user: req.user });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  try {
    if (authConfig(req).localLogin === false) {
      const presented = String(email || '').trim().toLowerCase() || 'unknown';
      await appendComplianceEvent(req.db, {
        actor_user_id: null,
        actor_name: presented,
        actor_role: null,
        action: 'LOCAL_LOGIN_DISABLED',
        entity_type: 'user',
        entity_id: null,
        details: 'local_login_disabled'
      });
      return res.status(403).json({
        error: 'Password sign-in is disabled for this customer',
        code: 'local_login_disabled'
      });
    }
    const user = await authenticateUser(req.db, email, password, {
      env: req.authEnv || process.env
    });
    await recordLocalLoginSuccess(req.db, user);
    setSessionCookie(req, res, user);
    // The limiter already counted this request. Drop the account window now,
    // before the body is sent, so the next attempt on this or another instance
    // starts clean. A failure here must not turn a good password into a 500.
    await clearSuccessfulLoginAccount(req);
    res.json({ user });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status === 401 || status === 403) {
      try {
        await recordLocalLoginFailure(req.db, email, error);
      } catch (auditError) {
        return sendError(res, auditError);
      }
    }
    sendError(res, error);
  }
});

router.post('/logout', async (req, res) => {
  try {
    if (req.user) await recordLogout(req.db, req.user);
    clearSessionCookie(res, authConfig(req));
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/bootstrap', async (req, res) => {
  try {
    // Users already present: same refusal as before, with or without a token.
    // Existing deployments do not set BOOTSTRAP_TOKEN and must stay on 409.
    const existing = await countUsers(req.db);
    if (existing > 0) {
      return res.status(409).json({
        error: 'This tenant already has users. Sign in as an admin to create more.'
      });
    }
    const env = req.authEnv || process.env;
    const refusal = bootstrapHttpRefusal(env, req.get('x-bootstrap-token'));
    if (refusal) {
      return res.status(refusal.statusCode).json(refusal.body);
    }
    const config = authConfig(req);
    const user = await bootstrapFirstAdmin(req.db, req.body || {}, {
      bcryptRounds: config.bcryptRounds,
      env
    });
    await recordBootstrapAdmin(req.db, user);
    setSessionCookie(req, res, user);
    res.status(201).json({ user });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/password', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required', user: null });
    }
    const body = req.body || {};
    const user = await changeOwnPassword(
      req.db,
      req.user.id,
      body.current_password,
      body.new_password,
      { bcryptRounds: authConfig(req).bcryptRounds, env: req.authEnv || process.env }
    );
    await recordUserChange(req.db, req.user, {
      action: 'USER_PASSWORD_SET',
      user,
      details: { password: 'redacted', self: true }
    });
    setSessionCookie(req, res, user);
    res.json({ user });
  } catch (error) {
    sendError(res, error);
  }
});

router.use(ssoRouter);

export default router;
