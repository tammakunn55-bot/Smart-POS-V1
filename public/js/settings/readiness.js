/* =============================================================================
 * js/settings/readiness.js
 * "ตรวจความพร้อมก่อนใช้งานจริง" — สรุปเป็นภาษาคนว่าอะไรพร้อม/ควรแก้ก่อนเปิดร้าน (ปุ่มอยู่ที่ ตั้งค่า > ร้านค้า)
 *
 * computeReadiness(db, ctx) เป็นฟังก์ชันล้วน (ไม่แตะหน้าจอ) จึงทดสอบง่าย: คืนรายการ { level, title, detail }
 *   level: 'ok' พร้อม · 'warn' ควรแก้ · 'fail' ต้องแก้ก่อนใช้งาน
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * computeReadiness, showReadinessReport
 * ============================================================================= */

window.computeReadiness = function (d, ctx) {
  ctx = ctx || {};
  const items = [];
  const add = (level, title, detail) => items.push({ level, title, detail: detail || '' });
  const products = Object.values((d && d.products) || {}).filter((p) => !p.isDeleted);
  const variants = products.flatMap((p) => p.variants || []);

  // ---- ข้อมูลสินค้า ----
  if (!products.length) {
    add('fail', 'ยังไม่มีสินค้า', 'นำเข้าจากไฟล์ Excel (ตั้งค่า > นำเข้า) หรือเพิ่มสินค้าที่หน้าสต็อก');
  } else {
    add('ok', `มีสินค้า ${products.length} รายการ (${variants.length} ขนาด/ตัวเลือก)`);
    const noCost = variants.filter((v) => !(+v.cost > 0)).length;
    add(noCost ? 'warn' : 'ok', noCost ? `ยังไม่มีราคาทุน ${noCost} ตัวเลือก` : 'ทุกสินค้ามีราคาทุน',
      noCost ? 'ไม่มีราคาทุน = คำนวณกำไรไม่ได้ — กรอกที่หน้าสินค้า หรือรับของเข้าพร้อมราคาทุน' : '');
    const zeroPrice = variants.filter((v) => !(+v.price > 0)).length;
    if (zeroPrice) add('fail', `ราคาขายเป็น 0 บาท ${zeroPrice} ตัวเลือก`, 'จะขายได้ในราคา 0 บาท — แก้ราคาก่อนเปิดขาย');
    const negative = variants.filter((v) => +v.stock < 0).length;
    if (negative) add('warn', `สต็อกติดลบ ${negative} ตัวเลือก`, 'ตรวจว่าขายเกินสต็อก หรือยังไม่ได้กรอกยอดยกมา แล้วปรับจำนวนที่หน้าสต็อก');
    const allZero = variants.length > 0 && variants.every((v) => !(+v.stock > 0));
    if (allZero) add('warn', 'สต็อกทุกรายการเป็น 0', 'ยังไม่ได้กรอกยอดยกมา — นับของจริงแล้วกรอก (ตั้งค่า "ป้องกันสต็อกติดลบ" ให้เปิดหลังจากนั้นเท่านั้น)');
  }

  // ---- พนักงาน/ความปลอดภัย ----
  const users = (d && d.users) || [];
  const noPin = users.filter((u) => u.needsPinSetup && !u.pinHash);
  if (noPin.length) add('fail', `ยังไม่ตั้ง PIN: ${noPin.map((u) => u.name).join(', ')}`, 'เปิดแอปแล้วเลือกชื่อ ใส่ PIN 4 หลักสองครั้งเพื่อตั้งครั้งแรก');
  else add('ok', `พนักงาน ${users.length} คน ตั้ง PIN ครบแล้ว`);

  // ---- คลาวด์ ----
  if (!ctx.cloudConfigured) {
    add('warn', 'ยังไม่ได้เชื่อมต่อ Supabase', 'ใช้งานในเครื่องเดียวได้ แต่ข้อมูลจะไม่ถูกสำรองบนคลาวด์ และใช้หลายเครื่องไม่ได้');
  } else {
    add(ctx.signedIn ? 'ok' : 'fail', ctx.signedIn ? 'ล็อกอินร้านค้าแล้ว' : 'ยังไม่ได้ล็อกอินร้านค้า', ctx.signedIn ? '' : 'ตั้งค่า > คลาวด์ > เข้าสู่ระบบด้วยอีเมลเจ้าของ');
    if (ctx.schemaVersion == null) add('warn', 'ตรวจเวอร์ชันฐานข้อมูลไม่ได้', 'อาจออฟไลน์ — ลองใหม่เมื่อมีอินเทอร์เน็ต');
    else if (ctx.schemaVersion < 3) add('fail', `ฐานข้อมูลบนเซิร์ฟเวอร์ยังเป็นเวอร์ชัน ${ctx.schemaVersion}`, 'ต้องรัน supabase/schema.sql ให้เป็นเวอร์ชัน 3 ก่อน');
    else add('ok', 'ฐานข้อมูลบนเซิร์ฟเวอร์เป็นเวอร์ชันล่าสุด');
    const q = ctx.queue || { pending: 0, failed: 0 };
    if (q.failed) add('fail', `มีรายการที่เซิร์ฟเวอร์ปฏิเสธ ${q.failed} รายการ`, 'กดป้าย ⚠️ มุมจอเพื่อดูสาเหตุ แล้วแก้ที่ต้นเหตุ จากนั้นกดซิงค์');
    else if (q.pending) add('warn', `มีรายการรอส่งขึ้นเซิร์ฟเวอร์ ${q.pending} รายการ`, 'จะส่งเองเมื่อออนไลน์ หรือกดซิงค์ตอนนี้');
    else add('ok', 'ไม่มีรายการค้างส่ง');
  }

  // ---- ตั้งค่า ----
  const s = (d && d.settings) || {};
  if (users.length > 1 && !s.perEmployeeAuth && ctx.cloudConfigured) {
    add('warn', 'ยังไม่เปิดบัญชีรายพนักงานบนเซิร์ฟเวอร์', 'ตอนนี้ทุกเครื่องใช้สิทธิ์ของเจ้าของร้านร่วมกัน — เปิดได้ที่ตั้งค่า > ร้านค้า (ต้อง deploy pin-login ก่อน)');
  }
  const hasStock = variants.some((v) => +v.stock > 0);
  if (hasStock && !s.preventNegativeStock) add('warn', 'ยังไม่เปิด "ป้องกันสต็อกติดลบ"', 'กรอกยอดสต็อกแล้ว ควรเปิดเพื่อกันขายเกินจำนวนจริง (ตั้งค่า > ร้านค้า)');
  return items;
};

