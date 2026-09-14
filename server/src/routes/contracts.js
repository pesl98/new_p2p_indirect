import express from 'express';
import {
  listContracts,
  getContractDetail,
  createContract,
  createRenewalRequisition,
  ContractError
} from '../contractsService.js';

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

router.get('/:id', async (req, res) => {
  try {
    const contract = await getContractDetail(req.db, req.params.id, { today: req.query.today });
    res.json(contract);
  } catch (error) {
    res.status(httpStatus(error)).json({ error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const contract = await createContract(req.db, req.body || {});
    res.status(201).json(contract);
  } catch (error) {
    res.status(httpStatus(error)).json({ error: error.message });
  }
});

router.post('/:id/renew-pr', async (req, res) => {
  try {
    const { requester_id, needed_by_date, notes, actor_name, today } = req.body || {};
    const result = await createRenewalRequisition(req.db, req.params.id, {
      requester_id,
      needed_by_date,
      notes,
      actor_name,
      today
    });
    res.status(201).json(result);
  } catch (error) {
    res.status(httpStatus(error)).json({ error: error.message });
  }
});

export default router;
