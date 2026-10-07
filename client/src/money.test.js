import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMajorInput, parseMajorAmount, toCents } from './money.js';

describe('Dutch major-unit amount parsing', () => {
  test('comma is the decimal separator and dot is thousands', () => {
    assert.equal(parseMajorAmount('1.295,50'), 1295.5);
    assert.equal(toCents('1.295,50'), 129550);
    assert.equal(toCents('12,5'), 1250);
    assert.equal(toCents('0,50'), 50);
    assert.equal(toCents('€ 1.295,00'), 129500);
    assert.equal(toCents('1 295,00'), 129500);
  });

  test('grouped thousands without a comma stay whole major units', () => {
    assert.equal(parseMajorAmount('1.295'), 1295);
    assert.equal(toCents('1.295'), 129500);
    assert.equal(toCents('10.000'), 1000000);
    assert.equal(toCents('1.295.000'), 129500000);
  });

  test('a dot with one or two fractional digits is still a decimal', () => {
    assert.equal(toCents('749.00'), 74900);
    assert.equal(toCents('12.5'), 1250);
    assert.equal(parseMajorAmount('0.50'), 0.5);
    assert.equal(parseMajorAmount('0.185'), 0.185);
  });

  test('numbers and empty or invalid text keep the previous edge', () => {
    assert.equal(toCents(1295), 129500);
    assert.equal(toCents(1295.5), 129550);
    assert.equal(toCents(0.1 + 0.2), 30);
    assert.equal(toCents(''), 0);
    assert.equal(toCents('abc'), 0);
    assert.equal(parseMajorAmount(''), null);
    assert.equal(parseMajorAmount('12,50,1'), null);
    assert.equal(toCents('-1,50'), -150);
  });

  test('formatMajorInput writes the value a Dutch amount field shows', () => {
    assert.equal(formatMajorInput(129550), '1.295,50');
    assert.equal(formatMajorInput(50), '0,50');
    assert.equal(formatMajorInput(0), '0,00');
    assert.equal(formatMajorInput(-150), '-1,50');
    assert.equal(toCents(formatMajorInput(74900)), 74900);
  });
});
