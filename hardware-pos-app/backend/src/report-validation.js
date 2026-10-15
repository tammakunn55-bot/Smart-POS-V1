const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
export function validateReportRange(from, to) {
  if (!validDate(from) || !validDate(to)) return { error: 'กรุณาระบุวันที่ในรูปแบบ YYYY-MM-DD' };
  if (from > to) return { error: 'วันที่เริ่มต้นต้องไม่อยู่หลังวันที่สิ้นสุด' };
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if ((end - start) / 86400000 > 366) return { error: 'ช่วงรายงานต้องไม่เกิน 367 วัน' };
  return { from, to };
}
