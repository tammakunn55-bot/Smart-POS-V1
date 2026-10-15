import test from 'node:test';
import assert from 'node:assert/strict';
import { validateApprovalRequest, validateApprovalDecision } from '../src/approval-validation.js';
const uuid='123e4567-e89b-42d3-a456-426614174000';
test('accepts a valid inventory adjustment approval',()=>{const r=validateApprovalRequest({request_type:'inventory_adjustment',entity_id:uuid,reason:'ตรวจนับสต็อก',payload:{quantity_delta:-2}});assert.equal(r.error,undefined);assert.equal(r.payload.quantity_delta,-2)});
test('rejects zero inventory delta',()=>{assert.match(validateApprovalRequest({request_type:'inventory_adjustment',entity_id:uuid,reason:'ตรวจนับ',payload:{quantity_delta:0}}).error,/จำนวนปรับสต็อก/)});
test('accepts valid price and cost change requests',()=>{for(const request_type of ['product_price_change','product_cost_change'])assert.equal(validateApprovalRequest({request_type,entity_id:uuid,reason:'ปรับตามใบเสนอราคา',payload:{value:12.5}}).error,undefined)});
test('rejects invalid type, uuid and reason',()=>{const r=validateApprovalRequest({request_type:'delete_everything',entity_id:'bad',reason:'x',payload:{}});assert.ok(r.details.length>=3)});
test('validates approval decisions and notes',()=>{assert.deepEqual(validateApprovalDecision({decision:'approved',note:'ตรวจสอบแล้ว'}),{decision:'approved',note:'ตรวจสอบแล้ว'});assert.ok(validateApprovalDecision({decision:'maybe'}).error);assert.ok(validateApprovalDecision({decision:'rejected',note:'x'.repeat(501)}).error)});
