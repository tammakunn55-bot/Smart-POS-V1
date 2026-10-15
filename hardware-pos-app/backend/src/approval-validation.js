const TYPES = new Set(['inventory_adjustment','product_price_change','product_cost_change']);
export function validateApprovalRequest(input = {}) {
  const errors = [];
  const request_type = String(input.request_type || '');
  const entity_id = String(input.entity_id || '').trim();
  const reason = String(input.reason || '').trim();
  const payload = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : {};
  if (!TYPES.has(request_type)) errors.push('ประเภทคำขอไม่ถูกต้อง');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entity_id)) errors.push('entity_id ต้องเป็น UUID');
  if (reason.length < 3 || reason.length > 500) errors.push('เหตุผลต้องมี 3-500 ตัวอักษร');
  if (request_type === 'inventory_adjustment') {
    const delta = Number(payload.quantity_delta);
    if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 1000000) errors.push('จำนวนปรับสต็อกต้องไม่เป็นศูนย์และไม่เกิน 1,000,000');
  } else if (request_type === 'product_price_change' || request_type === 'product_cost_change') {
    const value = Number(payload.value);
    if (!Number.isFinite(value) || value < 0 || value > 999999999) errors.push('ราคา/ต้นทุนต้องอยู่ระหว่าง 0 ถึง 999,999,999');
  }
  return errors.length ? { error: errors[0], details: errors } : { request_type, entity_id, reason, payload: request_type === 'inventory_adjustment' ? { quantity_delta: Number(payload.quantity_delta) } : { value: Number(payload.value) } };
}
export function validateApprovalDecision(input = {}) {
  const decision = String(input.decision || '');
  const note = String(input.note || '').trim();
  if (!['approved','rejected'].includes(decision)) return { error: 'การตัดสินใจต้องเป็น approved หรือ rejected' };
  if (note.length > 500) return { error: 'หมายเหตุต้องไม่เกิน 500 ตัวอักษร' };
  return { decision, note };
}
