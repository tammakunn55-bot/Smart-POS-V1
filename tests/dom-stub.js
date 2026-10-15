// DOM จำลองแบบ "รับทุกอย่าง": element ที่ไม่มีอยู่จริงก็เรียกเมธอด/อ่านพร็อพเพอร์ตี้ได้โดยไม่ error (ใช้ทดสอบ logic ที่ไม่เกี่ยวกับหน้าตา)
function dummy() {
  const f = function () {};
  return new Proxy(f, {
    get: (t, k) => {
      if (k === Symbol.toPrimitive) return () => '';
      if (['value', 'innerText', 'innerHTML', 'textContent'].includes(k)) return t[k] ?? '';
      if (k === 'checked') return !!t.checked;
      if (['style', 'classList', 'dataset', 'files'].includes(k)) return dummy();
      if (k === 'length') return 0;
      if (k === 'then') return undefined;
      return t[k] !== undefined ? t[k] : dummy();
    },
    set: (t, k, v) => { t[k] = v; return true; },
    apply: () => dummy(), construct: () => dummy()
  });
}

module.exports = { dummy };
