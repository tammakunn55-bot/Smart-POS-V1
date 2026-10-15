import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSellUnit, convertToBaseQuantity } from '../src/unit-conversion.js';

test('validates package sell unit and normalizes barcode', () => {
  assert.deepEqual(validateSellUnit({unit_name:'ลัง',barcode:' 885123 ',conversion_factor:12,sale_price:240}), {value:{unit_name:'ลัง',barcode:'885123',conversion_factor:12,sale_price:240}});
});
test('rejects factor at or below one, invalid price and excessive precision', () => {
  assert.ok(validateSellUnit({unit_name:'แพ็ก',conversion_factor:1,sale_price:10}).error);
  assert.ok(validateSellUnit({unit_name:'แพ็ก',conversion_factor:6,sale_price:-1}).error);
  assert.ok(validateSellUnit({unit_name:'แพ็ก',conversion_factor:6.0001,sale_price:10}).error);
});
test('converts selling quantity into base stock units with three decimal precision', () => {
  assert.deepEqual(convertToBaseQuantity(2,12), {quantity:2,factor:12,base_quantity:24});
  assert.deepEqual(convertToBaseQuantity(0.5,3), {quantity:0.5,factor:3,base_quantity:1.5});
});
test('rejects zero, negative and excessive quantity precision', () => {
  assert.ok(convertToBaseQuantity(0,12).error);
  assert.ok(convertToBaseQuantity(1.0001,12).error);
  assert.ok(convertToBaseQuantity(1,-1).error);
});

test('accepts valid three-decimal conversion factors despite floating point representation', () => {
  assert.equal(validateSellUnit({unit_name:'มัด',conversion_factor:1.001,sale_price:10.01}).value.conversion_factor,1.001);
  assert.equal(convertToBaseQuantity(1.001,12).base_quantity,12.012);
});
