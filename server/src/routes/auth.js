import express from 'express';
import {
  attachSessionCookie,
  loadAuthConfig,
  sessionCookieHeader
} from '../auth.js';
import {
  UsersError,
  authenticateUser,
  bootstrapFirstAdmin,
  countUsers
} from '../usersService.js';
import { MasterDataError } from '../masterData.js';
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

function setSessionCookie(req, res, userId) {
  attachSessionCookie(res, authConfig(req), userId);
}

function clearSessionCookie(req, res) {
  const config = authConfig(req);
  res.setHeader('Set-Cookie', sessionCookieHeader('', {
    secure: config.cookieSecure,
    clear: true
  }));
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
      bootstrapNeeded: userCount === 0
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
  try {
    if (authConfig(req).localLogin === false) {
      return res.status(403).json({
        error: 'Password sign-in is disabled for this customer',
        code: 'local_login_disabled'
      });
    }
    const { email, password } = req.body || {};
    const user = await authenticateUser(req.db, email, password);
    setSessionCookie(req, res, user.id);
    res.json({ user });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/logout', async (req, res) => {
  try {
    clearSessionCookie(req, res);
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/bootstrap', async (req, res) => {
  try {
    const config = authConfig(req);
    const user = await bootstrapFirstAdmin(req.db, req.body || {}, {
      bcryptRounds: config.bcryptRounds
    });
    setSessionCookie(req, res, user.id);
    res.status(201).json({ user });
  } catch (error) {
    sendError(res, error);
  }
});

router.use(ssoRouter);

export default router;
