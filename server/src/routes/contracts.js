import express from 'express';
import {
  listContracts,
  getContractDetail,
  createContract,
  createRenewalRequisition,
  ContractError
} from '../contractsService.js';

const router = express.Router();

// List contracts with filters
router.get('/', async (req, res) => {
  try {
    const { category, status, search } = req.query;
    const contracts = await listContracts(req.db, { category, status, search });
    res.json(contracts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single contract details
router.get('/:id', async (req, res) => {
  try {
    const contract = await getContractDetail(req.db, req.params.id);
    res.json(contract);
  } catch (error) {
    const status = error instanceof ContractError ? error.statusCode : 500;
    res.status(status).json({ error: error.message });
  }
});

// Create new contract
router.post('/', async (req, res) => {
  try {
    const contract = await createContract(req.db, req.body);
    res.status(201).json(contract);
  } catch (error) {
    const status = error instanceof ContractError ? error.statusCode : 500;
    res.status(status).json({ error: error.message });
  }
});

// 1-Click Renewal Requisition creation
router.post('/:id/renew-pr', async (req, res) => {
  try {
    const { requester_id, needed_by_date, notes } = req.body;
    const result = await createRenewalRequisition(req.db, req.params.id, {
      requester_id: requester_id || 1,
      needed_by_date,
      notes
    });
    res.status(201).json(result);
  } catch (error) {
    const status = error instanceof ContractError ? error.statusCode : 500;
    res.status(status).json({ error: error.message });
  }
});

export default router;

