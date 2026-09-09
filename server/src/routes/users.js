import express from 'express';
import { listDepartments } from '../departmentsService.js';

const router = express.Router();

// List all users (with department details)
router.get('/', async (req, res) => {
  try {
    const db = req.db;
    const users = await db.prepare(`
      SELECT u.*, d.name as department_name, d.code as department_code
      FROM users u
      LEFT JOIN departments d ON u.department_id = d.id
      ORDER BY u.id ASC
    `).all();
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List departments with budget summary and mapped step-1 approver
router.get('/departments', async (req, res) => {
  try {
    res.json(await listDepartments(req.db));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