window.showReadinessReport = async function () {
  const client = window.getSupabaseClient ? window.getSupabaseClient() : null;
  const ctx = { cloudConfigured: !!client, signedIn: false, schemaVersion: null, queue: window.syncQueueStats ? window.syncQueueStats() : { pending: 0, failed: 0 } };
  if (client) {
    try { const s = await client.auth.getSession(); ctx.signedIn = !!(s && s.data && s.data.session); } catch (e) { /* ออฟไลน์ */ }
    try { ctx.schemaVersion = window.checkServerSchema ? await window.checkServerSchema() : null; } catch (e) { /* ออฟไลน์ */ }
  }
  const items = window.computeReadiness(window.db, ctx);
  const icon = { ok: '✅', warn: '⚠️', fail: '❌' };
  const rank = { fail: 0, warn: 1, ok: 2 };
  const lines = items.slice().sort((a, b) => rank[a.level] - rank[b.level])
    .map((i) => `${icon[i.level]} ${i.title}${i.detail ? '\n     ' + i.detail : ''}`);
  const fails = items.filter((i) => i.level === 'fail').length, warns = items.filter((i) => i.level === 'warn').length;
  const head = fails ? `ต้องแก้ ${fails} ข้อก่อนใช้งานจริง` + (warns ? ` (และควรแก้อีก ${warns} ข้อ)` : '')
    : warns ? `ใช้งานได้ แต่ควรแก้ ${warns} ข้อ` : 'พร้อมใช้งานจริง 🎉';
  window.showAlert(head, lines.join('\n'), fails > 0);
};
