// สร้างสภาพแวดล้อมจำลอง (vm) แล้วโหลดโมดูล v10 + helper จริงจาก public/index.html มาทดสอบ
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');

const PUBLIC = path.join(__dirname, '..', 'public');
const INDEX = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const manifest = () => JSON.parse(INDEX.match(/<script id="pos-manifest"[^>]*>([\s\S]*?)<\/script>/)[1]);
const readJs = (rel) => fs.readFileSync(path.join(PUBLIC, rel), 'utf8');
// สคริปต์ของแอปทั้งหมดตามลำดับใน manifest (ไฟล์จริงบนดิสก์)
const appFiles = () => manifest().scripts.map((src) => ({ src, code: readJs(src) }));
const MODULES = { 'v10 — คิวซิงค์': 'js/sync/queue.js', 'v11 — ล็อกอินรายพนักงาน': 'js/sync/staff-auth.js' };

function extractFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('ไม่พบฟังก์ชัน ' + name);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1);
  }
  throw new Error('วงเล็บไม่ครบ ' + name);
}

function extractModule(marker = 'v10 — คิวซิงค์') {
  if (!MODULES[marker]) throw new Error('ไม่รู้จักโมดูล ' + marker);
  return readJs(MODULES[marker]);
}

function createEnv(opts = {}) {
  const store = {};
  const listeners = {};
  const calls = { rpc: [], upsert: [], persist: 0, syncProducts: 0 };
  const handlers = opts.rpc || {};
  const fns = opts.functions || {};
  calls.invoke = []; calls.verifyOtp = []; calls.signOut = 0;
  const client = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'auth-1' } } } }),
      verifyOtp: async (a) => { calls.verifyOtp.push(a); return { error: (opts.verifyOtpError || null) }; },
      signOut: async () => { calls.signOut++; return {}; }
    },
    functions: { invoke: async (name, o) => { calls.invoke.push({ name, body: o.body }); const f = fns[name]; return f ? f(o.body) : { data: null, error: { message: 'no handler' } }; } },
    rpc: async (name, args) => {
      calls.rpc.push({ name, args });
      const h = handlers[name];
      return h ? h(args) : { data: {}, error: null };
    },
    from: (table) => ({
      upsert: async (rows, o) => { calls.upsert.push({ table, rows, o }); return { error: null }; },
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.appUserRow || null }) }) })
    })
  };
  const ctx = {
    console, Intl, Date, Math, JSON, Array, Object, Number, String, parseFloat, parseInt, isFinite,
    Uint8Array, TextEncoder, Promise, Set, Map, RegExp, Error, TypeError,
    setTimeout: () => 0, setInterval: () => 0,
    document: { getElementById: () => null },
    navigator: { onLine: true },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    crypto: nodeCrypto.webcrypto,
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  const run = (code) => vm.runInContext(code, ctx);

  run(`
    const roundAmt = (num) => { const n = parseFloat(num) || 0; return Number(Math.round(Number(n + 'e2')) + 'e-2'); };
    const roundStock = (num) => { const n = parseFloat(num) || 0; return Number(Math.round(Number(n + 'e4')) + 'e-4'); };
  `);
  run(extractFn(readJs('js/core/helpers.js'), 'fnv1a'));
  run(extractFn(readJs('js/core/helpers.js'), 'toUUID'));
  run('var db = { users: [], bills: [], products: {}, customers: {}, shifts: [], cashLedger: [], purchaseOrders: [], suppliers: {}, syncQueue: [], settings: {} };');
  ctx.window.getSupabaseClient = () => client;
  ctx.window.persist = () => { calls.persist++; };
  ctx.window.showAlert = () => {};
  ctx.window.syncProductsToSupabase = async () => { calls.syncProducts++; return true; };
  ctx.window.hashPin = async (pin) => nodeCrypto.createHash('sha256').update(String(pin)).digest('hex');   // เลียนแบบ hash รุ่นเดิม
  ctx.window.lockPOS = function () { calls.locked = (calls.locked || 0) + 1; };
  ctx.window.refreshAuthStatus = async function () {};
  ctx.window.posStore = { save() {}, touchBill() {}, flush: async () => {}, authStorage: {} };
  run(extractModule().split('// ---- boot')[0]);
  run(extractModule('v11 — ล็อกอินรายพนักงาน'));
  const fire = async (type) => { for (const f of (listeners[type] || [])) await f(); };
  return { ctx, run, calls, client, listeners, fire, db: () => ctx.db || run('db') };
}
module.exports = { createEnv, extractFn, extractModule, appFiles, readJs, manifest, INDEX };
