/* =============================================================================
 * js/settings/setup-wizard.js
 * วิซาร์ดตั้งค่าครั้งแรก (ชื่อเจ้าของ/PIN, เชื่อมคลาวด์)
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * maybeShowSetupWizard, wizardSaveWelcome, wizardGoCloudSetup, wizardShowGuide,
 * wizardGoToSettings, wizardFinish, reopenSetupWizard
 * ============================================================================= */


/* ==========================================
   FIRST-LAUNCH SETUP WIZARD
   เด้งอัตโนมัติตอนเปิดแอปครั้งแรก (db.setupWizardDone ยังไม่ true) คุมลำดับขั้นตอนที่ถูกต้อง:
   1) ตั้งชื่อร้าน + PIN เจ้าของร้าน (แทนที่ default "0000" ที่ไม่มีที่ไหนบอกไว้เลย)
   2) ถามว่าจะเชื่อมต่อ Supabase ไหม
   3) ถ้าเชื่อม ถามว่าเครื่องแรกหรือเครื่องเพิ่มเติม แล้วชี้ขั้นตอนที่ถูกต้องให้ตรงเคส
   ========================================== */
(function(){
  function showStep(id){
    ['wizard-step-welcome','wizard-step-cloud','wizard-step-which-device','wizard-step-guide-first','wizard-step-guide-additional','wizard-step-finish']
      .forEach(s => document.getElementById(s)?.classList.toggle('hidden', s !== id));
  }

  window.maybeShowSetupWizard = function(){
    window.ensure?.(); // ให้แน่ใจว่า db.users มี default owner แล้วก่อนเช็ค
    if (db.setupWizardDone) return;
    showStep('wizard-step-welcome');
    document.getElementById('wizard-store-name').value = db.storeName || '';
    const m = document.getElementById('modal-setup-wizard');
    m.classList.remove('hidden'); m.classList.add('flex');
  };

  window.wizardSaveWelcome = async function(){
    const name = document.getElementById('wizard-store-name').value.trim();
    const pin = document.getElementById('wizard-owner-pin').value.trim();
    const pin2 = document.getElementById('wizard-owner-pin2').value.trim();
    if (!name) return window.showAlert?.('ข้อมูลไม่ครบ', 'กรุณากรอกชื่อร้าน', true);
    if (!/^\d{4}$/.test(pin)) return window.showAlert?.('ข้อมูลไม่ถูกต้อง', 'PIN ต้องเป็นตัวเลข 4 หลัก', true);
    if (window.WEAK_PINS.includes(pin)) return window.showAlert?.('PIN เดาง่ายเกินไป', 'เลือก PIN ที่ไม่ใช่เลขซ้ำ/เรียงกัน (เช่น 0000, 1234)', true);
    if (pin !== pin2) return window.showAlert?.('PIN ไม่ตรงกัน', 'กรุณากรอก PIN ทั้งสองช่องให้ตรงกัน', true);

    db.storeName = name;
    window.ensure?.();
    const owner = db.users.find(u => u.role === 'OWNER') || db.users[0];
    if (owner) {
      owner.name = owner.name === 'เจ้าของร้าน' ? name : owner.name;
      owner.pinHash = await window.makePinHash(pin);
      delete owner.pin;
    }
    window.persist?.();
    window.renderEmployeeLoginScreen?.();
    showStep('wizard-step-cloud');
  };

  window.wizardGoCloudSetup = function(){ showStep('wizard-step-which-device'); };

  window.wizardShowGuide = function(kind){
    showStep(kind === 'first' ? 'wizard-step-guide-first' : 'wizard-step-guide-additional');
  };

  window.wizardGoToSettings = function(){
    window.wizardFinish(false); // ปิด wizard แต่ยังไม่ต้อง toast จบ เพราะกำลังจะไปทำต่อที่ตั้งค่า
    window.openMasterSettingsModal?.('DATABASE');
  };

  window.wizardFinish = function(showDone){
    if (showDone !== false) showStep('wizard-step-finish');
    db.setupWizardDone = true;
    window.persist?.();
    if (showDone === false) {
      document.getElementById('modal-setup-wizard').classList.add('hidden');
      document.getElementById('modal-setup-wizard').classList.remove('flex');
    }
  };

  window.reopenSetupWizard = function(){
    db.setupWizardDone = false;
    window.maybeShowSetupWizard();
  };

  // หน่วงเล็กน้อยให้ ensure()/renderEmployeeLoginScreen ของสคริปต์อื่นทำงานก่อน กัน race ตอนโหลดหน้าแรก
  document.addEventListener('DOMContentLoaded', () => setTimeout(() => window.maybeShowSetupWizard(), 300));
})();
