import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isServiceLine, lineTypeFromCategory, normalizeLineType } from './lineType.js';

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
