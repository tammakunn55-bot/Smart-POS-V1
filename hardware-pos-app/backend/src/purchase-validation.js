export function validatePurchaseOrderInput(body = {}) {
  const supplierId = body.supplier_id || null;
  const items = body.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > 200) return { error: 'ใบสั่งซื้อต้องมีสินค้า 1–200 รายการ' };
  const seen = new Set();
  const errors = [];
  const normalized = items.map((item, index) => {
    const variant_id = String(item?.variant_id ?? '').trim();
    const quantity = Number(item?.quantity);
    const unit_cost = Number(item?.unit_cost);
    const rowErrors = [];
    if (!variant_id) rowErrors.push('ต้องระบุ variant_id');
    if (variant_id && seen.has(variant_id)) rowErrors.push('ห้ามระบุสินค้าซ้ำในใบสั่งซื้อ');
    if (variant_id) seen.add(variant_id);
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(quantity * 1000)) rowErrors.push('จำนวนต้องมากกว่า 0 และไม่เกิน 3 ตำแหน่งทศนิยม');
    if (!Number.isFinite(unit_cost) || unit_cost < 0 || !Number.isInteger(unit_cost * 100)) rowErrors.push('ต้นทุนต้องเป็นตัวเลขไม่ติดลบและไม่เกิน 2 ตำแหน่งทศนิยม');
    if (rowErrors.length) errors.push({ row_number: index + 1, errors: rowErrors });
    return { variant_id, quantity, unit_cost };
  });
  if (errors.length) return { error: 'ข้อมูลรายการสินค้าไม่ถูกต้อง', details: errors };
  return { supplier_id: supplierId, note: String(body.note ?? '').trim() || null, items: normalized };
}

export function validateReceiptItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 200) return { error: 'รายการรับสินค้าต้องมี 1–200 รายการ' };
  const seen = new Set();
  const errors = [];
  const normalized = items.map((item, index) => {
    const variant_id = String(item?.variant_id ?? '').trim();
    const quantity = Number(item?.quantity);
    const unit_cost = item?.unit_cost === undefined ? null : Number(item.unit_cost);
    const rowErrors = [];
    if (!variant_id) rowErrors.push('ต้องระบุ variant_id');
    if (variant_id && seen.has(variant_id)) rowErrors.push('ห้ามระบุสินค้าซ้ำในรายการรับครั้งเดียว');
    if (variant_id) seen.add(variant_id);
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(quantity * 1000)) rowErrors.push('จำนวนรับต้องมากกว่า 0 และไม่เกิน 3 ตำแหน่งทศนิยม');
    if (unit_cost !== null && (!Number.isFinite(unit_cost) || unit_cost < 0 || !Number.isInteger(unit_cost * 100))) rowErrors.push('ต้นทุนต้องไม่ติดลบและไม่เกิน 2 ตำแหน่งทศนิยม');
    if (rowErrors.length) errors.push({ row_number: index + 1, errors: rowErrors });
    return { variant_id, quantity, unit_cost };
  });
  if (errors.length) return { error: 'ข้อมูลรับสินค้าไม่ถูกต้อง', details: errors };
  return { items: normalized };
}
