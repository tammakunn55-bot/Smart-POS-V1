import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidCashAmount, calculateExpectedCash, reconcileCash } from '../src/cash-shift.js';

test('cash amount accepts zero and cents but rejects negatives, NaN and excess decimals', () => {
  assert.equal(isValidCashAmount(0), true);
  assert.equal(isValidCashAmount('10.25'), true);
  assert.equal(isValidCashAmount(-1), false);
  assert.equal(isValidCashAmount('nope'), false);
  assert.equal(isValidCashAmount(1.001), false);
  assert.equal(isValidCashAmount(0, { allowZero: false }), false);
});

test('expected cash includes cash sales/in and subtracts cash out/refunds, but not transfers or opening float twice', () => {
  assert.equal(calculateExpectedCash(500, [
    { movement_type: 'opening_float', amount: 500 },
    { movement_type: 'sale_cash', amount: 120.50 },
    { movement_type: 'cash_in', amount: 20 },
    { movement_type: 'cash_out', amount: 10 },
    { movement_type: 'refund_cash', amount: 5 },
    { movement_type: 'sale_transfer', amount: 100 },
  ]), 625.5);
});

test('cash reconciliation calculates shortage and overage to cents', () => {
  assert.deepEqual(reconcileCash(100, 95.25), { expected_cash: 100, counted_cash: 95.25, cash_difference: -4.75 });
  assert.deepEqual(reconcileCash(100, 101), { expected_cash: 100, counted_cash: 101, cash_difference: 1 });
});
