export function validateImportRows(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 500) return { error: 'ต้องส่งสินค้า 1–500 รายการต่อครั้ง' };
  const seenSku = new Set(), seenBarcode = new Set(), errors = [];
  const normalized = rows.map((r, i) => {
    const row = { row_number: Number(r.row_number) || i + 2, sku: String(r.sku ?? '').trim(), name: String(r.name ?? '').trim(), category_name: String(r.category_name ?? '').trim(), barcode: String(r.barcode ?? '').trim(), unit_name: String(r.unit_name ?? 'ชิ้น').trim() || 'ชิ้น', cost_price: Number(r.cost_price ?? 0), sale_price: Number(r.sale_price ?? 0), opening_stock: Number(r.opening_stock ?? 0), low_stock_threshold: Number(r.low_stock_threshold ?? 0) };
    const rowErrors = [];
    if (!row.sku) rowErrors.push('ไม่มี SKU');
    if (!row.name) rowErrors.push('ไม่มีชื่อสินค้า');
    for (const k of ['cost_price','sale_price','opening_stock','low_stock_threshold']) if (!Number.isFinite(row[k]) || row[k] < 0) rowErrors.push(`${k} ต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป`);
    if (row.sku && seenSku.has(row.sku.toLowerCase())) rowErrors.push('SKU ซ้ำในไฟล์');
    if (row.barcode && seenBarcode.has(row.barcode)) rowErrors.push('บาร์โค้ดซ้ำในไฟล์');
    if (row.sku) seenSku.add(row.sku.toLowerCase()); if (row.barcode) seenBarcode.add(row.barcode);
    if (rowErrors.length) errors.push({ row_number: row.row_number, sku: row.sku, errors: rowErrors });
    return row;
  });
  return { rows: normalized, errors };
}
