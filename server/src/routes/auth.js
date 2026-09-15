import express from 'express';
import {
  loadAuthConfig,
  sessionCookieHeader,
  signSessionToken
} from '../auth.js';
import {
  UsersError,
  authenticateUser,
  bootstrapFirstAdmin,
  countUsers
} from '../usersService.js';
import { MasterDataError } from '../masterData.js';

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
  const config = authConfig(req);
  const token = signSessionToken(userId, config.sessionSecret, Date.now(), config.sessionTtlSeconds);
  res.setHeader('Set-Cookie', sessionCookieHeader(token, {
    ttlSeconds: config.sessionTtlSeconds,
    secure: config.cookieSecure
  }));
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

export default router;
