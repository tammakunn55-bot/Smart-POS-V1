export function validateReturnInput(body = {}) {
  const reason = String(body.reason ?? '').trim();
  const items = body.items;
  if (reason.length < 2 || reason.length > 500) return { error: 'ต้องระบุเหตุผลการคืนสินค้า 2–500 ตัวอักษร' };
  if (!Array.isArray(items) || items.length < 1 || items.length > 200) return { error: 'รายการคืนสินค้าต้องมี 1–200 รายการ' };
  const seen = new Set();
  const errors = [];
  const normalized = items.map((item, index) => {
    const bill_item_id = String(item?.bill_item_id ?? '').trim();
    const quantity = Number(item?.quantity);
    const rowErrors = [];
    if (!bill_item_id) rowErrors.push('ต้องระบุ bill_item_id');
    if (bill_item_id && seen.has(bill_item_id)) rowErrors.push('ห้ามระบุรายการบิลซ้ำ');
    if (bill_item_id) seen.add(bill_item_id);
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(quantity * 1000)) rowErrors.push('จำนวนคืนต้องมากกว่า 0 และไม่เกิน 3 ตำแหน่งทศนิยม');
    if (rowErrors.length) errors.push({ row_number: index + 1, errors: rowErrors });
    return { bill_item_id, quantity };
  });
  if (errors.length) return { error: 'ข้อมูลรายการคืนไม่ถูกต้อง', details: errors };
  const refund_method = String(body.refund_method ?? 'cash');
  if (!['cash', 'transfer', 'other'].includes(refund_method)) return { error: 'วิธีคืนเงินต้องเป็น cash, transfer หรือ other' };
  return { reason, refund_method, items: normalized };
}
