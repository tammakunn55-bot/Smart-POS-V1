/* =============================================================================
 * js/auth/session.js
 * ข้อมูลในเครื่อง (บันทึก/โหลดผ่าน posStore → IndexedDB), สิทธิ์ใช้งาน (canDo), จัดการพนักงาน, ล็อกอินด้วย PIN, ล็อกเครื่อง/ล็อกอัตโนมัติ
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * ensure, persist, canDo, openUserManagerModal, renderUserManagerList, editUser, saveUser,
 * deleteUser, migratePlaintextPins, renderEmployeeLoginScreen, selectEmployeeForLogin,
 * backToEmployeeSelect, renderPinDots, pinPadInput, pinPadBackspace, pinPadClear,
 * verifyEmployeePin, lockPOS, updateActiveUserBadge, resetIdleTimer
 * ============================================================================= */


/* Enterprise Management Repair Layer */
(function(){
const esc=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const sb=()=>window.getSupabase?.()||null;
const rolePerm=r=>r==='OWNER'?['ALL']:r==='MANAGER'?['SALE','RETURN','PRODUCT_CREATE','PRODUCT_EDIT','PRODUCT_DELETE','PURCHASE_ORDER','GOODS_RECEIPT','REPORTS']:['SALE'];
function ensure(){if(!window.db)return;db.users=db.users||[];if(!db.users.some(u=>u.role==='OWNER'))db.users.unshift({id:'owner-local',name:'เจ้าของร้าน',needsPinSetup:true,role:'OWNER',permissions:['ALL'],protected:true});db.users.forEach(u=>{u.role=u.role||'CASHIER';u.permissions=u.permissions||rolePerm(u.role);if(u.role==='MANAGER'&&!u.permissions.includes('RETURN'))u.permissions.push('RETURN');});window.migratePlaintextPins?.();}
window.ensure = ensure; // เพิ่มขึ้นมา: ให้สคริปต์บล็อกอื่น (เช่นตัวช่วยตั้งค่าเริ่มต้น) เรียกใช้ได้ด้วย ของเดิม scope ปิดอยู่ในนี้ที่เดียว
// BUG FIX: this used to persist only {users, suppliers, purchaseOrders, cashLedger} to
// localStorage. Everything else — every sale (db.bills), every stock/product change
// (db.products), every customer & their debt (db.customers), categories, store settings —
// was NEVER saved locally at all. With no Supabase connection configured (fully optional),
// a page refresh or the browser tab being killed silently wiped out an entire day's sales.
// Now the whole db object is persisted as one blob, matching the "Offline-First" behavior
// the manual describes.
// BUG FIX (#5): เดิมถ้า localStorage เต็ม (ง่ายมากถ้ามีรูปสินค้าเป็น base64 ปนอยู่เยอะๆ — ดู
// bulk image import fallback) จะ catch เงียบๆ แค่ console.warn ผู้ใช้เห็น toast "บันทึกการขาย
// สำเร็จ" ตามปกติ ทั้งที่ข้อมูลไม่ถูกเขียนลงเครื่องเลยจริงๆ — เพิ่ม throttle กันเด้งซ้ำถี่เกินไป
// (ครั้งต่อไปห่างกันอย่างน้อย 10 วิ) แล้วโชว์ alert ที่มองเห็นได้จริงแทน
let _persistFailAlertAt = 0;
function persist(){
  try{
    window.posStore.save(db);   // v11: IndexedDB (เขียนแบบ debounce, บิลเขียนเฉพาะที่เปลี่ยน)
  }catch(e){
    console.warn('persist failed (localStorage full or blocked)',e);
    const now = Date.now();
    if (now - _persistFailAlertAt > 10000) {
      _persistFailAlertAt = now;
      window.showAlert
        ? window.showAlert('⚠️ บันทึกข้อมูลไม่สำเร็จ', 'พื้นที่จัดเก็บข้อมูลในเครื่องเต็ม หรือถูกบล็อก — ข้อมูลล่าสุดอาจไม่ถูกบันทึก กรุณาลบรูปภาพ/ข้อมูลเก่าที่ไม่ใช้แล้ว หรือสำรองข้อมูลด่วน', true)
        : alert('⚠️ บันทึกข้อมูลไม่สำเร็จ: พื้นที่จัดเก็บข้อมูลในเครื่องเต็มหรือถูกบล็อก');
    }
  }
}
try{
  const saved=window.__POS_SAVED__||null;   // v11: ตัวโหลด (IndexedDB) อ่านไว้ให้ก่อนรันสคริปต์ของแอป
  if(saved){ Object.assign(window.db||{}, saved); if(window.db)window.db.activeUser=null; }
  else { // migrate any older partial save so existing installs don't lose their data
    Object.assign(window.db||{}, JSON.parse(localStorage.getItem('pos_enterprise_state')||'{}'));
  }
}catch(e){}
window.persist=persist;
window.posStore.onError=function(e){   // เขียน IndexedDB ไม่สำเร็จ (พื้นที่เต็ม/ถูกบล็อก) — ต้องให้ผู้ใช้เห็นจริง ไม่ใช่เงียบ
  console.warn('persist failed',e);
  const now=Date.now();
  if(now-_persistFailAlertAt>10000){_persistFailAlertAt=now;
    window.showAlert?window.showAlert('⚠️ บันทึกข้อมูลไม่สำเร็จ','พื้นที่จัดเก็บข้อมูลในเครื่องเต็ม หรือถูกบล็อก — ข้อมูลล่าสุดอาจไม่ถูกบันทึก กรุณาสำรองข้อมูลด่วน',true):alert('⚠️ บันทึกข้อมูลไม่สำเร็จ');}
};
window.canDo=p=>{ensure();const u=db.activeUser||((db.users||[]).some(x=>x.pinHash)?null:db.users.find(x=>x.role==='OWNER'));return !!u&&(u.role==='OWNER'||u.permissions?.includes('ALL')||u.permissions?.includes(p));};
const ok=p=>window.canDo(p)||(window.showAlert?.('ไม่มีสิทธิ์','บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้',true),false);
ensure();

window.openUserManagerModal=window.switchSettingsTab?()=>window.switchSettingsTab('USERS'):function(){};
window.renderUserManagerList=function(){ensure();const c=document.getElementById('user-manager-list');if(!c)return;c.innerHTML=db.users.map(u=>`<div class="bg-slate-50 p-3 rounded-xl border flex justify-between"><div><b>${esc(u.name)}</b><span class="block text-[10px] text-indigo-600">${u.role==='OWNER'?'เจ้าของร้าน':u.role==='MANAGER'?'ผู้จัดการ':'พนักงานขาย'}</span></div><div class="flex gap-2"><button onclick="window.editUser('${u.id}')" class="text-indigo-600 font-bold">แก้ไข</button>${u.role==='OWNER'?'<span class="text-slate-400 text-[10px]">ป้องกันลบ</span>':`<button onclick="window.deleteUser('${u.id}')" class="text-rose-500 font-bold">ลบ</button>`}</div></div>`).join('');};
// NOTE: the PIN input is intentionally left blank when editing — pin_hash cannot be reversed
// back into the original PIN, so re-entering it is only required when actually changing it.
window.editUser=id=>{const u=db.users.find(x=>x.id===id);if(!u)return;document.getElementById('edit-user-id').value=id;document.getElementById('user-name-input').value=u.name;document.getElementById('user-pin-input').value='';document.getElementById('user-pin-input').placeholder='ใส่ PIN ใหม่ (เว้นว่างไว้ถ้าไม่เปลี่ยน)';let r=document.getElementById('user-role-input');if(!r){r=document.createElement('select');r.id='user-role-input';r.className='w-full border p-2 rounded-xl text-xs';r.innerHTML='<option value="CASHIER">พนักงานขาย</option><option value="MANAGER">ผู้จัดการ</option><option value="OWNER">เจ้าของร้าน</option>';document.getElementById('user-pin-input').insertAdjacentElement('afterend',r);}r.value=u.role;};
// BUG FIX (security): PINs were stored and would have been synced to Supabase as plaintext —
// anyone with the anon key could read every employee's PIN straight out of the database.
// Now only a SHA-256 hash (window.hashPin) is ever stored in db.users[].pinHash / sent as
// app_users.pin; the raw digits never leave the input field.
window.saveUser=async function(){if(!ok('ALL'))return;ensure();const id=document.getElementById('edit-user-id').value,n=document.getElementById('user-name-input').value.trim(),pin=document.getElementById('user-pin-input').value.trim(),role=document.getElementById('user-role-input')?.value||'CASHIER';if(!n)return window.showAlert?.('ข้อมูลไม่ถูกต้อง','กรุณากรอกชื่อพนักงาน',true);if(pin&&!/^\d{4}$/.test(pin))return window.showAlert?.('ข้อมูลไม่ถูกต้อง','PIN ต้องเป็นตัวเลข 4 หลัก',true);if(pin&&window.WEAK_PINS.includes(pin))return window.showAlert?.('PIN เดาง่ายเกินไป','เลือก PIN ที่ไม่ใช่เลขซ้ำ/เรียงกัน (เช่น 0000, 1234)',true);if(id){const u=db.users.find(x=>x.id===id);if(u.role==='OWNER'&&role!=='OWNER')return window.showAlert?.('ไม่อนุญาต','ไม่สามารถลดสิทธิ์เจ้าของร้านได้',true);const upd={name:n,role,permissions:rolePerm(role)};if(pin)upd.pinHash=await window.makePinHash(pin);delete u.pin;Object.assign(u,upd);}else{if(!pin)return window.showAlert?.('ข้อมูลไม่ถูกต้อง','กรุณากำหนด PIN 4 หลักให้พนักงานใหม่',true);db.users.push({id:'u-'+Date.now(),name:n,role,permissions:rolePerm(role),pinHash:await window.makePinHash(pin)});}persist();window.renderUserManagerList();window.renderEmployeeLoginScreen?.();};
window.deleteUser=id=>{if(!ok('ALL'))return;const u=db.users.find(x=>x.id===id);if(!u||u.role==='OWNER')return window.showAlert?.('ไม่อนุญาต','ไม่สามารถลบเจ้าของร้านได้',true);db.users=db.users.filter(x=>x.id!==id);persist();window.renderUserManagerList();window.renderEmployeeLoginScreen?.();};

// Migrates any legacy plaintext `pin` field (from before this fix, including the hardcoded
// '0000' owner default) into a hashed `pinHash`, one time, so nothing plaintext lingers in
// memory/localStorage/Supabase going forward.
window.migratePlaintextPins=async function(){let changed=false;for(const u of (db.users||[])){if(u.pin&&!u.pinHash){u.pinHash=await window.makePinHash(u.pin);delete u.pin;changed=true;}}if(changed)persist();};

// ==========================================
// EMPLOYEE PIN LOGIN / LOCK SCREEN
// ==========================================
let _loginSelectedUserId=null, _loginPinBuffer='';

window.renderEmployeeLoginScreen=function(){
  ensure();
  const el=document.getElementById('login-employee-select');
  if(!el)return;
  el.innerHTML=(db.users||[]).map(u=>`
    <button onclick="window.selectEmployeeForLogin('${u.id}')" class="w-full flex items-center gap-3 p-3 bg-slate-50 hover:bg-indigo-50 rounded-2xl border text-left btn-touch transition-colors">
      <span class="w-10 h-10 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center font-black flex-shrink-0">${esc((u.name||'?').charAt(0))}</span>
      <div><b class="block text-sm text-slate-800">${esc(u.name)}</b><span class="text-[10px] text-slate-400">${u.role==='OWNER'?'เจ้าของร้าน':u.role==='MANAGER'?'ผู้จัดการ':'พนักงานขาย'}</span></div>
    </button>
  `).join('');
  const nameEl=document.getElementById('login-store-name');
  if(nameEl)nameEl.innerText=db.storeName||'Smart POS';
};

window.selectEmployeeForLogin=function(id){
  _loginSelectedUserId=id; _loginPinBuffer='';
  const u=db.users.find(x=>x.id===id);
  document.getElementById('login-selected-name').innerText=u?(u.needsPinSetup&&!u.pinHash?u.name+' — ตั้ง PIN ใหม่ 4 หลัก':u.name):'';_pinSetupFirst=null;
  document.getElementById('login-employee-select').classList.add('hidden');
  document.getElementById('login-pin-pad').classList.remove('hidden');
  document.getElementById('login-pin-error').classList.add('hidden');
  window.renderPinDots();
};

window.backToEmployeeSelect=function(){
  _loginSelectedUserId=null; _loginPinBuffer='';
  document.getElementById('login-pin-pad').classList.add('hidden');
  document.getElementById('login-employee-select').classList.remove('hidden');
};

window.renderPinDots=function(){
  document.querySelectorAll('#login-pin-pad .pin-dot').forEach((dot,i)=>{
    dot.classList.toggle('bg-indigo-600',i<_loginPinBuffer.length);
    dot.classList.toggle('bg-slate-200',i>=_loginPinBuffer.length);
  });
};

window.pinPadInput=function(digit){
  if(_loginPinBuffer.length>=4)return;
  _loginPinBuffer+=digit;
  window.renderPinDots();
  if(_loginPinBuffer.length===4)window.verifyEmployeePin();
};
window.pinPadBackspace=function(){_loginPinBuffer=_loginPinBuffer.slice(0,-1);window.renderPinDots();};
window.pinPadClear=function(){_loginPinBuffer='';window.renderPinDots();};

let _pinFails = {}, _pinSetupFirst = null;
try { _pinFails = JSON.parse(localStorage.getItem('pos_pin_fails') || '{}') || {}; } catch (e) { _pinFails = {}; }   // เก็บไว้ข้ามการรีโหลด (กันรีเฟรชเพื่อเลี่ยงการพักล็อกอิน)
const _savePinFails = () => { try { localStorage.setItem('pos_pin_fails', JSON.stringify(_pinFails)); } catch (e) { /* ignore */ } };
  window.verifyEmployeePin = async function(){
    const u = db.users.find(x => x.id === _loginSelectedUserId);
    if (!u) return;
    const errEl = document.getElementById('login-pin-error');
    const showErr = (msg) => {
      if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); setTimeout(() => errEl.classList.add('hidden'), 2500); }
      _loginPinBuffer = ''; window.renderPinDots?.();
    };
    const pin = _loginPinBuffer;
    if (u.needsPinSetup && !u.pinHash) {            // ติดตั้งใหม่: ไม่มี PIN เริ่มต้น ต้องตั้งเองก่อนใช้งาน
      if (window.WEAK_PINS.includes(pin)) return showErr('PIN เดาง่ายเกินไป เลือกเลขอื่น');
      if (!_pinSetupFirst) {
        _pinSetupFirst = pin; _loginPinBuffer = ''; window.renderPinDots?.();
        document.getElementById('login-selected-name').innerText = u.name + ' — กรอก PIN อีกครั้งเพื่อยืนยัน';
        return;
      }
      if (_pinSetupFirst !== pin) {
        _pinSetupFirst = null;
        document.getElementById('login-selected-name').innerText = u.name + ' — ตั้ง PIN ใหม่ 4 หลัก';
        return showErr('PIN ทั้งสองครั้งไม่ตรงกัน เริ่มใหม่');
      }
      u.pinHash = await window.makePinHash(pin); delete u.needsPinSetup; _pinSetupFirst = null; window.persist?.();
    } else {
      const f = _pinFails[u.id] || { n: 0, until: 0 };
      if (Date.now() < f.until) return showErr('ลองผิดหลายครั้ง รออีก ' + Math.ceil((f.until - Date.now()) / 1000) + ' วินาที');
      if (!(await window.verifyPinHash(pin, u.pinHash))) {
        f.n++; if (f.n >= 5) f.until = Date.now() + Math.min(300000, 15000 * Math.pow(2, f.n - 5));
        _pinFails[u.id] = f; _savePinFails();
        return showErr(f.n >= 5 ? 'ลองผิดหลายครั้ง ถูกพักการล็อกอินชั่วคราว' : 'PIN ไม่ถูกต้อง');
      }
      if (_pinFails[u.id]) { delete _pinFails[u.id]; _savePinFails(); }
      if (u.pinHash && !u.pinHash.startsWith('pbkdf2$') && window.crypto && crypto.subtle) { u.pinHash = await window.makePinHash(pin); window.persist?.(); }   // อัปเกรด hash เก่าเป็น PBKDF2
    }
    const weak = window.WEAK_PINS.includes(pin);
    db.activeUser = u;
    _loginPinBuffer = '';
    document.getElementById('screen-employee-login').classList.add('hidden');
    window.resetIdleTimer?.();
    window.updateActiveUserBadge?.();
    window.showToast?.(`สวัสดี ${u.name} 👋`);
    window.afterLocalLogin?.(u, pin);   // v11: ล็อกอินบัญชีรายพนักงานบนเซิร์ฟเวอร์ (ถ้าเปิดใช้) ไม่บล็อกหน้าจอ
    if (weak) window.showAlert?.('⚠️ PIN เดาง่าย', 'บัญชีนี้ใช้ PIN ที่เดาง่าย กรุณาเปลี่ยนที่ ตั้งค่า > ผู้ใช้งาน', true);
  };

  window.lockPOS=function(){
  db.activeUser=null;
  window.backToEmployeeSelect();
  window.renderEmployeeLoginScreen();
  document.getElementById('screen-employee-login').classList.remove('hidden');
  window.updateActiveUserBadge?.();
};

window.updateActiveUserBadge=function(){
  const el=document.getElementById('active-user-badge');
  if(el)el.innerText=db.activeUser?`👤 ${db.activeUser.name}`:'';
};

// Auto-lock after 10 minutes idle — protects against a cashier walking away from an
// unlocked terminal. Any click/touch/keypress resets the timer.
let _idleTimer=null;
window.resetIdleTimer=function(){
  clearTimeout(_idleTimer);
  if(db.activeUser){
    _idleTimer=setTimeout(()=>{window.lockPOS();window.showToast?.('ล็อกหน้าจออัตโนมัติเนื่องจากไม่มีการใช้งาน');},10*60*1000);
  }
};
['click','touchstart','keydown'].forEach(evt=>document.addEventListener(evt,()=>window.resetIdleTimer?.()));

document.addEventListener('DOMContentLoaded',()=>{setTimeout(()=>window.renderEmployeeLoginScreen?.(),0);});

})();   // ปิด IIFE ที่เปิดไว้ด้านบนของไฟล์นี้
