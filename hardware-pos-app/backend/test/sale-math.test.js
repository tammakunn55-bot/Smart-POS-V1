import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateBillDiscount } from '../src/sale-math.js';

test('allocates bill discount across lines and preserves bill total', () => {
  const lines = [100, 49.99, 12.5];
  const result = allocateBillDiscount(lines, 7.01);
  assert.equal(result.reduce((sum, row) => sum + Math.round(row.discount_amount * 100), 0), 701);
  assert.equal(result.reduce((sum, row) => sum + Math.round(row.line_total * 100), 0), 15548);
  assert.deepEqual(result.map(row => Math.round((row.line_total + row.discount_amount) * 100)), lines.map(value => Math.round(value * 100)));
});

test('handles one-cent discount across tiny lines without losing cents', () => {
  const result = allocateBillDiscount([0.01, 0.01, 0.01], 0.01);
  assert.equal(result.reduce((sum, row) => sum + Math.round(row.discount_amount * 100), 0), 1);
  assert.equal(result.reduce((sum, row) => sum + Math.round(row.line_total * 100), 0), 2);
});

test('rejects discount greater than subtotal', () => {
  assert.throws(() => allocateBillDiscount([10], 10.01), RangeError);
});
