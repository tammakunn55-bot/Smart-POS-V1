import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReturnInput } from '../src/return-validation.js';

test('normalizes valid partial return', () => {
  assert.deepEqual(validateReturnInput({ reason: 'สินค้าเสียหาย', items: [{ bill_item_id: 'item-1', quantity: 1.25 }], refund_method: 'transfer' }), {
    reason: 'สินค้าเสียหาย', refund_method: 'transfer', items: [{ bill_item_id: 'item-1', quantity: 1.25 }]
  });
});
test('rejects missing reason and empty items', () => {
  assert.ok(validateReturnInput({ items: [] }).error);
});
test('rejects duplicate bill items and invalid quantities', () => {
  const result = validateReturnInput({ reason: 'คืนสินค้า', items: [{ bill_item_id: 'x', quantity: 1 }, { bill_item_id: 'x', quantity: 0 }] });
  assert.ok(result.error);
  assert.equal(result.details.length, 1);
  assert.equal(result.details[0].errors.length, 2);
});
test('rejects unsupported refund method', () => {
  assert.match(validateReturnInput({ reason: 'คืนสินค้า', items: [{ bill_item_id: 'x', quantity: 1 }], refund_method: 'credit' }).error, /วิธีคืนเงิน/);
});
