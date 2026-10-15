// Supabase Edge Function (Deno). Deploy:  supabase functions deploy pin-login
// ตัวแปรสภาพแวดล้อมที่ Supabase ใส่ให้อัตโนมัติ: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ตั้งเพิ่มได้ (ไม่บังคับ): STAFF_EMAIL_DOMAIN (ค่าเริ่มต้น staff.pos.invalid — ถ้า Auth ปฏิเสธโดเมนนี้ ให้ใช้โดเมนที่คุณเป็นเจ้าของ)
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { handle, type AppUserRow, type Deps } from './handler.ts';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const deps: Deps = {
  now: () => Date.now(),
  staffEmailDomain: Deno.env.get('STAFF_EMAIL_DOMAIN') ?? 'staff.pos.invalid',
  async getAppUser(id) {
    const { data, error } = await admin.from('app_users')
      .select('id,name,pin,role,is_active,auth_user_id,login_email,failed_pin_attempts,locked_until').eq('id', id).maybeSingle();
    if (error) throw error;
    return (data as AppUserRow | null) ?? null;
  },
  async updateAppUser(id, patch) {
    const { error } = await admin.from('app_users').update(patch).eq('id', id);
    if (error) throw error;
  },
  async getAuthEmail(authUserId) {
    const { data, error } = await admin.auth.admin.getUserById(authUserId);
    if (error) throw error;
    return data.user?.email ?? null;
  },
  async createAuthUser(email, password, appUserId) {
    const { data, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, app_metadata: { staff: true, app_user_id: appUserId },
    });
    if (error) throw error;
    return data.user.id;
  },
  async generateToken(email) {
    const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    if (error) throw error;
    return data.properties.hashed_token;
  },
  randomPassword: () => Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, '0')).join(''),
};

Deno.serve(async (req) => {
  try { return await handle(req, deps); }
  catch (e) {
    console.error('pin-login failed', e);
    return new Response(JSON.stringify({ error: 'server_error' }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
});
