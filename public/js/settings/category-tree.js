/* =============================================================================
 * js/settings/category-tree.js
 * โครงสร้างหมวดหมู่อ้างอิงจากเว็บ YOJIONLINE และการสร้างหมวดตั้งต้น
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * seedYojiCategories
 * ============================================================================= */

// ==========================================
// หมวดหมู่สินค้าอ้างอิงจากเว็บ YOJIONLINE.com (โครงสร้าง "หมวดหมู่สินค้า" จริงบนเว็บ
// ณ วันที่บันทึกหน้าเว็บไว้ — 13 หมวดหลัก พร้อมหมวดย่อย) ใช้เป็นชุดหมวดหมู่ตั้งต้นของระบบ
// แทนที่จะให้ db.categories ว่างเปล่าแล้วต้องมาสร้างเองทีละหมวด — ให้ผังหมวดหมู่ในโปรแกรม
// "หน้าตา" ตรงกับผังหมวดหมู่บนเว็บตั้งแต่แรก (ชุดเดียวกับที่ 418.sql seed ไว้ฝั่ง Supabase)
// ==========================================
const YOJI_CATEGORY_TREE = [
  { name: 'ท่อพีวีซี', icon: '🔵', color: '#0ea5e9', children: [
    { name: 'ท่อพีวีซีสีฟ้า' }, { name: 'ท่อพีวีซีสีเหลือง' }, { name: 'ท่อพีวีซีสีขาว' }
  ]},
  { name: 'อุปกรณ์ท่อพีวีซี', icon: '🔧', color: '#0ea5e9', children: [
    { name: 'อุปกรณ์ท่อสีฟ้า' }, { name: 'อุปกรณ์ท่อสีเหลือง' }, { name: 'อุปกรณ์ท่อสีขาว' }
  ]},
  { name: 'อุปกรณ์ประปา ห้องน้ำ', icon: '🚿', color: '#06b6d4', children: [
    { name: 'ก๊อกน้ำ' }, { name: 'กาวทาท่อ เทป' }, { name: 'บอลวาวล์ ประตูน้ำ' },
    { name: 'ฝักบัว สายฉีดชำระ' }, { name: 'อุปกรณ์ประปาอื่นๆ' }
  ]},
  { name: 'อุปกรณ์ก่อสร้าง', icon: '🧱', color: '#a16207', children: [
    { name: 'อุปกรณ์ทำความสะอาด' }, { name: 'วัสดุก่อสร้าง' }
  ]},
  { name: 'น๊อต สกรู แหวน', icon: '🔩', color: '#64748b', children: [] },
  { name: 'สี อุปกรณ์ทาสี', icon: '🎨', color: '#ec4899', children: [
    { name: 'สีน้ำ สีทาบ้าน สีทาอาคาร' }, { name: 'สีสเปรย์ สีพ่นพิเศษ' }, { name: 'สีน้ำมัน สีทาเหล็ก' },
    { name: 'สีทาไม้ น้ำมันทาไม้' }, { name: 'เคมีภัณฑ์ ซ่อมแซม' }, { name: 'อุปกรณ์ทาสี' }, { name: 'ทินเนอร์ น้ำมันสน' }
  ]},
  { name: 'เครื่องมือช่าง ฮาร์ดแวร์', icon: '🛠️', color: '#4f46e5', children: [
    { name: 'เทปกาว กาว ซิลิโคน' }, { name: 'เครื่องมือช่าง' }, { name: 'ใบตัด ใบเจียร์ กระดาษทราย' },
    { name: 'เครื่องมือเชื่อม' }, { name: 'กุญแจ ลูกบิด' }, { name: 'เครื่องเขียน' }, { name: 'เครื่องมือเจาะ ดอกสว่าน' }
  ]},
  { name: 'เครื่องมือเกษตรและสวน', icon: '🌱', color: '#16a34a', children: [] },
  { name: 'เครื่องมือไฟฟ้า', icon: '⚡', color: '#eab308', children: [] },
  { name: 'สายไฟ', icon: '🔌', color: '#f59e0b', children: [] },
  { name: 'อุปกรณ์ไฟฟ้า', icon: '💡', color: '#f59e0b', children: [
    { name: 'หลอดไฟ' }, { name: 'อุปกรณ์ไฟฟ้าอื่นๆ' }
  ]},
  { name: 'ท่ออุปกรณ์เหล็กร้อยสายไฟ', icon: '🪛', color: '#78716c', children: [
    { name: 'ท่อเหล็กร้อยสายไฟ' }, { name: 'อุปกรณ์ท่อเหล็กร้อยสายไฟ' }
  ]},
  { name: 'ชั้นวางสินค้า', icon: '🗄️', color: '#78716c', children: [] },
  // ไม่มีอยู่ในผังหมวดหมู่จริงของเว็บ — เก็บสินค้าที่จับคู่หมวดหมู่จากเว็บไม่ได้ไว้ที่นี่ก่อน
  // (มาจากคอลัมน์ "อื่นๆ" ของไฟล์นำเข้า) ต้องเข้าไปแยกหมวดที่ถูกต้องเองทีหลัง
  { name: 'อื่นๆ', icon: '📦', color: '#94a3b8', children: [] }
];

// สร้างหมวดหมู่ตามผัง YOJI_CATEGORY_TREE ลงใน db.categories — ทำงานแบบ idempotent
// (เช็กชื่อซ้ำก่อนเสมอ ไม่สร้างหมวดซ้ำถ้ามีอยู่แล้ว เช่น ผู้ใช้เคยสร้าง/แก้เองมาก่อน)
window.seedYojiCategories = function() {
  db.categories = db.categories || [];
  const byName = name => db.categories.find(c => c.name === name);
  YOJI_CATEGORY_TREE.forEach(top => {
    let parent = byName(top.name);
    if (!parent) {
      parent = { id: 'cat-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: top.name, icon: top.icon, color: top.color, parentId: null };
      db.categories.push(parent);
    }
    (top.children || []).forEach(child => {
      if (!byName(child.name)) {
        db.categories.push({ id: 'cat-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: child.name, icon: top.icon, color: top.color, parentId: parent.id });
      }
    });
  });
  return new Set(db.categories.map(c => c.name));
};
