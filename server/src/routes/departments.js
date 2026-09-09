import express from 'express';
import {
  DepartmentAdminError,
  listDepartments,
  listEligibleApprovers,
  loadDepartment,
  setDepartmentApprover
} from '../departmentsService.js';
import { MasterDataError } from '../masterData.js';

const router = express.Router();

function sendError(res, error) {
  const status = error.statusCode
    || (error instanceof DepartmentAdminError || error instanceof MasterDataError
      ? error.statusCode
      : 500);
  if (status >= 500) console.error(error);
  res.status(status).json({ error: error.message });
}

// Canonical department list with mapped step-1 approver (demo-open, like master-data).
router.get('/', async (req, res) => {
  try {
    res.json(await listDepartments(req.db));
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/eligible-approvers', async (req, res) => {
  try {
    res.json(await listEligibleApprovers(req.db));
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/:id', async (req, res) => {
  try {
    res.json(await loadDepartment(req.db, req.params.id));
  } catch (error) {
    sendError(res, error);
  }
});

router.put('/:id/approver', async (req, res) => {
  try {
    const updated = await setDepartmentApprover(req.db, req.params.id, req.body || {});
    res.json(updated);
  } catch (error) {
    sendError(res, error);
  }
});

// PATCH only maintains approver_user_id (no department name/code CRUD).
router.patch('/:id', async (req, res) => {
  try {
    const updated = await setDepartmentApprover(req.db, req.params.id, req.body || {});
    res.json(updated);
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
