import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCountCreate,validateCountQuantity,calculateCountDelta} from '../src/inventory-count-validation.js';
const a='123e4567-e89b-42d3-a456-426614174000',b='123e4567-e89b-42d3-a456-426614174001';
test('validates count session details and optional unique variants',()=>{assert.equal(validateCountCreate({title:'นับคลังรอบเช้า',location:'ชั้น A',variant_ids:[a,b]}).error,undefined);assert.ok(validateCountCreate({title:'x'}).error);assert.ok(validateCountCreate({title:'นับสต็อก',variant_ids:[a,a]}).error)});
test('accepts zero and fractional quantities to three decimals',()=>{assert.deepEqual(validateCountQuantity({counted_quantity:0}),{counted_quantity:0});assert.deepEqual(validateCountQuantity({counted_quantity:'2.125'}),{counted_quantity:2.125})});
test('rejects negative, blank and excessive precision quantities',()=>{for(const v of [-1,'','1.0001',NaN])assert.ok(validateCountQuantity({counted_quantity:v}).error)});
test('computes count deltas without floating point noise',()=>{assert.equal(calculateCountDelta(10.125,8.2),-1.925);assert.equal(calculateCountDelta(0,3),3)});
