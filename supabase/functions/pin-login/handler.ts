// pin-login: พนักงานส่ง {user_id, pin} → ตรวจ PIN → คืน token_hash ให้แอปนำไป verifyOtp เป็น session ของ "พนักงานคนนั้น"
// แยกจาก index.ts เพื่อให้ทดสอบด้วย Node ได้ (ไม่มี import แบบ npm:/jsr: ของ Deno ในไฟล์นี้)
import { verifyPin } from './pin.ts';

export interface AppUserRow {
  id: string; name: string; pin: string; role: string; is_active: boolean;
  auth_user_id: string | null; login_email: string | null;
  failed_pin_attempts: number | null; locked_until: string | null;
}
export interface Deps {
  now: () => number;
  staffEmailDomain: string;
  getAppUser: (id: string) => Promise<AppUserRow | null>;
  updateAppUser: (id: string, patch: Record<string, unknown>) => Promise<void>;
  getAuthEmail: (authUserId: string) => Promise<string | null>;
  createAuthUser: (email: string, password: string, appUserId: string) => Promise<string>;   // คืน auth user id
  generateToken: (email: string) => Promise<string>;                                          // คืน hashed_token
  randomPassword: () => string;
}

export const MAX_ATTEMPTS = 5;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  let body: { user_id?: unknown; pin?: unknown };
  try { body = await req.json(); } catch { return json(400, { error: 'bad_request' }); }
  const userId = String(body.user_id ?? ''), pin = String(body.pin ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId) || !/^\d{4,6}$/.test(pin)) {
    return json(400, { error: 'bad_request' });
  }

  const user = await deps.getAppUser(userId);
  // ไม่บอกว่า "ไม่มีผู้ใช้" กับ "PIN ผิด" ต่างกัน — ตอบเหมือนกัน
  if (!user || !user.is_active) return json(401, { error: 'invalid_credentials' });

  const now = deps.now();
  if (user.locked_until && Date.parse(user.locked_until) > now) {
    return json(429, { error: 'locked', retry_after_s: Math.ceil((Date.parse(user.locked_until) - now) / 1000) });
  }

  if (!(await verifyPin(pin, user.pin))) {
    const attempts = (user.failed_pin_attempts ?? 0) + 1;
    const patch: Record<string, unknown> = { failed_pin_attempts: attempts };
    if (attempts >= MAX_ATTEMPTS) {   // 30 วิ, 1 นาที, 2 นาที ... สูงสุด 15 นาที
      const wait = Math.min(15 * 60_000, 30_000 * 2 ** (attempts - MAX_ATTEMPTS));
      patch.locked_until = new Date(now + wait).toISOString();
    }
    await deps.updateAppUser(user.id, patch);
    return json(401, { error: 'invalid_credentials', attempts_left: Math.max(0, MAX_ATTEMPTS - attempts) });
  }

  // PIN ถูก → ล้างตัวนับ และเตรียมบัญชี auth ของพนักงาน (สร้างครั้งแรกเมื่อยังไม่มี)
  let email: string | null = null;
  if (user.auth_user_id) email = user.login_email ?? (await deps.getAuthEmail(user.auth_user_id));
  if (!email) {
    if (user.auth_user_id) return json(500, { error: 'auth_user_missing_email' });
    email = `staff-${user.id}@${deps.staffEmailDomain}`;
    const authId = await deps.createAuthUser(email, deps.randomPassword(), user.id);
    await deps.updateAppUser(user.id, { auth_user_id: authId, login_email: email, failed_pin_attempts: 0, locked_until: null });
  } else {
    await deps.updateAppUser(user.id, { failed_pin_attempts: 0, locked_until: null });
  }

  const tokenHash = await deps.generateToken(email);
  return json(200, { token_hash: tokenHash, email, user: { id: user.id, name: user.name, role: user.role } });
}
