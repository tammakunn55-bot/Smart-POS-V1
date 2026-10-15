/* =============================================================================
 * js/core/state.js
 * ข้อมูลหลักของแอปในหน่วยความจำ (db) และตัวแปรสถานะของหน้าจอ (ตะกร้า หมวดที่เลือก ฯลฯ)
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * db, cart
 * ============================================================================= */

// GLOBAL STATE DB
let db = {
  storeName: "",
  storeAddress: "",
  promptPayId: "",
  categories: [],
  products: {},
  customers: {},
  suppliers: {},
  users: [],
  bills: [], cashLedger: [], counters: { dailyBillNum: 0, lastBillDate: "" }
};

let cart = [];
let activeCategory = null;
let activePayMethod = 'CASH';
let stockSortBy = 'name';
let stockSortDir = 'asc';
let poTempItems = [];
let pendingImportList = [];
let scanner = null;

window.db = db;
window.cart = cart;
