import express from 'express';
import { listDepartments } from '../departmentsService.js';
import { requireAdmin } from '../auth.js';
import {
  UsersError,
  createUser,
  listUsers,
  loadUser,
  setUserPassword,
  setUserStatus,
  updateUser
} from '../usersService.js';
import { MasterDataError } from '../masterData.js';
import { loadAuthConfig } from '../auth.js';

const router = express.Router();

function sendError(res, error) {
  const status = error.statusCode
    || (error instanceof UsersError || error instanceof MasterDataError ? error.statusCode : 500);
  if (status >= 500) console.error(error);
  res.status(status).json({ error: error.message });
}

function bcryptRounds(req) {
  return (req.authConfig || loadAuthConfig()).bcryptRounds;
}

// List all users (with department details). GET stays demo-open so the
// optional persona switcher can load people without a session. Mutating
// routes require a logged-in admin (req.user) — see docs/ARCHITECTURE.md.
router.get('/', async (req, res) => {
  try {
    const users = await listUsers(req.db, { status: req.query.status });
    res.json(users);
  } catch (error) {
    sendError(res, error);
  }
});

// List departments with budget summary and mapped step-1 approver
router.get('/departments', async (req, res) => {
  try {
    res.json(await listDepartments(req.db));
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/:id', async (req, res) => {
  try {
    res.json(await loadUser(req.db, req.params.id));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const created = await createUser(req.db, req.body || {}, { bcryptRounds: bcryptRounds(req) });
    res.status(201).json(created);
  } catch (error) {
    sendError(res, error);
  }
});

router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const updated = await updateUser(req.db, req.params.id, req.body || {}, req.user);
    res.json(updated);
  } catch (error) {
    sendError(res, error);
  }
});

router.patch('/:id/status', requireAdmin, async (req, res) => {
  try {
    const updated = await setUserStatus(req.db, req.params.id, req.body?.status, req.user);
    res.json(updated);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/:id/password', requireAdmin, async (req, res) => {
  try {
    const updated = await setUserPassword(req.db, req.params.id, req.body?.password, {
      bcryptRounds: bcryptRounds(req)
    });
    res.json({ ok: true, user: updated });
  } catch (error) {
    sendError(res, error);
  }
});

router.delete('/:id', requireAdmin, async (_req, res) => {
  res.status(405).json({ error: 'Hard delete is not allowed. Soft-deactivate the user instead.' });
});

export default router;
