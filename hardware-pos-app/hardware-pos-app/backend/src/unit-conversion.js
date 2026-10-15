export function validateSellUnit(input = {}) {
  const unitName = String(input.unit_name ?? '').trim();
  const barcode = String(input.barcode ?? '').trim();
  const factor = Number(input.conversion_factor);
  const price = Number(input.sale_price);
  if (!unitName || unitName.length > 40) return { error: 'กรุณาระบุชื่อหน่วยขายไม่เกิน 40 ตัวอักษร' };
  if (!Number.isFinite(factor) || factor <= 1 || Math.abs(factor * 1000 - Math.round(factor * 1000)) > 1e-7) return { error: 'ตัวคูณหน่วยต้องมากกว่า 1 และมีทศนิยมไม่เกิน 3 ตำแหน่ง' };
  if (!Number.isFinite(price) || price < 0 || Math.abs(price * 100 - Math.round(price * 100)) > 1e-7) return { error: 'ราคาขายต้องเป็นจำนวนเงินไม่ติดลบและมีทศนิยมไม่เกิน 2 ตำแหน่ง' };
  if (barcode.length > 100) return { error: 'บาร์โค้ดยาวเกินกำหนด' };
  return { value: { unit_name: unitName, barcode: barcode || null, conversion_factor: factor, sale_price: price } };
}
export function convertToBaseQuantity(quantity, factor = 1) {
  const q = Number(quantity), f = Number(factor);
  if (!Number.isFinite(q) || q <= 0 || Math.abs(q * 1000 - Math.round(q * 1000)) > 1e-7 || !Number.isFinite(f) || f <= 0 || Math.abs(f * 1000 - Math.round(f * 1000)) > 1e-7) return { error: 'จำนวนหรือตัวคูณหน่วยไม่ถูกต้อง' };
  const base = Math.round(q * f * 1000) / 1000;
  if (!Number.isFinite(base) || base <= 0) return { error: 'จำนวนหน่วยฐานไม่ถูกต้อง' };
  return { quantity: q, factor: f, base_quantity: base };
}
