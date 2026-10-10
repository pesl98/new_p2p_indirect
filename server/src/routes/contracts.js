import express from 'express';
import {
  listContracts,
  getContractDetail,
  createContract,
  createRenewalRequisition,
  ContractError
} from '../contractsService.js';
import { matchContractForLines } from '../contractAssignment.js';
import { withSessionActor, PROCUREMENT_ROLES, requireRole } from '../requestActor.js';

const router = express.Router();

function httpStatus(error) {
  if (error instanceof ContractError) return error.statusCode || 400;
  if (error.statusCode) return error.statusCode;
  return 500;
}

router.get('/', async (req, res) => {
  try {
    const { category, status, search, today } = req.query;
    const contracts = await listContracts(req.db, { category, status, search, today });
    res.json(contracts);
  } catch (error) {
    res.status(httpStatus(error)).json({ error: error.message });
  }
});

router.post('/match-preview', async (req, res) => {
  try {
    const { items, today } = req.body || {};
    const match = await matchContractForLines(req.db, items || [], { today });
    if (!match) {
      return res.json({ match: null, source_contract_id: null });
    }
    res.json({
      match: {
        id: match.id,
        contract_number: match.contract_number,
        title: match.title,
        supplier_id: match.supplier_id,
        supplier_name: match.supplier_name,
        category: match.category,
        start_date: match.start_date,
        end_date: match.end_date,
        annual_value_cents: match.annual_value_cents,
        status: match.status,
        score: match.score,
        reasons: match.reasons
      },
      source_contract_id: match.id
    });
  } catch (error) {
    res.status(httpStatus(error)).json({ error: error.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const contract = await getContractDetail(req.db, req.params.id, { today: req.query.today });
    res.json(contract);
  } catch (error) {
    res.status(httpStatus(error)).json({ error: error.message });
  }
});

router.post('/', requireRole(...PROCUREMENT_ROLES), async (req, res) => {
  try {
    const body = withSessionActor(req, req.body || {}, { names: ['actor_name'] });
    const contract = await createContract(req.db, body);
    res.status(201).json(contract);
  } catch (error) {
    res.status(httpStatus(error)).json({ error: error.message });
  }
});

router.post('/:id/renew-pr', requireRole(...PROCUREMENT_ROLES), async (req, res) => {
  try {
    const body = withSessionActor(req, req.body || {}, {
      ids: ['requester_id'],
      names: ['actor_name']
    });
    const result = await createRenewalRequisition(req.db, req.params.id, {
      requester_id: body.requester_id,
      needed_by_date: body.needed_by_date,
      notes: body.notes,
      actor_name: body.actor_name,
      today: body.today
    });
    res.status(201).json(result);
  } catch (error) {
    res.status(httpStatus(error)).json({ error: error.message });
  }
});

export default router;
