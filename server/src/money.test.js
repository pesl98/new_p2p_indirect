import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { asCents, formatCents, fromCents, lineTotalCents, toCents, toQty } from './money.js';
import { priceToleranceCents } from './match.js';

describe('money helpers', () => {
  test('toCents converts dollars at the edge without leaving residual fractions', () => {
    assert.equal(toCents(1295), 129500);
    assert.equal(toCents(1295.00), 129500);
    assert.equal(toCents('749.00'), 74900);
    assert.equal(toCents(0.1 + 0.2), 30);
  });

  test('fromCents / formatCents are display-only conversions', () => {
    assert.equal(fromCents(129500), 1295);
    assert.equal(formatCents(74900), '749.00');
    assert.equal(formatCents(50), '0.50');
  });

  test('line totals and qty stay integer', () => {
    assert.equal(lineTotalCents(4, 74900), 299600);
    assert.equal(toQty(2.9), 2);
    assert.equal(asCents(79900.7), 79900);
  });

  test('price tolerance is 1% of PO unit price in cents, rounded to nearest cent', () => {
    assert.equal(priceToleranceCents(74900), 749);
    assert.equal(priceToleranceCents(129500), 1295);
    assert.equal(priceToleranceCents(0), 0);
  });
});
