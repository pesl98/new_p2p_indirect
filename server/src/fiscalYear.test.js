import test from 'node:test';
import assert from 'node:assert/strict';
import { currentFiscalYear } from './fiscalYear.js';

test('defaults to the UTC year of now', () => {
  assert.equal(currentFiscalYear({}, new Date('2027-01-02T00:00:00Z')), 2027);
  assert.equal(currentFiscalYear({}, new Date('2026-12-31T23:59:59Z')), 2026);
});

test('FISCAL_YEAR env pins the year; junk is ignored', () => {
  assert.equal(currentFiscalYear({ FISCAL_YEAR: '2030' }, new Date('2026-01-01Z')), 2030);
  assert.equal(currentFiscalYear({ FISCAL_YEAR: 'abc' }, new Date('2026-05-01Z')), 2026);
});
