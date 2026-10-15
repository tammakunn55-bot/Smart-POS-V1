// สภาพแวดล้อมจำลองสำหรับรันโค้ดแอปจริง (ทุกไฟล์ใน manifest) ใน vm พร้อม DOM จำลอง — ใช้ร่วมกันในหลายไฟล์เทสต์
const vm = require('node:vm');
const { appFiles } = require('./harness');
const { dummy } = require('./dom-stub');
const blocks = appFiles().map((f) => f.code);

function boot() {
  const store = {};
  const els = {};
  const ctx = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    Intl, Date, Math, JSON, Array, Object, Number, String, parseFloat, parseInt, isFinite, isNaN, Uint8Array, TextEncoder,
    Promise, Set, Map, RegExp, Error, TypeError, encodeURIComponent, decodeURIComponent,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {}, requestAnimationFrame: () => 0,
    document: {
      getElementById: (id) => (els[id] = els[id] || dummy()), querySelector: () => dummy(), querySelectorAll: () => [],
      createElement: () => dummy(), addEventListener: () => {}, body: dummy(), documentElement: dummy(), head: dummy(), title: ''
    },
    navigator: { onLine: true, userAgent: 'node' },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    crypto: require('node:crypto').webcrypto, location: { protocol: 'http:', hostname: 'x', href: 'http://x/' },
    alert: (m) => { ctx.__alerts.push(m); }, confirm: () => true, prompt: () => '', fetch: async () => ({ ok: false, json: async () => ({}) }),
    XLSX: {}, Image: function () {}, FileReader: function () {}, Blob: function () {}, URL: { createObjectURL: () => '' },
    supabase: { createClient: () => null }, __alerts: []
  };
  ctx.window = ctx; ctx.self = ctx;
  ctx.posStore = { save() {}, touchBill() {}, flush: async () => {}, clear: async () => {}, replaceAll: async () => {}, authStorage: {} };
  ctx.addEventListener = () => {}; ctx.removeEventListener = () => {}; ctx.matchMedia = () => ({ matches: false, addEventListener() {} });
  vm.createContext(ctx);
  blocks.forEach((b, i) => vm.runInContext(b, ctx, { filename: 'block' + i }));
  const run = (code) => vm.runInContext(code, ctx);
  run(`
    db.products = { 'p-1': { id: 'p-1', name: 'ท่อ PVC', code: 'P1', cat: [], variants: [{ id: 'v-1', sizeName: 'ปกติ', stock: 10, cost: 300, price: 500, fractions: [] }] } };
    db.customers = { 'c-1': { id: 'c-1', name: 'ลูกค้า A', debt: 0, creditLimit: 5000 } };
    db.bills = []; db.cashLedger = []; db.syncQueue = []; db.returns = [];
    db.users = [{ id: 'u-1', name: 'แคชเชียร์', role: 'CASHIER', pinHash: 'x', permissions: [] }];
    db.activeUser = db.users[0];
    db.currentShift = { id: 'SHIFT-1', startTime: 1, endTime: null, openingCash: 0, movements: [] }; db.shifts = [db.currentShift];
  `);
  return { ctx, run, els };
}

function sell(env, { method = 'CASH', discount = '10', type = 'PERCENT', qty = 2, price = 500, customer = 'GENERAL' } = {}) {
  env.els['cart-discount-input'] = env.els['cart-discount-input'] || dummy();
  env.els['cart-discount-input'].value = discount;
  env.els['cart-discount-type'] = env.els['cart-discount-type'] || dummy();
  env.els['cart-discount-type'].value = type;
  env.els['pay-customer-select'] = env.els['pay-customer-select'] || dummy();
  env.els['pay-customer-select'].value = customer;
  env.run(`cart.length = 0; cart.push({ id: 'p-1', variantId: 'v-1', fractionId: null, name: 'ท่อ PVC', qty: ${qty}, price: ${price}, multiplier: 1 }); activePayMethod = '${method}';`);
  env.ctx.window.processPaymentRequest();
}

module.exports = { boot, sell, dummy };
