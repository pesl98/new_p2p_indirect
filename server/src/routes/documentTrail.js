import express from 'express';
import db from '../db.js';
import { DocumentTrailError, getDocumentTrail, searchDocumentTrails } from '../documentTrailService.js';

const router = express.Router();

function httpError(res, error) {
  const status = error.statusCode || (error instanceof DocumentTrailError ? error.statusCode : 500);
  if (status >= 500) console.error(error);
  return res.status(status).json({ error: error.message });
}

// Picker / typeahead: PRs, POs, and invoice numbers
router.get('/search', (req, res) => {
  try {
    res.json(searchDocumentTrails(db, req.query.q || ''));
  } catch (error) {
    httpError(res, error);
  }
});

// Chronological document trail for a PR / PO / invoice number
router.get('/', (req, res) => {
  try {
    res.json(getDocumentTrail(db, req.query));
  } catch (error) {
    httpError(res, error);
  }
});

export default router;
