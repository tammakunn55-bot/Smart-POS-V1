import test from 'node:test';
import assert from 'node:assert/strict';
import { requiredPermission, isAllowed } from '../src/authorization.js';

test('owner can access all permissions',()=>{assert.equal(isAllowed('owner','users.manage'),true);assert.equal(isAllowed('owner','shop.manage'),true)});
test('cashier can sell but cannot refund or adjust inventory',()=>{assert.equal(isAllowed('cashier',requiredPermission('POST','/sales')),true);assert.equal(isAllowed('cashier',requiredPermission('POST','/sales/abc/returns')),false);assert.equal(isAllowed('cashier',requiredPermission('POST','/inventory/adjustments')),false)});
test('inventory role can manage stock and purchasing but not reports',()=>{assert.equal(isAllowed('inventory',requiredPermission('POST','/purchase-orders')),true);assert.equal(isAllowed('inventory',requiredPermission('POST','/inventory/adjustments')),true);assert.equal(isAllowed('inventory',requiredPermission('GET','/reports/summary')),false)});
test('accountant can view reports and audit but cannot create users',()=>{assert.equal(isAllowed('accountant',requiredPermission('GET','/reports/summary')),true);assert.equal(isAllowed('accountant',requiredPermission('GET','/audit-logs')),true);assert.equal(isAllowed('accountant',requiredPermission('POST','/users')),false)});
test('unknown endpoints and unsupported methods are denied',()=>{assert.equal(isAllowed('owner',requiredPermission('DELETE','/products/abc')),false);assert.equal(isAllowed('cashier',requiredPermission('GET','/internal/debug')),false)});
test('manager can refund and see reports but cannot administer users',()=>{assert.equal(isAllowed('manager',requiredPermission('POST','/sales/abc/returns')),true);assert.equal(isAllowed('manager',requiredPermission('GET','/reports/summary')),true);assert.equal(isAllowed('manager',requiredPermission('POST','/users')),false)});
test('inventory role can create and count inventory sessions but cannot approve them',()=>{assert.equal(requiredPermission('POST','/inventory-counts'),'inventory.count');assert.equal(requiredPermission('PATCH','/inventory-counts/123/items/456'),'inventory.count');assert.equal(isAllowed('inventory',requiredPermission('POST','/inventory-counts/123/decision')),false);assert.equal(isAllowed('manager',requiredPermission('POST','/inventory-counts/123/decision')),true)});

test('sell unit and barcode lookup routes have explicit permissions', () => {
  assert.equal(requiredPermission('GET','/products/barcode/885123'), 'products.read');
  assert.equal(requiredPermission('GET','/products/variant-1/units'), 'products.read');
  assert.equal(requiredPermission('POST','/products/variant-1/units'), 'products.write');
  assert.equal(requiredPermission('PATCH','/products/units/unit-1'), 'products.write');
  assert.equal(requiredPermission('DELETE','/products/units/unit-1'), '__deny__');
});

test('product variant creation route requires product write permission', () => {
  assert.equal(requiredPermission('POST', '/products/123/variants'), 'products.write');
  assert.equal(requiredPermission('GET', '/products/123/variants'), '__deny__');
});
