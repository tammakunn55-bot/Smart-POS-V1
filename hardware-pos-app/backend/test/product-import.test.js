import test from 'node:test';
import assert from 'node:assert/strict';
import { validateImportRows } from '../src/product-import.js';

test('normalizes valid rows and defaults optional fields', () => {
  const result = validateImportRows([{ sku: ' WIRE-1 ', name: 'สายไฟ', sale_price: '12.50' }]);
  assert.equal(result.errors.length, 0);
  assert.equal(result.rows[0].sku, 'WIRE-1');
  assert.equal(result.rows[0].unit_name, 'ชิ้น');
  assert.equal(result.rows[0].opening_stock, 0);
});

test('rejects missing SKU and product name', () => {
  const result = validateImportRows([{ sku: '', name: '' }]);
  assert.deepEqual(result.errors[0].errors, ['ไม่มี SKU', 'ไม่มีชื่อสินค้า']);
});

test('rejects negative and non-numeric prices or stock', () => {
  const result = validateImportRows([{ sku: 'A', name: 'A', cost_price: -1, sale_price: 'bad', opening_stock: -2 }]);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].errors.length, 3);
});

test('detects duplicate SKU case-insensitively within the file', () => {
  const result = validateImportRows([{ sku: 'wire-1', name: 'One' }, { sku: 'WIRE-1', name: 'Two' }]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].errors.join(' '), /SKU ซ้ำในไฟล์/);
});

test('detects duplicate barcode within the file', () => {
  const result = validateImportRows([{ sku: 'A', name: 'One', barcode: '123' }, { sku: 'B', name: 'Two', barcode: '123' }]);
  assert.match(result.errors[0].errors.join(' '), /บาร์โค้ดซ้ำในไฟล์/);
});

test('enforces batch size limit', () => {
  assert.match(validateImportRows([]).error, /1–500/);
  assert.match(validateImportRows(Array.from({ length: 501 }, (_, i) => ({ sku: `S${i}`, name: 'Item' }))).error, /1–500/);
});
