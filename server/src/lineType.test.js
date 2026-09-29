import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isServiceLine, lineTypeFromCategory, normalizeLineType, quantityPhrase, resolveServiceBasis, LineTypeError } from './lineType.js';

describe('line type from category', () => {
  test('consulting, software, marketing, and travel are services', () => {
    assert.equal(lineTypeFromCategory('Consulting & Professional Services'), 'service');
    assert.equal(lineTypeFromCategory('Software & Cloud'), 'service');
    assert.equal(lineTypeFromCategory('Marketing & Events'), 'service');
    assert.equal(lineTypeFromCategory('Travel & Subscriptions'), 'service');
  });

  test('hardware, office, and facilities are goods', () => {
    assert.equal(lineTypeFromCategory('IT Hardware'), 'goods');
    assert.equal(lineTypeFromCategory('Office Supplies'), 'goods');
    assert.equal(lineTypeFromCategory('Facilities & MRO'), 'goods');
    assert.equal(lineTypeFromCategory('Unknown Category'), 'goods');
  });

  test('explicit line_type wins over category', () => {
    assert.equal(normalizeLineType('goods', 'Software & Cloud'), 'goods');
    assert.equal(normalizeLineType('service', 'IT Hardware'), 'service');
    assert.equal(normalizeLineType(null, 'Software & Cloud'), 'service');
  });

  test('isServiceLine uses stored type then category', () => {
    assert.equal(isServiceLine({ line_type: 'service', category: 'IT Hardware' }), true);
    assert.equal(isServiceLine({ line_type: 'goods', category: 'Software & Cloud' }), false);
    assert.equal(isServiceLine({ category: 'Consulting & Professional Services' }), true);
  });
});

describe('service basis', () => {
  test('goods lines drop any basis; services keep lump sum, hours, or days', () => {
    assert.equal(resolveServiceBasis('hours', 'goods'), null);
    assert.equal(resolveServiceBasis('lump_sum', 'service'), 'lump_sum');
    assert.equal(resolveServiceBasis('hours', 'service'), 'hours');
    assert.equal(resolveServiceBasis('days', 'service'), 'days');
    assert.equal(resolveServiceBasis(null, 'service'), null);
    assert.equal(resolveServiceBasis('', 'service'), null);
  });

  test('rejects an unknown service basis', () => {
    assert.throws(
      () => resolveServiceBasis('seats', 'service'),
      (err) => err instanceof LineTypeError && err.statusCode === 400
    );
  });

  test('quantity phrases stay in whole units', () => {
    assert.equal(quantityPhrase('hours', 1), '1 hour');
    assert.equal(quantityPhrase('hours', 16), '16 hours');
    assert.equal(quantityPhrase('days', 2), '2 days');
    assert.equal(quantityPhrase('lump_sum', 1), '1 lump sum');
    assert.equal(quantityPhrase(null, 10), '10 units');
  });
});
