import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePurchaseOrderInput, validateReceiptItems } from '../src/purchase-validation.js';

test('purchase order accepts valid fractional quantities and costs', () => {
  const result = validatePurchaseOrderInput({ supplier_id: null, items: [{ variant_id: 'v1', quantity: 2.5, unit_cost: 12.35 }] });
  assert.equal(result.error, undefined);
  assert.equal(result.items[0].quantity, 2.5);
  assert.equal(result.items[0].unit_cost, 12.35);
});

test('purchase order rejects duplicate variants and invalid quantities', () => {
  const result = validatePurchaseOrderInput({ items: [{ variant_id: 'v1', quantity: 1, unit_cost: 1 }, { variant_id: 'v1', quantity: 0, unit_cost: -1 }] });
  assert.equal(result.error, 'ข้อมูลรายการสินค้าไม่ถูกต้อง');
  assert.equal(result.details.length, 1);
});

test('purchase order requires 1 to 200 items', () => {
  assert.ok(validatePurchaseOrderInput({ items: [] }).error);
  assert.ok(validatePurchaseOrderInput({ items: Array.from({ length: 201 }, (_, i) => ({ variant_id: `v${i}`, quantity: 1, unit_cost: 0 })) }).error);
});

test('receipt accepts optional per-receipt unit cost', () => {
  const result = validateReceiptItems([{ variant_id: 'v1', quantity: 1.25 }, { variant_id: 'v2', quantity: 2, unit_cost: 5.25 }]);
  assert.equal(result.error, undefined);
  assert.equal(result.items[0].unit_cost, null);
  assert.equal(result.items[1].unit_cost, 5.25);
});

test('receipt rejects duplicate variants, negative quantities, and over-precision', () => {
  const result = validateReceiptItems([{ variant_id: 'v1', quantity: 1.0001 }, { variant_id: 'v1', quantity: -2 }]);
  assert.equal(result.error, 'ข้อมูลรับสินค้าไม่ถูกต้อง');
  assert.ok(result.details[0].errors.some(x => x.includes('3 ตำแหน่ง')));
  assert.ok(result.details[1].errors.some(x => x.includes('ห้ามระบุสินค้าซ้ำ')));
});
