// ตรวจ PIN ฝั่งเซิร์ฟเวอร์ — รูปแบบ hash ต้องตรงกับที่แอป (public/index.html) สร้าง:
//   pbkdf2$<รอบ>$<salt hex>$<hash hex>   (PBKDF2-SHA256, 256 บิต)   หรือ   sha256 hex 64 ตัว (รุ่นเก่า ไม่มี salt)
const MAX_ITER = 1_000_000;

const hex = (u8: Uint8Array): string => Array.from(u8).map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s: string): Uint8Array => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function verifyPin(pin: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored || typeof stored !== 'string') return false;
  const enc = new TextEncoder();
  if (stored.startsWith('pbkdf2$')) {
    const [, iterStr, saltHex, hashHex] = stored.split('$');
    const iter = parseInt(iterStr, 10);
    if (!(iter > 0 && iter <= MAX_ITER) || !/^[0-9a-f]+$/.test(saltHex ?? '') || !/^[0-9a-f]{64}$/.test(hashHex ?? '')) return false;
    const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: unhex(saltHex), iterations: iter, hash: 'SHA-256' }, key, 256);
    return safeEqual(hex(new Uint8Array(bits)), hashHex);
  }
  if (/^[0-9a-f]{64}$/.test(stored)) {
    const digest = await crypto.subtle.digest('SHA-256', enc.encode(pin));
    return safeEqual(hex(new Uint8Array(digest)), stored);
  }
  return false;   // รูปแบบอื่น (เช่น hash สำรองของเบราว์เซอร์ที่ไม่มี crypto.subtle) ตรวจฝั่งเซิร์ฟเวอร์ไม่ได้ → ต้องตั้ง PIN ใหม่
}
