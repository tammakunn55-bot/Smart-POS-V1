import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import pg from 'pg';
import crypto from 'node:crypto';
import { allocateBillDiscount } from './sale-math.js';
import { validateImportRows } from './product-import.js';
import { validatePurchaseOrderInput, validateReceiptItems } from './purchase-validation.js';
import { validateReturnInput } from './return-validation.js';
import { isValidCashAmount, reconcileCash } from './cash-shift.js';
import { validateReportRange } from './report-validation.js';
import { requiredPermission, isAllowed } from './authorization.js';
import { validateApprovalRequest, validateApprovalDecision } from './approval-validation.js';
import { validateCountCreate, validateCountQuantity, calculateCountDelta } from './inventory-count-validation.js';
import { validateSellUnit, convertToBaseQuantity } from './unit-conversion.js';

const { Pool } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Copy .env.example to .env and configure it.');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
const app = express();
const port = Number(process.env.PORT || 8787);
const sessionHours = Math.max(1, Number(process.env.SESSION_HOURS || 12));
const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin(origin, cb) { if (!origin || corsOrigins.includes(origin)) return cb(null, true); return cb(new Error('Origin not allowed')); }, allowedHeaders: ['Content-Type','Authorization','Idempotency-Key'], methods: ['GET','POST','PATCH','OPTIONS'] }));
app.use(express.json({ limit: '1mb' }));
app.use((req,res,next)=>{ req.requestId=crypto.randomUUID(); res.setHeader('X-Request-Id',req.requestId); next(); });
const loginLimiter = rateLimit({ windowMs: 15*60*1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: { code:'LOGIN_RATE_LIMIT', message:'เข้าสู่ระบบหลายครั้งเกินไป กรุณารอสักครู่' } } });
const asyncRoute = fn => (req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
function pinHash(pin) { const salt=crypto.randomBytes(16).toString('hex'); const derived=crypto.scryptSync(String(pin),salt,64).toString('hex'); return `scrypt$${salt}$${derived}`; }
function verifyPin(pin, stored) { try { const [alg,salt,expected]=stored.split('$'); if(alg!=='scrypt')return false; const actual=crypto.scryptSync(String(pin),salt,64); return crypto.timingSafeEqual(actual,Buffer.from(expected,'hex')); } catch { return false; } }
async function audit(client,{actor=null,username=null,requestId=null,action,entity='system',entityId=null,outcome='success',summary,metadata={}}) {
  await client.query(`INSERT INTO audit_logs(actor_user_id,actor_username,request_id,action,entity_type,entity_id,outcome,summary,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[actor,username, requestId, action,entity,entityId,outcome,summary,JSON.stringify(metadata)]);
}
async function requireAuth(req,res,next) {
  try {
    const token=(req.headers.authorization||'').replace(/^Bearer\s+/i,'').trim();
    if(!token) return res.status(401).json({error:{code:'UNAUTHORIZED',message:'กรุณาเข้าสู่ระบบ'}});
    const {rows}=await pool.query(`SELECT s.id AS session_id,s.user_id,s.expires_at,u.username,u.display_name,u.role FROM user_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.is_active=true`,[hash(token)]);
    if(!rows[0]) return res.status(401).json({error:{code:'SESSION_INVALID',message:'เซสชันหมดอายุหรือไม่ถูกต้อง'}});
    req.user=rows[0]; req.sessionTokenHash=hash(token); next();
  } catch(e) { next(e); }
}
app.get('/api/v1/health', asyncRoute(async(_req,res)=>{await pool.query('SELECT 1');res.json({ok:true,service:'hardware-pos-api',time:new Date().toISOString()});}));
app.get('/api/v1/setup/status', asyncRoute(async(_req,res)=>{const {rows}=await pool.query('SELECT EXISTS(SELECT 1 FROM app_users) AS initialized');res.json({initialized:rows[0].initialized});}));
app.post('/api/v1/setup/initialize', asyncRoute(async(req,res)=>{
  const {shop={},users=[]}=req.body||{};
  if(!shop.shop_name?.trim()||!Array.isArray(users)||users.length<1||users.length>10) return res.status(400).json({error:{code:'INVALID_SETUP',message:'ต้องระบุชื่อร้านและผู้ใช้เริ่มต้นอย่างน้อย 1 คน'}});
  for(const u of users) if(!/^[a-zA-Z0-9_.-]{3,40}$/.test(u.username||'')||!u.display_name?.trim()||!/^[0-9]{4,8}$/.test(String(u.pin||''))) return res.status(400).json({error:{code:'INVALID_USER',message:'ชื่อผู้ใช้ 3-40 ตัวอักษร และ PIN เป็นตัวเลข 4-8 หลัก'}});
  const client=await pool.connect();
  try { await client.query('BEGIN'); await client.query('LOCK TABLE app_users IN EXCLUSIVE MODE');
    const existing=await client.query('SELECT 1 FROM app_users LIMIT 1'); if(existing.rowCount) {await client.query('ROLLBACK');return res.status(409).json({error:{code:'ALREADY_INITIALIZED',message:'ระบบถูกตั้งค่าเริ่มต้นแล้ว'}})}
    await client.query(`INSERT INTO shop_settings(id,shop_name,phone,tax_id,address,receipt_footer) VALUES(1,$1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET shop_name=EXCLUDED.shop_name,phone=EXCLUDED.phone,tax_id=EXCLUDED.tax_id,address=EXCLUDED.address,receipt_footer=EXCLUDED.receipt_footer,updated_at=now()`,[shop.shop_name.trim(),shop.phone||null,shop.tax_id||null,shop.address||null,shop.receipt_footer||'ขอบคุณที่ใช้บริการ']);
    for(let i=0;i<users.length;i++){const u=users[i];await client.query('INSERT INTO app_users(username,display_name,pin_hash,role) VALUES($1,$2,$3,$4)',[u.username,u.display_name.trim(),pinHash(u.pin),i===0?'owner':'cashier']);}
    await audit(client,{action:'setup.initialize',summary:'Initial shop setup completed',metadata:{users_created:users.length}}); await client.query('COMMIT');res.status(201).json({initialized:true});
  } catch(e){await client.query('ROLLBACK'); if(e.code==='23505')return res.status(409).json({error:{code:'DUPLICATE_USERNAME',message:'ชื่อผู้ใช้ซ้ำ'}}); throw e;} finally{client.release()}
}));
app.post('/api/v1/auth/login',loginLimiter,asyncRoute(async(req,res)=>{
  const {username,pin,device_id=null,device_label=null}=req.body||{}; if(!username||pin===undefined)return res.status(400).json({error:{code:'INVALID_LOGIN',message:'กรุณาระบุชื่อผู้ใช้และ PIN'}});
  const client=await pool.connect();
  try {await client.query('BEGIN');const q=await client.query('SELECT * FROM app_users WHERE username=$1 FOR UPDATE',[String(username).trim()]);const u=q.rows[0];
    if(!u||!u.is_active|| (u.locked_until&&new Date(u.locked_until)>new Date()) || !verifyPin(pin,u.pin_hash)) {
      if(u){const fails=(u.failed_pin_attempts||0)+1;const lock=fails>=5?new Date(Date.now()+15*60*1000):null;await client.query('UPDATE app_users SET failed_pin_attempts=$2,locked_until=$3,updated_at=now() WHERE id=$1',[u.id,fails,lock]);await audit(client,{actor:u.id,username:u.username,requestId:req.requestId,action:'auth.login',entity:'user',entityId:u.id,outcome:'failure',summary:'Login failed'});}
      await client.query('COMMIT');return res.status(401).json({error:{code:'LOGIN_FAILED',message:'ชื่อผู้ใช้หรือ PIN ไม่ถูกต้อง หรือบัญชีถูกล็อกชั่วคราว'}});
    }
    const token=crypto.randomBytes(32).toString('base64url'), expires=new Date(Date.now()+sessionHours*3600000);
    await client.query('UPDATE app_users SET failed_pin_attempts=0,locked_until=NULL,last_login_at=now(),updated_at=now() WHERE id=$1',[u.id]);
    await client.query('INSERT INTO user_sessions(user_id,token_hash,device_id,device_label,expires_at) VALUES($1,$2,$3,$4,$5)',[u.id,hash(token),device_id,device_label,expires]);
    await audit(client,{actor:u.id,username:u.username,requestId:req.requestId,action:'auth.login',entity:'user',entityId:u.id,summary:'Login successful'});await client.query('COMMIT');res.json({session_token:token,expires_at:expires.toISOString(),user:{id:u.id,username:u.username,display_name:u.display_name,role:u.role}});
  } catch(e){await client.query('ROLLBACK');throw e;} finally{client.release()}
}));
app.use('/api/v1',requireAuth);
// Role-based authorization is enforced by the API, not merely hidden in the UI. Unknown API routes default to deny.
app.use('/api/v1', (req,res,next)=>{
 const permission=requiredPermission(req.method,req.path); if(isAllowed(req.user.role||'cashier',permission))return next();
 res.status(403).json({error:{code:'FORBIDDEN',message:'บัญชีนี้ไม่มีสิทธิ์ดำเนินการดังกล่าว',permission,role:req.user.role||'cashier'}});
});
// Owner-only user administration. PINs are never returned by the API.
app.get('/api/v1/users',asyncRoute(async(_req,res)=>{const q=await pool.query('SELECT id,username,display_name,role,is_active,last_login_at,created_at FROM app_users ORDER BY created_at');res.json({items:q.rows});}));
app.post('/api/v1/users',asyncRoute(async(req,res)=>{
 const {username,display_name,pin,role='cashier'}=req.body||{};
 const roles=['owner','manager','cashier','inventory','accountant'];
 if(!/^[a-zA-Z0-9_.-]{3,40}$/.test(username||'')||!String(display_name||'').trim()||!/^[0-9]{4,8}$/.test(String(pin||''))||!roles.includes(role))return res.status(400).json({error:{code:'INVALID_USER',message:'กรุณาตรวจชื่อผู้ใช้ ชื่อแสดงผล PIN 4-8 หลัก และบทบาท'}});
 const client=await pool.connect();try{await client.query('BEGIN');const q=await client.query('INSERT INTO app_users(username,display_name,pin_hash,role) VALUES($1,$2,$3,$4) RETURNING id,username,display_name,role,is_active,created_at',[username,display_name.trim(),pinHash(pin),role]);await audit(client,{actor:req.user.user_id,username:req.user.username,requestId:req.requestId,action:'user.create',entity:'user',entityId:q.rows[0].id,summary:'User account created',metadata:{username,role}});await client.query('COMMIT');res.status(201).json({user:q.rows[0]});}catch(e){await client.query('ROLLBACK');if(e.code==='23505')return res.status(409).json({error:{code:'DUPLICATE_USERNAME',message:'ชื่อผู้ใช้นี้มีอยู่แล้ว'}});throw e;}finally{client.release()}
}));
app.patch('/api/v1/users/:id',asyncRoute(async(req,res)=>{
 const {role,is_active,display_name,pin}=req.body||{}, roles=['owner','manager','cashier','inventory','accountant'];
 if(role!==undefined&&!roles.includes(role)||is_active!==undefined&&typeof is_active!=='boolean'||display_name!==undefined&&!String(display_name).trim()||pin!==undefined&&!/^[0-9]{4,8}$/.test(String(pin)))return res.status(400).json({error:{code:'INVALID_USER_UPDATE',message:'ข้อมูลแก้ไขไม่ถูกต้อง'}});
 if(req.params.id===req.user.user_id&&is_active===false)return res.status(400).json({error:{code:'CANNOT_DISABLE_SELF',message:'ไม่สามารถปิดใช้งานบัญชีตัวเองได้'}});
 const client=await pool.connect();try{await client.query('BEGIN');const before=await client.query('SELECT id,username,role,is_active FROM app_users WHERE id=$1 FOR UPDATE',[req.params.id]);if(!before.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:{code:'USER_NOT_FOUND',message:'ไม่พบบัญชีผู้ใช้'}})}const wasOwner=before.rows[0].role==='owner'&&before.rows[0].is_active, willOwner=(role??before.rows[0].role)==='owner'&&(is_active??before.rows[0].is_active);if(wasOwner&&!willOwner){const count=await client.query("SELECT count(*)::int n FROM app_users WHERE role='owner' AND is_active=true");if(count.rows[0].n<=1){await client.query('ROLLBACK');return res.status(409).json({error:{code:'LAST_OWNER',message:'ต้องมีบัญชีเจ้าของร้านที่ใช้งานได้อย่างน้อย 1 บัญชี'}})}}
 const q=await client.query(`UPDATE app_users SET role=COALESCE($2,role),is_active=COALESCE($3,is_active),display_name=COALESCE($4,display_name),pin_hash=COALESCE($5,pin_hash),failed_pin_attempts=CASE WHEN $5::text IS NULL THEN failed_pin_attempts ELSE 0 END,locked_until=CASE WHEN $5::text IS NULL THEN locked_until ELSE NULL END,updated_at=now() WHERE id=$1 RETURNING id,username,display_name,role,is_active,last_login_at,created_at`,[req.params.id,role??null,is_active??null,display_name===undefined?null:String(display_name).trim(),pin===undefined?null:pinHash(pin)]);
 if(is_active===false||role!==undefined||pin!==undefined)await client.query('UPDATE user_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL AND ($2::boolean=false OR $3::boolean IS NOT NULL OR $4::boolean IS NOT NULL)',[req.params.id,is_active??true,role!==undefined,pin!==undefined]);
 await audit(client,{actor:req.user.user_id,username:req.user.username,requestId:req.requestId,action:'user.update',entity:'user',entityId:req.params.id,summary:'User account updated',metadata:{role:role??before.rows[0].role,is_active:is_active??before.rows[0].is_active,pin_reset:pin!==undefined}});await client.query('COMMIT');res.json({user:q.rows[0]});}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release()}
}));
app.get('/api/v1/audit-logs',asyncRoute(async(req,res)=>{const limit=Math.min(200,Math.max(1,Number(req.query.limit)||100));const q=await pool.query('SELECT id,occurred_at,actor_username,action,entity_type,entity_id,outcome,summary,metadata,request_id FROM audit_logs ORDER BY occurred_at DESC LIMIT $1',[limit]);res.json({items:q.rows});}));
app.get('/api/v1/approvals',asyncRoute(async(req,res)=>{
 const status=String(req.query.status||'').trim();
 if(status&&!['pending','approved','rejected','cancelled'].includes(status))return res.status(400).json({error:{code:'INVALID_STATUS',message:'สถานะคำขอไม่ถูกต้อง'}});
 const params=[];let where='true';if(status){params.push(status);where+=` AND ar.status=$${params.length}`;}
 if(!['owner','manager'].includes(req.user.role)){params.push(req.user.user_id);where+=` AND ar.requested_by=$${params.length}`;}
 const q=await pool.query(`SELECT ar.id,ar.request_type,ar.entity_type,ar.entity_id,ar.payload,ar.reason,ar.status,ar.requested_by,ru.username requested_by_username,ru.display_name requested_by_name,ar.decided_by,du.username decided_by_username,ar.decision_note,ar.created_at,ar.decided_at FROM approval_requests ar JOIN app_users ru ON ru.id=ar.requested_by LEFT JOIN app_users du ON du.id=ar.decided_by WHERE ${where} ORDER BY CASE WHEN ar.status='pending' THEN 0 ELSE 1 END,ar.created_at DESC LIMIT 300`,params);
 res.json({items:q.rows});
}));
app.post('/api/v1/approvals',asyncRoute(async(req,res)=>{
 const key=String(req.get('Idempotency-Key')||'').trim();if(!key||key.length>200)return res.status(400).json({error:{code:'IDEMPOTENCY_KEY_REQUIRED',message:'ต้องส่ง Idempotency-Key ไม่เกิน 200 ตัวอักษร'}});
 const parsed=validateApprovalRequest(req.body||{});if(parsed.error)return res.status(400).json({error:{code:'INVALID_APPROVAL_REQUEST',message:parsed.error,details:parsed.details}});
 const client=await pool.connect();try{await client.query('BEGIN');
  const existing=await client.query('SELECT * FROM approval_requests WHERE idempotency_key=$1',[key]);if(existing.rowCount){const row=existing.rows[0];if(row.requested_by!==req.user.user_id){await client.query('ROLLBACK');return res.status(409).json({error:{code:'IDEMPOTENCY_CONFLICT',message:'Idempotency-Key นี้ถูกใช้โดยคำขออื่น'}});}await client.query('COMMIT');return res.json({approval:row,idempotent:true});}
  const variant=await client.query('SELECT id FROM product_variants WHERE id=$1 AND is_active=true FOR UPDATE',[parsed.entity_id]);if(!variant.rowCount)throw Object.assign(new Error('ไม่พบสินค้าที่เปิดใช้งาน'),{status:404});
  const q=await client.query(`INSERT INTO approval_requests(request_type,entity_type,entity_id,payload,reason,requested_by,idempotency_key) VALUES($1,'variant',$2,$3,$4,$5,$6) RETURNING *`,[parsed.request_type,parsed.entity_id,JSON.stringify(parsed.payload),parsed.reason,req.user.user_id,key]);
  await audit(client,{actor:req.user.user_id,username:req.user.username,requestId:req.requestId,action:'approval.request',entity:'approval_request',entityId:q.rows[0].id,summary:'Approval request submitted',metadata:{request_type:parsed.request_type,entity_id:parsed.entity_id,reason:parsed.reason}});
  await client.query('COMMIT');res.status(201).json({approval:q.rows[0]});
 }catch(e){await client.query('ROLLBACK');if(e.status)return res.status(e.status).json({error:{code:'APPROVAL_REQUEST_REJECTED',message:e.message}});if(e.code==='23505')return res.status(409).json({error:{code:'IDEMPOTENCY_CONFLICT',message:'คำขอนี้ถูกส่งซ้ำ'}});throw e;}finally{client.release()}
}));
app.post('/api/v1/approvals/:id/decision',asyncRoute(async(req,res)=>{
 const parsed=validateApprovalDecision(req.body||{});if(parsed.error)return res.status(400).json({error:{code:'INVALID_APPROVAL_DECISION',message:parsed.error}});
 const client=await pool.connect();try{await client.query('BEGIN');
  const aq=await client.query('SELECT * FROM approval_requests WHERE id=$1 FOR UPDATE',[req.params.id]);if(!aq.rowCount)throw Object.assign(new Error('ไม่พบคำขออนุมัติ'),{status:404});const ar=aq.rows[0];
  if(ar.status!=='pending')throw Object.assign(new Error('คำขอนี้ถูกตัดสินแล้ว'),{status:409});if(ar.requested_by===req.user.user_id)throw Object.assign(new Error('ผู้ส่งคำขอไม่สามารถอนุมัติคำขอของตนเองได้'),{status:403});
  const vq=await client.query('SELECT v.*,p.sku,p.name FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=$1 AND v.is_active AND p.is_active FOR UPDATE OF v,p',[ar.entity_id]);if(!vq.rowCount)throw Object.assign(new Error('ไม่พบสินค้าที่เปิดใช้งาน'),{status:404});const v=vq.rows[0];
  if(parsed.decision==='approved'){
   if(ar.request_type==='inventory_adjustment'){
    const delta=Number(ar.payload.quantity_delta);await client.query('INSERT INTO inventory_balances(variant_id,quantity) VALUES($1,0) ON CONFLICT DO NOTHING',[ar.entity_id]);const b=await client.query('SELECT quantity FROM inventory_balances WHERE variant_id=$1 FOR UPDATE',[ar.entity_id]);const next=Number(b.rows[0].quantity)+delta;if(next<0)throw Object.assign(new Error('สต็อกไม่เพียงพอ ไม่สามารถอนุมัติรายการนี้ได้'),{status:409});await client.query('UPDATE inventory_balances SET quantity=$2,updated_at=now() WHERE variant_id=$1',[ar.entity_id,next]);await client.query(`INSERT INTO inventory_movements(variant_id,movement_type,quantity_delta,reason,actor_user_id,idempotency_key,reference_type,reference_id) VALUES($1,'adjustment',$2,$3,$4,$5,'approval_request',$6)`,[ar.entity_id,delta,`Approved adjustment: ${ar.reason}`,req.user.user_id,`approval:${ar.id}`,ar.id]);
   } else if(ar.request_type==='product_price_change') {
    await client.query('UPDATE product_variants SET sale_price=$2,updated_at=now() WHERE id=$1',[ar.entity_id,Number(ar.payload.value)]);
   } else if(ar.request_type==='product_cost_change') {
    await client.query('UPDATE product_variants SET cost_price=$2,updated_at=now() WHERE id=$1',[ar.entity_id,Number(ar.payload.value)]);
   }
  }
  const upd=await client.query(`UPDATE approval_requests SET status=$2,decided_by=$3,decision_note=$4,decided_at=now() WHERE id=$1 RETURNING *`,[ar.id,parsed.decision,req.user.user_id,parsed.note||null]);
  await audit(client,{actor:req.user.user_id,username:req.user.username,requestId:req.requestId,action:`approval.${parsed.decision}`,entity:'approval_request',entityId:ar.id,summary:parsed.decision==='approved'?'Approval request approved and applied':'Approval request rejected',metadata:{request_type:ar.request_type,entity_id:ar.entity_id,requested_by:ar.requested_by,decision_note:parsed.note||null}});
  await client.query('COMMIT');res.json({approval:upd.rows[0],applied:parsed.decision==='approved'});
 }catch(e){await client.query('ROLLBACK');if(e.status)return res.status(e.status).json({error:{code:'APPROVAL_DECISION_REJECTED',message:e.message}});if(e.code==='23505')return res.status(409).json({error:{code:'APPROVAL_ALREADY_APPLIED',message:'รายการนี้ถูกบันทึกแล้ว'}});throw e;}finally{client.release()}
}));
app.get('/api/v1/auth/me',asyncRoute(async(req,res)=>res.json({user:{id:req.user.user_id,username:req.user.username,display_name:req.user.display_name,role:req.user.role},expires_at:req.user.expires_at})));
app.post('/api/v1/auth/logout',asyncRoute(async(req,res)=>{await pool.query('UPDATE user_sessions SET revoked_at=now() WHERE id=$1',[req.user.session_id]);res.json({ok:true});}));
// Cash shift lifecycle and auditable cash movements.
const cashSummarySql = `SELECT s.*,
  ROUND((s.opening_cash + COALESCE(SUM(CASE WHEN cm.movement_type IN ('cash_in','sale_cash','customer_payment_cash') THEN cm.amount WHEN cm.movement_type IN ('cash_out','refund_cash') THEN -cm.amount ELSE 0 END),0))::numeric,2) AS calculated_expected_cash,
  COUNT(cm.id)::int AS movement_count
  FROM shifts s LEFT JOIN cash_movements cm ON cm.shift_id=s.id WHERE s.id=$1 GROUP BY s.id`;
app.get('/api/v1/shifts/current',asyncRoute(async(_req,res)=>{
 const q=await pool.query(`SELECT id FROM shifts WHERE status='open' LIMIT 1`);
 if(!q.rowCount)return res.json({shift:null});
 const summary=await pool.query(cashSummarySql,[q.rows[0].id]);
 const movements=await pool.query(`SELECT id,movement_type,amount,note,actor_user_id,occurred_at FROM cash_movements WHERE shift_id=$1 ORDER BY occurred_at DESC LIMIT 100`,[q.rows[0].id]);
 res.json({shift:summary.rows[0],movements:movements.rows});
}));
app.get('/api/v1/shifts',asyncRoute(async(req,res)=>{
 const limit=Math.min(100,Math.max(1,Number(req.query.limit)||30));
 const q=await pool.query(`SELECT s.*,ROUND((s.opening_cash+COALESCE(SUM(CASE WHEN cm.movement_type IN ('cash_in','sale_cash','customer_payment_cash') THEN cm.amount WHEN cm.movement_type IN ('cash_out','refund_cash') THEN -cm.amount ELSE 0 END),0))::numeric,2) calculated_expected_cash,COUNT(cm.id)::int movement_count FROM shifts s LEFT JOIN cash_movements cm ON cm.shift_id=s.id GROUP BY s.id ORDER BY s.opened_at DESC LIMIT $1`,[limit]);
 res.json({items:q.rows});
}));
app.post('/api/v1/shifts/open',asyncRoute(async(req,res)=>{
 const openingCash=Number(req.body?.opening_cash),note=String(req.body?.note||'').trim().slice(0,500),key=req.get('Idempotency-Key');
 if(!key||key.length>200)return res.status(400).json({error:{code:'IDEMPOTENCY_KEY_REQUIRED',message:'ต้องส่ง Idempotency-Key ไม่เกิน 200 ตัวอักษร'}});
 if(!isValidCashAmount(openingCash))return res.status(400).json({error:{code:'INVALID_OPENING_CASH',message:'เงินตั้งต้นต้องเป็นจำนวนตั้งแต่ 0 บาท และไม่เกิน 2 ตำแหน่งทศนิยม'}});
 const client=await pool.connect();try{await client.query('BEGIN');
  const prior=await client.query('SELECT * FROM shifts WHERE open_operation_id=$1',[key]);if(prior.rowCount){if(Number(prior.rows[0].opening_cash)!==openingCash||(prior.rows[0].note||'')!==(note||'')){await client.query('ROLLBACK');return res.status(409).json({error:{code:'IDEMPOTENCY_CONFLICT',message:'Idempotency-Key นี้ถูกใช้เปิดกะด้วยข้อมูลอื่นแล้ว'}})}await client.query('COMMIT');return res.json({shift:prior.rows[0],idempotent:true});}
  const existing=await client.query(`SELECT id FROM shifts WHERE status='open' FOR UPDATE`);if(existing.rowCount)throw Object.assign(new Error('มีกะเงินสดเปิดอยู่แล้ว กรุณาปิดกะเดิมก่อน'),{status:409});
  const shiftNo='SH-'+new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14)+'-'+crypto.randomBytes(2).toString('hex').toUpperCase();
  const shift=await client.query(`INSERT INTO shifts(shift_no,opened_by,opening_cash,expected_cash,status,note,open_operation_id) VALUES($1,$2,$3,$3,'open',$4,$5) RETURNING *`,[shiftNo,req.user.user_id,openingCash,note||null,key]);
  if(openingCash>0)await client.query(`INSERT INTO cash_movements(shift_id,movement_type,amount,note,actor_user_id,operation_id) VALUES($1,'opening_float',$2,$3,$4,$5)`,[shift.rows[0].id,openingCash,'เงินสดตั้งต้นกะ',req.user.user_id,`shift-open:${key}`]);
  await audit(client,{actor:req.user.user_id,username:req.user.username,requestId:req.requestId,action:'cash_shift.open',entity:'shift',entityId:shift.rows[0].id,summary:'Cash shift opened',metadata:{shift_no:shiftNo,opening_cash:openingCash}});
  await client.query('COMMIT');res.status(201).json({shift:shift.rows[0]});
 }catch(e){await client.query('ROLLBACK');if(e.status)return res.status(e.status).json({error:{code:'SHIFT_OPEN_REJECTED',message:e.message}});if(e.code==='23505')return res.status(409).json({error:{code:'SHIFT_CONFLICT',message:'มีกะเงินสดเปิดอยู่แล้วหรือ Idempotency-Key ซ้ำ'}});throw e;}finally{client.release();}
}));
app.post('/api/v1/shifts/:id/movements',asyncRoute(async(req,res)=>{
 const type=req.body?.movement_type,amount=Number(req.body?.amount),note=String(req.body?.note||'').trim(),key=req.get('Idempotency-Key');
 if(!key||key.length>200)return res.status(400).json({error:{code:'IDEMPOTENCY_KEY_REQUIRED',message:'ต้องส่ง Idempotency-Key'}});
 if(!['cash_in','cash_out'].includes(type)||!isValidCashAmount(amount,{allowZero:false})||note.length<2)return res.status(400).json({error:{code:'INVALID_CASH_MOVEMENT',message:'ระบุประเภทรายการ เงินจำนวนบวกไม่เกิน 2 ตำแหน่ง และเหตุผลอย่างน้อย 2 ตัวอักษร'}});
 const client=await pool.connect();try{await client.query('BEGIN');const dup=await client.query('SELECT * FROM cash_movements WHERE operation_id=$1',[`cash:${key}`]);if(dup.rowCount){if(dup.rows[0].shift_id!==req.params.id||dup.rows[0].movement_type!==type||Number(dup.rows[0].amount)!==amount||(dup.rows[0].note||'')!==note){await client.query('ROLLBACK');return res.status(409).json({error:{code:'IDEMPOTENCY_CONFLICT',message:'Idempotency-Key นี้ถูกใช้กับรายการเงินสดอื่นแล้ว'}})}await client.query('COMMIT');return res.json({movement:dup.rows[0],idempotent:true});}
 const shift=await client.query(`SELECT * FROM shifts WHERE id=$1 AND status='open' FOR UPDATE`,[req.params.id]);if(!shift.rowCount)throw Object.assign(new Error('ไม่พบกะที่เปิดอยู่'),{status:409});
 const summary=await client.query(cashSummarySql,[req.params.id]);if(type==='cash_out'&&Number(summary.rows[0].calculated_expected_cash)<amount)throw Object.assign(new Error('เงินสดคาดหมายไม่เพียงพอสำหรับบันทึกเงินออก'),{status:409});
 const m=await client.query(`INSERT INTO cash_movements(shift_id,movement_type,amount,note,actor_user_id,operation_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[req.params.id,type,amount,note,req.user.user_id,`cash:${key}`]);await audit(client,{actor:req.user.user_id,username:req.user.username,requestId:req.requestId,action:`cash_shift.${type}`,entity:'shift',entityId:req.params.id,summary:type==='cash_in'?'Cash added to drawer':'Cash removed from drawer',metadata:{amount,note}});await client.query('COMMIT');res.status(201).json({movement:m.rows[0]});
 }catch(e){await client.query('ROLLBACK');if(e.status)return res.status(e.status).json({error:{code:'CASH_MOVEMENT_REJECTED',message:e.message}});if(e.code==='23505')return res.status(409).json({error:{code:'IDEMPOTENCY_CONFLICT',message:'Idempotency-Key ถูกใช้แล้ว'}});throw e;}finally{client.release();}
}));
app.post('/api/v1/shifts/:id/close',asyncRoute(async(req,res)=>{
 const counted=Number(req.body?.counted_cash),note=String(req.body?.note||'').trim().slice(0,500),key=req.get('Idempotency-Key');
 if(!key||key.length>200)return res.status(400).json({error:{code:'IDEMPOTENCY_KEY_REQUIRED',message:'ต้องส่ง Idempotency-Key'}});
 if(!isValidCashAmount(counted))return res.status(400).json({error:{code:'INVALID_COUNTED_CASH',message:'เงินสดที่นับต้องเป็นจำนวนตั้งแต่ 0 บาท และไม่เกิน 2 ตำแหน่งทศนิยม'}});
 const client=await pool.connect();try{await client.query('BEGIN');const old=await client.query('SELECT * FROM shifts WHERE close_operation_id=$1',[key]);if(old.rowCount){if(Number(old.rows[0].counted_cash)!==counted){await client.query('ROLLBACK');return res.status(409).json({error:{code:'IDEMPOTENCY_CONFLICT',message:'Idempotency-Key นี้ถูกใช้ปิดกะด้วยยอดนับอื่นแล้ว'}})}await client.query('COMMIT');return res.json({shift:old.rows[0],idempotent:true});}
 const q=await client.query(`SELECT * FROM shifts WHERE id=$1 AND status='open' FOR UPDATE`,[req.params.id]);if(!q.rowCount)throw Object.assign(new Error('ไม่พบกะที่เปิดอยู่หรือกะนี้ปิดแล้ว'),{status:409});const summary=await client.query(cashSummarySql,[req.params.id]);const {expected_cash:expected,cash_difference:difference}=reconcileCash(Number(summary.rows[0].calculated_expected_cash),counted);
 const closed=await client.query(`UPDATE shifts SET expected_cash=$2,counted_cash=$3,cash_difference=$4,status='closed',closed_by=$5,closed_at=now(),note=CASE WHEN $6='' THEN note WHEN COALESCE(note,'')='' THEN $6 ELSE note||E'\\n'||$6 END,close_operation_id=$7 WHERE id=$1 RETURNING *`,[req.params.id,expected,counted,difference,req.user.user_id,note,key]);await audit(client,{actor:req.user.user_id,username:req.user.username,requestId:req.requestId,action:'cash_shift.close',entity:'shift',entityId:req.params.id,summary:'Cash shift closed',metadata:{expected_cash:expected,counted_cash:counted,cash_difference:difference}});await client.query('COMMIT');res.json({shift:closed.rows[0],reconciliation:{expected_cash:expected,counted_cash:counted,cash_difference:difference}});
 }catch(e){await client.query('ROLLBACK');if(e.status)return res.status(e.status).json({error:{code:'SHIFT_CLOSE_REJECTED',message:e.message}});if(e.code==='23505')return res.status(409).json({error:{code:'SHIFT_CONFLICT',message:'กะนี้ปิดแล้วหรือ Idempotency-Key ถูกใช้แล้ว'}});throw e;}finally{client.release();}
}));
app.get('/api/v1/shop',asyncRoute(async(_req,res)=>{const q=await pool.query('SELECT shop_name,phone,tax_id,address,receipt_footer,currency_code,timezone FROM shop_settings WHERE id=1');res.json(q.rows[0]||{});}));
app.patch('/api/v1/shop',asyncRoute(async(req,res)=>{const s=req.body||{};const q=await pool.query(`UPDATE shop_settings SET shop_name=COALESCE($1,shop_name),phone=COALESCE($2,phone),tax_id=COALESCE($3,tax_id),address=COALESCE($4,address),receipt_footer=COALESCE($5,receipt_footer),updated_at=now() WHERE id=1 RETURNING *`,[s.shop_name??null,s.phone??null,s.tax_id??null,s.address??null,s.receipt_footer??null]);if(!q.rowCount)return res.status(404).json({error:{code:'SHOP_NOT_CONFIGURED',message:'ยังไม่ได้ตั้งค่าร้าน'}});res.json(q.rows[0]);}));
// Supplier and purchasing workflow: order creation, partial receiving, stock ledger, and idempotency.
app.get('/api/v1/suppliers',asyncRoute(async(req,res)=>{
  const query=String(req.query.query||'').trim();
  const params=[]; let where='is_active=true';
  if(query){params.push(`%${query}%`);where+=` AND (name ILIKE $${params.length} OR phone ILIKE $${params.length} OR tax_id ILIKE $${params.length})`;}
  const q=await pool.query(`SELECT id,name,phone,tax_id,address,note,is_active,created_at,updated_at FROM suppliers WHERE ${where} ORDER BY name LIMIT 500`,params);
  res.json({items:q.rows});
}));
app.post('/api/v1/suppliers',asyncRoute(async(req,res)=>{
  const b=req.body||{}; const name=String(b.name||'').trim();
  if(!name||name.length>200) return res.status(400).json({error:{code:'INVALID_SUPPLIER',message:'ต้องระบุชื่อผู้จำหน่ายไม่เกิน 200 ตัวอักษร'}});
  const client=await pool.connect(); try { await client.query('BEGIN');
    const q=await client.query('INSERT INTO suppliers(name,phone,tax_id,address,note) VALUES($1,$2,$3,$4,$5) RETURNING *',[name,b.phone?String(b.phone).trim():null,b.tax_id?String(b.tax_id).trim():null,b.address?String(b.address).trim():null,b.note?String(b.note).trim():null]);
    await audit(client,{actor:req.user.user_id,username:req.user.username,requestId:req.requestId,action:'supplier.create',entity:'supplier',entityId:q.rows[0].id,summary:'Supplier created',metadata:{name}});
    await client.query('COMMIT'); res.status(201).json({supplier:q.rows[0]});
  } catch(e){await client.query('ROLLBACK');throw e;} finally{client.release();}
}));
app.get('/api/v1/purchase-orders',asyncRoute(async(req,res)=>{
  const status=String(req.query.status||'').trim();
  const params=[]; let where='true';
  if(status){if(!['open','partially_received','received','cancelled'].includes(status))return res.status(400).json({error:{code:'INVALID_STATUS',message:'สถานะใบสั่งซื้อไม่ถูกต้อง'}});params.push(status);where=`po.status=$${params.length}`;}
  const q=await pool.query(`SELECT po.id,po.po_no,po.supplier_id,s.name supplier_name,po.status,po.note,po.created_at,
    COALESCE(json_agg(json_build_object('item_id',i.id,'variant_id',i.variant_id,'sku',COALESCE(v.variant_sku,p.sku),'product_name',p.name,'variant_name',v.variant_name,'unit_name',v.unit_name,'quantity_ordered',i.quantity_ordered,'quantity_received',COALESCE(r.received,0),'unit_cost',i.unit_cost) ORDER BY p.name) FILTER(WHERE i.id IS NOT NULL),'[]'::json) items
    FROM purchase_orders po LEFT JOIN suppliers s ON s.id=po.supplier_id LEFT JOIN purchase_order_items i ON i.purchase_order_id=po.id
    LEFT JOIN product_variants v ON v.id=i.variant_id LEFT JOIN products p ON p.id=v.product_id
    LEFT JOIN LATERAL (SELECT SUM(pri.quantity_received) received FROM purchase_receipts pr JOIN purchase_receipt_items pri ON pri.receipt_id=pr.id WHERE pr.purchase_order_id=po.id AND pr.status='completed' AND pri.variant_id=i.variant_id) r ON true
    WHERE ${where} GROUP BY po.id,s.name ORDER BY po.created_at DESC LIMIT 300`,params);
  res.json({items:q.rows});
}));
app.post('/api/v1/purchase-orders',asyncRoute(async(req,res)=>{
  const operationId=req.get('Idempotency-Key');
  if(!operationId)return res.status(400).json({error:{code:'IDEMPOTENCY_KEY_REQUIRED',message:'ต้องส่ง Idempotency-Key'}});
  const parsed=validatePurchaseOrderInput(req.body||{});
  if(parsed.error)return res.status(400).json({error:{code:'INVALID_PURCHASE_ORDER',message:parsed.error,details:parsed.details}});
  const client=await pool.connect(); try {await client.query('BEGIN');
    const old=await client.query('SELECT id,po_no,status FROM purchase_orders WHERE operation_id=$1',[operationId]);
    if(old.rowCount){await client.query('COMMIT');return res.json({purchase_order:old.rows[0],idempotent:true});}
    if(parsed.supplier_id){const supplier=await client.query('SELECT id FROM suppliers WHERE id=$1 AND is_active=true FOR UPDATE',[parsed.supplier_id]);if(!supplier.rowCount)throw Object.assign(new Error('ไม่พบผู้จำหน่ายที่ใช้งานอยู่'),{status:400});}
    const ids=parsed.items.map(i=>i.variant_id);
    const variants=await client.query(`SELECT v.id FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=ANY($1::uuid[]) AND v.is_active AND p.is_active FOR UPDATE OF v`,[ids]);
    if(variants.rowCount!==ids.length)throw Object.assign(new Error('ไม่พบสินค้าบางรายการหรือสินค้าไม่เปิดใช้งาน'),{status:400});
    const poNo='PO-'+new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14)+'-'+crypto.randomBytes(2).toString('hex').toUpperCase();
    const po=await client.query('INSERT INTO purchase_orders(po_no,supplier_id,note,operation_id,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',[poNo,parsed.supplier_id,parsed.note,operationId,req.user.user_id]);
    for(const item of parsed.items)await client.query('INSERT INTO purchase_order_items(purchase_order_id,variant_id,quantity_ordered,unit_cost) VALUES($1,$2,$3,$4)',[po.rows[0].id,item.variant_id,item.quantity,item.unit_cost]);
    await audit(client,{actor:req.user.user_id,username:req.user.username,requestId:req.requestId,action:'purchase_order.create',entity:'purchase_order',entityId:po.rows[0].id,summary:'Purchase order created',metadata:{po_no:poNo,item_count:parsed.items.length}});
    await client.query('COMMIT');res.status(201).json({purchase_order:{...po.rows[0],items:parsed.items}});
  }catch(e){await client.query('ROLLBACK');if(e.status)return res.status(e.status).json({error:{code:'PURCHASE_ORDER_REJECTED',message:e.message}});if(e.code==='23505')return res.status(409).json({error:{code:'DUPLICATE_OPERATION',message:'เลขที่หรือ operation นี้ถูกใช้แล้ว'}});throw e;}finally{client.release();}
}));
app.post('/api/v1/purchase-orders/:id/receive',asyncRoute(async(req,res)=>{
  const operationId=req.get('Idempotency-Key'); const parsed=validateReceiptItems(req.body?.items);
  if(!operationId)return res.status(400).json({error:{code:'IDEMPOTENCY_KEY_REQUIRED',message:'ต้องส่ง Idempotency-Key'}});
  if(parsed.error)return res.status(400).json({error:{code:'INVALID_RECEIPT',message:parsed.error,details:parsed.details}});
  const client=await pool.connect();try{await client.query('BEGIN');
    const old=await client.query(`SELECT pr.id,pr.receipt_no,pr.purchase_order_id,pr.status FROM purchase_receipts pr WHERE pr.operation_id=$1`,[operationId]);
    if(old.rowCount){if(old.rows[0].purchase_order_id!==req.params.id){await client.query('ROLLBACK');return res.status(409).json({error:{code:'IDEMPOTENCY_CONFLICT',message:'Idempotency-Key นี้ใช้กับใบสั่งซื้ออื่นแล้ว'}});}await client.query('COMMIT');return res.json({receipt:old.rows[0],idempotent:true});}
    const poQ=await client.query('SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE',[req.params.id]);
    if(!poQ.rowCount)throw Object.assign(new Error('ไม่พบใบสั่งซื้อ'),{status:404});
    const po=poQ.rows[0];if(po.status==='cancelled')throw Object.assign(new Error('ไม่สามารถรับสินค้าจากใบสั่งซื้อที่ยกเลิกแล้ว'),{status:409});if(po.status==='received')throw Object.assign(new Error('ใบสั่งซื้อนี้รับครบแล้ว'),{status:409});
    const ids=parsed.items.map(i=>i.variant_id);
    const ordered=await client.query(`SELECT i.variant_id,i.quantity_ordered,i.unit_cost,COALESCE(r.received,0) received FROM purchase_order_items i LEFT JOIN LATERAL (SELECT SUM(pri.quantity_received) received FROM purchase_receipts pr JOIN purchase_receipt_items pri ON pri.receipt_id=pr.id WHERE pr.purchase_order_id=i.purchase_order_id AND pr.status='completed' AND pri.variant_id=i.variant_id) r ON true WHERE i.purchase_order_id=$1 AND i.variant_id=ANY($2::uuid[]) FOR UPDATE OF i`,[po.id,ids]);
    if(ordered.rowCount!==ids.length)throw Object.assign(new Error('มีสินค้าที่ไม่ได้อยู่ในใบสั่งซื้อนี้'),{status:400});
    const orderedMap=new Map(ordered.rows.map(x=>[x.variant_id,x]));
    for(const item of parsed.items){const line=orderedMap.get(item.variant_id);if(item.quantity>Number(line.quantity_ordered)-Number(line.received)+0.000001)throw Object.assign(new Error(`จำนวนรับเกินยอดค้างรับของสินค้า ${item.variant_id}`),{status:409});}
    const receiptNo='GRN-'+new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14)+'-'+crypto.randomBytes(2).toString('hex').toUpperCase();
    const receipt=await client.query(`INSERT INTO purchase_receipts(receipt_no,purchase_order_id,supplier_id,operation_id,received_by) VALUES($1,$2,$3,$4,$5) RETURNING *`,[receiptNo,po.id,po.supplier_id,operationId,req.user.user_id]);
    for(const item of parsed.items){
      const line=orderedMap.get(item.variant_id);const unitCost=item.unit_cost===null?Number(line.unit_cost):item.unit_cost;
      await client.query('INSERT INTO inventory_balances(variant_id,quantity) VALUES($1,0) ON CONFLICT DO NOTHING',[item.variant_id]);
      const bal=await client.query('SELECT quantity FROM inventory_balances WHERE variant_id=$1 FOR UPDATE',[item.variant_id]);
      const oldQty=Number(bal.rows[0].quantity);const newQty=oldQty+item.quantity;
      await client.query('UPDATE inventory_balances SET quantity=$2,updated_at=now() WHERE variant_id=$1',[item.variant_id,newQty]);
      // Moving-average unit cost preserves the value of existing stock when receiving at a different price.
      const cost=await client.query('SELECT cost_price FROM product_variants WHERE id=$1 FOR UPDATE',[item.variant_id]);
      const oldCost=Number(cost.rows[0].cost_price);const weightedCost=newQty>0?Math.round(((oldQty*oldCost)+(item.quantity*unitCost))/newQty*100)/100:unitCost;
      await client.query('UPDATE product_variants SET cost_price=$2,updated_at=now() WHERE id=$1',[item.variant_id,weightedCost]);
      await client.query('INSERT INTO purchase_receipt_items(receipt_id,variant_id,quantity_received,unit_cost) VALUES($1,$2,$3,$4)',[receipt.rows[0].id,item.variant_id,item.quantity,unitCost]);
      await client.query(`INSERT INTO inventory_movements(variant_id,movement_type,quantity_delta,unit_cost,reference_type,reference_id,reason,actor_user_id,idempotency_key) VALUES($1,'purchase_receipt',$2,$3,'purchase_receipt',$4,$5,$6,$7)`,[item.variant_id,item.quantity,unitCost,receipt.rows[0].id,`Receiving ${receiptNo}`,req.user.user_id,`purchase-receipt:${operationId}:${item.variant_id}`]);
    }
    const remaining=await client.query(`SELECT i.variant_id,i.quantity_ordered-COALESCE(r.received,0) remaining FROM purchase_order_items i LEFT JOIN LATERAL (SELECT SUM(pri.quantity_received) received FROM purchase_receipts pr JOIN purchase_receipt_items pri ON pri.receipt_id=pr.id WHERE pr.purchase_order_id=i.purchase_order_id AND pr.status='completed' AND pri.variant_id=i.variant_id) r ON true WHERE i.purchase_order_id=$1`,[po.id]);
    const status=remaining.rows.every(x=>Number(x.remaining)<=0.000001)?'received':'partially_received';
    await client.query('UPDATE purchase_orders SET status=$2 WHERE id=$1',[po.id,status]);
    await audit(client,{actor:req.user.user_id,username:req.user.username,requestId:req.requestId,action:'purchase_order.receive',entity:'purchase_receipt',entityId:receipt.rows[0].id,summary:'Purchase receipt posted to inventory',metadata:{receipt_no:receiptNo,purchase_order_id:po.id,item_count:parsed.items.length,status}});
    await client.query('COMMIT');res.status(201).json({receipt:receipt.rows[0],purchase_order_status:status,items:parsed.items});
  }catch(e){await client.query('ROLLBACK');if(e.status)return res.status(e.status).json({error:{code:'RECEIPT_REJECTED',message:e.message}});if(e.code==='23505')return res.status(409).json({error:{code:'IDEMPOTENCY_CONFLICT',message:'Idempotency-Key ถูกใช้แล้ว'}});throw e;}finally{client.release();}
}));
app.get('/api/v1/purchase-receipts',asyncRoute(async(req,res)=>{
  const q=await pool.query(`SELECT pr.id,pr.receipt_no,pr.purchase_order_id,po.po_no,pr.supplier_id,s.name supplier_name,pr.status,pr.received_at,pr.operation_id,COUNT(pri.id)::int item_count,COALESCE(SUM(pri.quantity_received*pri.unit_cost),0)::numeric(14,2) total_cost FROM purchase_receipts pr LEFT JOIN purchase_orders po ON po.id=pr.purchase_order_id LEFT JOIN suppliers s ON s.id=pr.supplier_id LEFT JOIN purchase_receipt_items pri ON pri.receipt_id=pr.id WHERE pr.status='completed' GROUP BY pr.id,po.po_no,s.name ORDER BY pr.received_at DESC LIMIT 300`);
  res.json({items:q.rows});
}));

app.get('/api/v1/products/:variantId/history',asyncRoute(async(req,res)=>{
 const v=await pool.query(`SELECT p.id product_id,COALESCE(v.variant_sku,p.sku) sku,p.sku product_sku,p.name,v.id variant_id,v.variant_name,v.unit_name FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=$1`,[req.params.variantId]);if(!v.rowCount)return res.status(404).json({error:{code:'PRODUCT_NOT_FOUND',message:'ไม่พบสินค้า'}});
 const product=v.rows[0];const limit=Math.min(200,Math.max(1,Number(req.query.limit)||100));
 const [logs,moves,approvals]=await Promise.all([
  pool.query(`SELECT id,occurred_at,actor_username,action,outcome,summary,before_data,after_data,metadata,request_id FROM audit_logs WHERE entity_id=ANY($1::text[]) ORDER BY occurred_at DESC LIMIT $2`,[[product.product_id,product.variant_id],limit]),
  pool.query(`SELECT id,occurred_at,movement_type,quantity_delta,unit_cost,reference_type,reference_id,reason,actor_user_id FROM inventory_movements WHERE variant_id=$1 ORDER BY occurred_at DESC LIMIT $2`,[product.variant_id,limit]),
  pool.query(`SELECT ar.id,ar.request_type,ar.status,ar.reason,ar.payload,ar.created_at,ar.decided_at,ru.username requested_by,du.username decided_by,ar.decision_note FROM approval_requests ar JOIN app_users ru ON ru.id=ar.requested_by LEFT JOIN app_users du ON du.id=ar.decided_by WHERE ar.entity_id=$1 ORDER BY ar.created_at DESC LIMIT $2`,[product.variant_id,limit])
 ]);
 res.json({product,changes:logs.rows,stock_movements:moves.rows,approvals:approvals.rows});
}));
app.get('/api/v1/products/barcode/:barcode',asyncRoute(async(req,res)=>{
 const barcode=String(req.params.barcode||'').trim();if(!barcode||barcode.length>100)return res.status(400).json({error:{code:'INVALID_BARCODE',message:'บาร์โค้ดไม่ถูกต้อง'}});
 const q=await pool.query(`SELECT p.id product_id,COALESCE(v.variant_sku,p.sku) sku,p.sku product_sku,p.name,v.id variant_id,v.variant_name,v.unit_name base_unit_name,v.barcode base_barcode,v.cost_price,v.sale_price base_sale_price,COALESCE(b.quantity,0) stock,COALESCE(su.id::text,'') unit_id,COALESCE(su.unit_name,v.unit_name) unit_name,COALESCE(su.conversion_factor,1)::numeric conversion_factor,COALESCE(su.sale_price,v.sale_price)::numeric sale_price,CASE WHEN su.id IS NULL THEN v.barcode ELSE su.barcode END matched_barcode FROM product_variants v JOIN products p ON p.id=v.product_id LEFT JOIN inventory_balances b ON b.variant_id=v.id LEFT JOIN product_sell_units su ON su.variant_id=v.id AND su.barcode=$1 AND su.is_active WHERE (v.barcode=$1 OR su.barcode=$1) AND v.is_active AND p.is_active LIMIT 1`,[barcode]);
 if(!q.rowCount)return res.status(404).json({error:{code:'BARCODE_NOT_FOUND',message:'ไม่พบบาร์โค้ดนี้ในระบบ'}});res.json({item:{...q.rows[0],unit_id:q.rows[0].unit_id||null,stock:Number(q.rows[0].stock),conversion_factor:Number(q.rows[0].conversion_factor),sale_price:Number(q.rows[0].sale_price)}});
}));
app.get('/api/v1/products/:variantId/units',asyncRoute(async(req,res)=>{
 const base=await pool.query(`SELECT v.id variant_id,v.unit_name,v.barcode,v.sale_price FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=$1 AND v.is_active AND p.is_active`,[req.params.variantId]);if(!base.rowCount)return res.status(404).json({error:{code:'PRODUCT_NOT_FOUND',message:'ไม่พบสินค้า'}});
 const units=await pool.query('SELECT id,variant_id,unit_name,barcode,conversion_factor,sale_price,is_active,created_at,updated_at FROM product_sell_units WHERE variant_id=$1 ORDER BY conversion_factor',[req.params.variantId]);res.json({base_unit:base.rows[0],units:units.rows});
}));
app.post('/api/v1/products/:variantId/units',asyncRoute(async(req,res)=>{
 const parsed=validateSellUnit(req.body||{});if(parsed.error)return res.status(400).json({error:{code:'INVALID_SELL_UNIT',message:parsed.error}});
 const client=await pool.connect();try{await client.query('BEGIN');const base=await client.query('SELECT v.id,p.id product_id,p.sku,p.name FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=$1 AND v.is_active AND p.is_active FOR UPDATE OF v,p',[req.params.variantId]);if(!base.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:{code:'PRODUCT_NOT_FOUND',message:'ไม่พบสินค้า'}})}
 const unit=await client.query('INSERT INTO product_sell_units(variant_id,unit_name,barcode,conversion_factor,sale_price) VALUES($1,$2,$3,$4,$5) RETURNING *',[req.params.variantId,parsed.value.unit_name,parsed.value.barcode,parsed.value.conversion_factor,parsed.value.sale_price]);await audit(client,{actor:req.user.user_id,username:req.user.username,requestId:req.requestId,action:'product.sell_unit.create',entity:'product_variant',entityId:req.params.variantId,summary:'Sell unit created',metadata:{unit_name:parsed.value.unit_name,conversion_factor:parsed.value.conversion_factor,barcode:parsed.value.barcode}});await client.query('COMMIT');res.status(201).json({unit:unit.rows[0]});
 }catch(e){await client.query('ROLLBACK');if(e.code==='23505')return res.status(409).json({error:{code:'DUPLICATE_SELL_UNIT',message:'ชื่อหน่วยหรือบาร์โค้ดนี้ถูกใช้แล้ว'}});throw e;}finally{client.release()}
}));
app.patch('/api/v1/products/units/:unitId',asyncRoute(async(req,res)=>{
 const body=req.body||{};const parsed=validateSellUnit({unit_name:body.unit_name,barcode:body.barcode,conversion_factor:body.conversion_factor,sale_price:body.sale_price});if(parsed.error)return res.status(400).json({error:{code:'INVALID_SELL_UNIT',message:parsed.error}});if(body.is_active!==undefined&&typeof body.is_active!=='boolean')return res.status(400).json({error:{code:'INVALID_SELL_UNIT',message:'สถานะหน่วยไม่ถูกต้อง'}});
 const client=await pool.connect();try{await client.query('BEGIN');const q=await client.query('UPDATE product_sell_units SET unit_name=$2,barcode=$3,conversion_factor=$4,sale_price=$5,is_active=COALESCE($6,is_active),updated_at=now() WHERE id=$1 RETURNING *',[req.params.unitId,parsed.value.unit_name,parsed.value.barcode,parsed.value.conversion_factor,parsed.value.sale_price,body.is_active??null]);if(!q.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:{code:'SELL_UNIT_NOT_FOUND',message:'ไม่พบหน่วยขาย'}})}await audit(client,{actor:req.user.user_id,username:req.user.username,requestId:req.requestId,action:'product.sell_unit.update',entity:'product_sell_unit',entityId:req.params.unitId,summary:'Sell unit updated',metadata:{unit_name:parsed.value.unit_name,conversion_factor:parsed.value.conversion_factor}});await client.query('COMMIT');res.json({unit:q.rows[0]});}catch(e){await client.query('ROLLBACK');if(e.code==='23505')return res.status(409).json({error:{code:'DUPLICATE_SELL_UNIT',message:'ชื่อหน่วยหรือบาร์โค้ดนี้ถูกใช้แล้ว'}});throw e;}finally{client.release()}
}));
app.get('/api/v1/products',asyncRoute(async(req,res)=>{const q=String(req.query.query||'').trim();const params=[];let where='p.is_active=true AND v.is_active=true';if(q){params.push(`%${q}%`);where+=` AND (p.name ILIKE $${params.length} OR p.sku ILIKE $${params.length} OR v.variant_sku ILIKE $${params.length} OR v.barcode ILIKE $${params.length})`;}if(req.query.low_stock==='true')where+=' AND COALESCE(ib.quantity,0)<=v.low_stock_threshold';const r=await pool.query(`SELECT p.id product_id,COALESCE(v.variant_sku,p.sku) sku,p.sku product_sku,p.name,p.category_id,c.name category_name,p.image_url,p.description,v.id variant_id,v.variant_sku,v.variant_name,v.barcode,v.unit_name,v.cost_price,v.sale_price,v.low_stock_threshold,COALESCE(ib.quantity,0) stock FROM products p JOIN product_variants v ON v.product_id=p.id LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN inventory_balances ib ON ib.variant_id=v.id WHERE ${where} ORDER BY p.name,v.variant_name`,params);res.json({items:r.rows});}));
app.post('/api/v1/products',asyncRoute(async(req,res)=>{const {sku,name,category_name,variant_name='',barcode=null,unit_name='ชิ้น',cost_price=0,sale_price=0,low_stock_threshold=0,opening_stock=0}=req.body||{};if(!sku?.trim()||!name?.trim()||![cost_price,sale_price,low_stock_threshold,opening_stock].every(v=>Number.isFinite(Number(v))&&Number(v)>=0))return res.status(400).json({error:{code:'INVALID_PRODUCT',message:'ข้อมูลสินค้าไม่ครบหรือจำนวน/ราคาไม่ถูกต้อง'}});const client=await pool.connect();try{await client.query('BEGIN');let categoryId=null;if(category_name?.trim()){const cat=await client.query('INSERT INTO categories(name) VALUES($1) ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id',[category_name.trim()]);categoryId=cat.rows[0].id;}const p=await client.query('INSERT INTO products(sku,name,category_id) VALUES($1,$2,$3) RETURNING *',[sku.trim(),name.trim(),categoryId]);const v=await client.query('INSERT INTO product_variants(product_id,variant_sku,variant_name,barcode,unit_name,cost_price,sale_price,low_stock_threshold) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[p.rows[0].id,sku.trim(),variant_name,barcode,unit_name,Number(cost_price),Number(sale_price),Number(low_stock_threshold)]);await client.query('INSERT INTO inventory_balances(variant_id,quantity) VALUES($1,$2)',[v.rows[0].id,Number(opening_stock)]);if(Number(opening_stock)>0)await client.query(`INSERT INTO inventory_movements(variant_id,movement_type,quantity_delta,unit_cost,reason,actor_user_id,idempotency_key) VALUES($1,'opening',$2,$3,'Initial stock',$4,$5)`,[v.rows[0].id,Number(opening_stock),Number(cost_price),req.user.user_id,`opening:${v.rows[0].id}`]);await audit(client,{actor:req.user.user_id,username:req.user.username,requestId:req.requestId,action:'product.create',entity:'product',entityId:p.rows[0].id,summary:'Product created',after:{sku,name}});await client.query('COMMIT');res.status(201).json({product:p.rows[0],variant:v.rows[0],stock:Number(opening_stock)});}catch(e){await client.query('ROLLBACK');if(e.code==='23505')return res.status(409).json({error:{code:'DUPLICATE_PRODUCT',message:'SKU, barcode หรือ variant ซ้ำ'}});throw e;}finally{client.release()}}));
// CSV/Excel-export import: create-only, atomic, and never overwrites existing products or stock.
app.post('/api/v1/products/import/preview', asyncRoute(async(req,res)=>{
  const parsed=validateImportRows(req.body?.rows); if(parsed.error) return res.status(400).json({error:{code:'INVALID_IMPORT',message:parsed.error}});
  const errors=[...parsed.errors];
  const skus=parsed.rows.map(r=>r.sku).filter(Boolean); const barcodes=parsed.rows.map(r=>r.barcode).filter(Boolean);
  const existing=await pool.query(`SELECT p.sku,v.barcode FROM products p LEFT JOIN product_variants v ON v.product_id=p.id WHERE lower(p.sku)=ANY($1::text[]) OR (v.barcode IS NOT NULL AND v.barcode=ANY($2::text[]))`,[skus.map(x=>x.toLowerCase()),barcodes]);
  const oldSku=new Set(existing.rows.map(r=>String(r.sku).toLowerCase())); const oldBarcode=new Set(existing.rows.map(r=>r.barcode).filter(Boolean));
  for(const r of parsed.rows){const rowErrors=[];if(r.sku&&oldSku.has(r.sku.toLowerCase()))rowErrors.push('SKU มีอยู่ในระบบแล้ว');if(r.barcode&&oldBarcode.has(r.barcode))rowErrors.push('บาร์โค้ดมีอยู่ในระบบแล้ว');if(rowErrors.length)errors.push({row_number:r.row_number,sku:r.sku,errors:rowErrors});}
  const badRows=new Set(errors.map(e=>e.row_number));res.json({total:parsed.rows.length,valid:parsed.rows.filter(r=>!badRows.has(r.row_number)).length,invalid:badRows.size,errors,policy:'create-only; existing products and stock are never overwritten'});
}));
app.post('/api/v1/products/import', asyncRoute(async(req,res)=>{
  const parsed=validateImportRows(req.body?.rows); if(parsed.error) return res.status(400).json({error:{code:'INVALID_IMPORT',message:parsed.error}});
  if(parsed.errors.length) return res.status(400).json({error:{code:'IMPORT_VALIDATION_FAILED',message:'พบข้อมูลผิดพลาด กรุณาแก้ไขก่อนนำเข้า',details:parsed.errors}});
  const client=await pool.connect(); try { await client.query('BEGIN');
    const skus=parsed.rows.map(r=>r.sku.toLowerCase()); const barcodes=parsed.rows.map(r=>r.barcode).filter(Boolean);
    const existing=await client.query(`SELECT p.sku,v.barcode FROM products p LEFT JOIN product_variants v ON v.product_id=p.id WHERE lower(p.sku)=ANY($1::text[]) OR (v.barcode IS NOT NULL AND v.barcode=ANY($2::text[])) FOR UPDATE OF p`,[skus,barcodes]);
    const oldSku=new Set(existing.rows.map(r=>String(r.sku).toLowerCase())); const oldBarcode=new Set(existing.rows.map(r=>r.barcode).filter(Boolean));
    const conflicts=[];for(const r of parsed.rows){const e=[];if(oldSku.has(r.sku.toLowerCase()))e.push('SKU มีอยู่ในระบบแล้ว');if(r.barcode&&oldBarcode.has(r.barcode))e.push('บาร์โค้ดมีอยู่ในระบบแล้ว');if(e.length)conflicts.push({row_number:r.row_number,sku:r.sku,errors:e});}
    if(conflicts.length){await client.query('ROLLBACK');return res.status(409).json({error:{code:'IMPORT_CONFLICT',message:'ข้อมูลเปลี่ยนแปลงหลังตรวจสอบ กรุณาตรวจสอบตัวอย่างอีกครั้ง',details:conflicts}});}
    for(const r of parsed.rows){let categoryId=null;if(r.category_name){const cat=await client.query('INSERT INTO categories(name) VALUES($1) ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id',[r.category_name]);categoryId=cat.rows[0].id;}
      const product=await client.query('INSERT INTO products(sku,name,category_id) VALUES($1,$2,$3) RETURNING id',[r.sku,r.name,categoryId]);
      const variant=await client.query('INSERT INTO product_variants(product_id,variant_name,barcode,unit_name,cost_price,sale_price,low_stock_threshold) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[product.rows[0].id,'',r.barcode||null,r.unit_name,r.cost_price,r.sale_price,r.low_stock_threshold]);
      await client.query('INSERT INTO inventory_balances(variant_id,quantity) VALUES($1,$2)',[variant.rows[0].id,r.opening_stock]);
      if(r.opening_stock>0) await client.query(`INSERT INTO inventory_movements(variant_id,movement_type,quantity_delta,unit_cost,reason,actor_user_id,idempotency_key) VALUES($1,'opening',$2,$3,'Opening stock from product import',$4,$5)`,[variant.rows[0].id,r.opening_stock,r.cost_price,req.user.user_id,`import:${req.requestId}:${variant.rows[0].id}`]);
    }
    await audit(client,{actor:req.user.user_id,username:req.user.username,requestId:req.requestId,action:'product.import',entity:'product',summary:'Products imported from CSV',metadata:{count:parsed.rows.length}});
    await client.query('COMMIT');res.status(201).json({imported:parsed.rows.length,created_only:true,stock_overwritten:false});
  } catch(e){await client.query('ROLLBACK');if(e.code==='23505')return res.status(409).json({error:{code:'IMPORT_CONFLICT',message:'SKU หรือบาร์โค้ดซ้ำ กรุณาตรวจสอบข้อมูลอีกครั้ง'}});throw e;} finally{client.release();}
}));

app.post('/api/v1/products/:productId/variants',asyncRoute(async(req,res)=>{
 const {variant_sku,variant_name,barcode=null,unit_name='ชิ้น',cost_price=0,sale_price=0,low_stock_threshold=0,opening_stock=0}=req.body||{};
 if(!String(variant_sku||'').trim()||!String(variant_name||'').trim()||!String(unit_name||'').trim()||![cost_price,sale_price,low_stock_threshold,opening_stock].every(v=>Number.isFinite(Number(v))&&Number(v)>=0))return res.status(400).json({error:{code:'INVALID_VARIANT',message:'กรุณาระบุ SKU รุ่น หน่วย และราคา/จำนวนที่ถูกต้อง'}});
 const client=await pool.connect();try{await client.query('BEGIN');const product=await client.query('SELECT id,sku,name FROM products WHERE id=$1 AND is_active=true FOR UPDATE',[req.params.productId]);if(!product.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:{code:'PRODUCT_NOT_FOUND',message:'ไม่พบการ์ดสินค้าหรือสินค้าถูกปิดใช้งาน'}})}
 const v=await client.query('INSERT INTO product_variants(product_id,variant_sku,variant_name,barcode,unit_name,cost_price,sale_price,low_stock_threshold) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[product.rows[0].id,String(variant_sku).trim(),String(variant_name).trim(),String(barcode||'').trim()||null,String(unit_name).trim(),Number(cost_price),Number(sale_price),Number(low_stock_threshold)]);
 await client.query('INSERT INTO inventory_balances(variant_id,quantity) VALUES($1,$2)',[v.rows[0].id,Number(opening_stock)]);if(Number(opening_stock)>0)await client.query(`INSERT INTO inventory_movements(variant_id,movement_type,quantity_delta,unit_cost,reason,actor_user_id,idempotency_key) VALUES($1,'opening',$2,$3,'Initial variant stock',$4,$5)`,[v.rows[0].id,Number(opening_stock),Number(cost_price),req.user.user_id,`opening:${v.rows[0].id}`]);
 await audit(client,{actor:req.user.user_id,username:req.user.username,requestId:req.requestId,action:'product.variant.create',entity:'product_variant',entityId:v.rows[0].id,summary:'Product variant created',metadata:{product_id:product.rows[0].id,variant_sku:v.rows[0].variant_sku,variant_name:v.rows[0].variant_name,opening_stock:Number(opening_stock)}});await client.query('COMMIT');res.status(201).json({product:product.rows[0],variant:v.rows[0],stock:Number(opening_stock)});
 }catch(e){await client.query('ROLLBACK');if(e.code==='23505')return res.status(409).json({error:{code:'DUPLICATE_VARIANT',message:'SKU รุ่น บาร์โค้ด หรือชื่อรุ่นซ้ำ'}});throw e;}finally{client.release()}
}));
app.patch('/api/v1/products/:variantId',asyncRoute(async(req,res)=>{
 const {sku,name,category_name,variant_sku,variant_name,barcode,unit_name,cost_price,sale_price,low_stock_threshold}=req.body||{};
 if(req.user.role!=='owner'&&(cost_price!==undefined||sale_price!==undefined))return res.status(403).json({error:{code:'APPROVAL_REQUIRED',message:'การเปลี่ยนราคาขายหรือต้นทุนต้องส่งคำขออนุมัติผ่าน POST /api/v1/approvals ก่อน'}});
 const nums=[cost_price,sale_price,low_stock_threshold].filter(v=>v!==undefined);
 if((sku!==undefined&&!String(sku).trim())||(name!==undefined&&!String(name).trim())||(variant_sku!==undefined&&!String(variant_sku).trim())||nums.some(v=>!Number.isFinite(Number(v))||Number(v)<0))return res.status(400).json({error:{code:'INVALID_PRODUCT',message:'ข้อมูลสินค้าไม่ถูกต้อง'}});
 const client=await pool.connect();try{await client.query('BEGIN');
  const found=await client.query(`SELECT p.id product_id,p.sku,p.name,p.category_id,v.id variant_id,v.variant_sku,v.variant_name,v.barcode,v.unit_name,v.cost_price,v.sale_price,v.low_stock_threshold FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=$1 AND p.is_active AND v.is_active FOR UPDATE OF p,v`,[req.params.variantId]);
  if(!found.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:{code:'PRODUCT_NOT_FOUND',message:'ไม่พบสินค้า'}})}
  const before=found.rows[0];let categoryId=before.category_id;
  if(category_name!==undefined){if(String(category_name).trim()){const cat=await client.query('INSERT INTO categories(name) VALUES($1) ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id',[String(category_name).trim()]);categoryId=cat.rows[0].id}else categoryId=null;}
  const updatedP=await client.query('UPDATE products SET sku=$2,name=$3,category_id=$4,updated_at=now() WHERE id=$1 RETURNING id,sku,name,category_id',[before.product_id,sku===undefined?before.sku:String(sku).trim(),name===undefined?before.name:String(name).trim(),categoryId]);
  const updatedV=await client.query(`UPDATE product_variants SET variant_sku=$2,variant_name=$3,barcode=$4,unit_name=$5,cost_price=$6,sale_price=$7,low_stock_threshold=$8,updated_at=now() WHERE id=$1 RETURNING *`,[before.variant_id,variant_sku===undefined?before.variant_sku:String(variant_sku).trim(),variant_name===undefined?before.variant_name:String(variant_name),barcode===undefined?before.barcode:(String(barcode).trim()||null),unit_name===undefined?before.unit_name:String(unit_name).trim(),cost_price===undefined?before.cost_price:Number(cost_price),sale_price===undefined?before.sale_price:Number(sale_price),low_stock_threshold===undefined?before.low_stock_threshold:Number(low_stock_threshold)]);
  await audit(client,{actor:req.user.user_id,username:req.user.username,requestId:req.requestId,action:'product.update',entity:'product',entityId:before.product_id,summary:'Product and variant updated',metadata:{before:{sku:before.sku,name:before.name,sale_price:Number(before.sale_price)},after:{sku:updatedP.rows[0].sku,name:updatedP.rows[0].name,sale_price:Number(updatedV.rows[0].sale_price)}}});
  await client.query('COMMIT');res.json({product:updatedP.rows[0],variant:updatedV.rows[0]});
 }catch(e){await client.query('ROLLBACK');if(e.code==='23505')return res.status(409).json({error:{code:'DUPLICATE_PRODUCT',message:'SKU หรือบาร์โค้ดซ้ำ'}});throw e;}finally{client.release()}
}));
app.get('/api/v1/inventory-counts',asyncRoute(async(req,res)=>{
 const status=String(req.query.status||'').trim();if(status&&!['draft','submitted','approved','rejected','cancelled'].includes(status))return res.status(400).json({error:{code:'INVALID_STATUS',message:'สถานะรอบตรวจนับไม่ถูกต้อง'}});
 const params=[];let where='true';if(status){params.push(status);where+=` AND ic.status=$${params.length}`;}if(!['owner','manager'].includes(req.user.role)){params.push(req.user.user_id);where+=` AND ic.created_by=$${params.length}`;}
 const q=await pool.query(`SELECT ic.id,ic.count_no,ic.title,ic.location,ic.reason,ic.status,ic.created_by,u.display_name created_by_name,ic.decided_by,d.display_name decided_by_name,ic.created_at,ic.submitted_at,ic.decided_at,(SELECT count(*)::int FROM inventory_count_items i WHERE i.count_id=ic.id) item_count,(SELECT count(*)::int FROM inventory_count_items i WHERE i.count_id=ic.id AND i.counted_quantity IS NOT NULL) counted_item_count FROM inventory_counts ic JOIN app_users u ON u.id=ic.created_by LEFT JOIN app_users d ON d.id=ic.decided_by WHERE ${where} ORDER BY ic.created_at DESC LIMIT 100`,params);res.json({items:q.rows});
}));
app.post('/api/v1/inventory-counts',asyncRoute(async(req,res)=>{
 const parsed=validateCountCreate(req.body||{});if(parsed.error)return res.status(400).json({error:{code:'INVALID_COUNT',message:parsed.error}});
 const client=await pool.connect();try{await client.query('BEGIN');let variants;
  if(parsed.variant_ids){await client.query(`INSERT INTO inventory_balances(variant_id,quantity) SELECT v.id,0 FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=ANY($1::uuid[]) AND v.is_active=true AND p.is_active=true ON CONFLICT DO NOTHING`,[parsed.variant_ids]);variants=await client.query(`SELECT v.id variant_id,b.quantity FROM product_variants v JOIN products p ON p.id=v.product_id JOIN inventory_balances b ON b.variant_id=v.id WHERE v.id=ANY($1::uuid[]) AND v.is_active=true AND p.is_active=true ORDER BY v.id FOR UPDATE OF v,b`,[parsed.variant_ids]);if(variants.rowCount!==parsed.variant_ids.length)throw Object.assign(new Error('มีสินค้าที่ไม่พบหรือปิดใช้งานอยู่ในรายการ'),{status:400});}
  else {await client.query(`INSERT INTO inventory_balances(variant_id,quantity) SELECT v.id,0 FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.is_active=true AND p.is_active=true ON CONFLICT DO NOTHING`);variants=await client.query(`SELECT v.id variant_id,b.quantity FROM product_variants v JOIN products p ON p.id=v.product_id JOIN inventory_balances b ON b.variant_id=v.id WHERE v.is_active=true AND p.is_active=true ORDER BY v.id FOR UPDATE OF v,b`);}
  if(!variants.rowCount)throw Object.assign(new Error('ไม่พบสินค้าสำหรับตรวจนับ'),{status:400});
  const countNo='CNT-'+new Date().toISOString().slice(0,10).replaceAll('-','')+'-'+crypto.randomBytes(3).toString('hex').toUpperCase();const h=await client.query(`INSERT INTO inventory_counts(count_no,title,location,reason,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *`,[countNo,parsed.title,parsed.location||null,parsed.reason||null,req.user.user_id]);
  for(const v of variants.rows)await client.query('INSERT INTO inventory_count_items(count_id,variant_id,snapshot_quantity) VALUES($1,$2,$3)',[h.rows[0].id,v.variant_id,v.quantity]);
  await audit(client,{actor:req.user.user_id,username:req.user.username,requestId:req.requestId,action:'inventory_count.create',entity:'inventory_count',entityId:h.rows[0].id,summary:'Inventory count session created',metadata:{count_no:countNo,item_count:variants.rowCount,location:parsed.location||null}});await client.query('COMMIT');res.status(201).json({count:h.rows[0],item_count:variants.rowCount});
 }catch(e){await client.query('ROLLBACK');if(e.status)return res.status(e.status).json({error:{code:'INVALID_COUNT',message:e.message}});throw e;}finally{client.release()}
}));
app.get('/api/v1/inventory-counts/:id',asyncRoute(async(req,res)=>{
 const h=await pool.query(`SELECT ic.*,u.display_name created_by_name,d.display_name decided_by_name FROM inventory_counts ic JOIN app_users u ON u.id=ic.created_by LEFT JOIN app_users d ON d.id=ic.decided_by WHERE ic.id=$1`,[req.params.id]);if(!h.rowCount)return res.status(404).json({error:{code:'COUNT_NOT_FOUND',message:'ไม่พบรอบตรวจนับ'}});if(!['owner','manager'].includes(req.user.role)&&h.rows[0].created_by!==req.user.user_id)return res.status(403).json({error:{code:'FORBIDDEN',message:'ไม่มีสิทธิ์ดูรอบตรวจนับนี้'}});
 const items=await pool.query(`SELECT i.id item_id,i.variant_id,COALESCE(v.variant_sku,p.sku) sku,p.sku product_sku,p.name,v.variant_name,v.unit_name,i.snapshot_quantity,i.counted_quantity,i.counted_by,i.counted_at,CASE WHEN i.counted_quantity IS NULL THEN NULL ELSE i.counted_quantity-i.snapshot_quantity END difference FROM inventory_count_items i JOIN product_variants v ON v.id=i.variant_id JOIN products p ON p.id=v.product_id WHERE i.count_id=$1 ORDER BY p.name,v.variant_name`,[req.params.id]);res.json({count:h.rows[0],items:items.rows});
}));
app.patch('/api/v1/inventory-counts/:id/items/:itemId',asyncRoute(async(req,res)=>{
 const parsed=validateCountQuantity(req.body||{});if(parsed.error)return res.status(400).json({error:{code:'INVALID_COUNT_QUANTITY',message:parsed.error}});const client=await pool.connect();try{await client.query('BEGIN');const h=await client.query('SELECT * FROM inventory_counts WHERE id=$1 FOR UPDATE',[req.params.id]);if(!h.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:{code:'COUNT_NOT_FOUND',message:'ไม่พบรอบตรวจนับ'}})}if(h.rows[0].status!=='draft'){await client.query('ROLLBACK');return res.status(409).json({error:{code:'COUNT_LOCKED',message:'แก้ไขจำนวนได้เฉพาะรอบที่ยังเป็นแบบร่าง'}})}if(h.rows[0].created_by!==req.user.user_id){await client.query('ROLLBACK');return res.status(403).json({error:{code:'COUNT_OWNER_ONLY',message:'เฉพาะผู้สร้างรอบตรวจนับเท่านั้นที่แก้ไขจำนวนได้'}})}const item=await client.query('UPDATE inventory_count_items SET counted_quantity=$3,counted_by=$4,counted_at=now() WHERE id=$1 AND count_id=$2 RETURNING *',[req.params.itemId,req.params.id,parsed.counted_quantity,req.user.user_id]);if(!item.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:{code:'COUNT_ITEM_NOT_FOUND',message:'ไม่พบรายการสินค้าในรอบตรวจนับ'}})}await audit(client,{actor:req.user.user_id,username:req.user.username,requestId:req.requestId,action:'inventory_count.item_counted',entity:'inventory_count',entityId:req.params.id,summary:'Inventory item counted',metadata:{item_id:req.params.itemId,counted_quantity:parsed.counted_quantity}});await client.query('COMMIT');res.json({item:item.rows[0]});}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release()}
}));
app.post('/api/v1/inventory-counts/:id/submit',asyncRoute(async(req,res)=>{const client=await pool.connect();try{await client.query('BEGIN');const h=await client.query('SELECT * FROM inventory_counts WHERE id=$1 FOR UPDATE',[req.params.id]);if(!h.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:{code:'COUNT_NOT_FOUND',message:'ไม่พบรอบตรวจนับ'}})}if(h.rows[0].status!=='draft'){await client.query('ROLLBACK');return res.status(409).json({error:{code:'COUNT_LOCKED',message:'รอบตรวจนับนี้ส่งแล้วหรือปิดไปแล้ว'}})}if(h.rows[0].created_by!==req.user.user_id){await client.query('ROLLBACK');return res.status(403).json({error:{code:'COUNT_OWNER_ONLY',message:'เฉพาะผู้สร้างรอบตรวจนับเท่านั้นที่ส่งอนุมัติได้'}})}const missing=await client.query('SELECT count(*)::int n FROM inventory_count_items WHERE count_id=$1 AND counted_quantity IS NULL',[req.params.id]);if(missing.rows[0].n){await client.query('ROLLBACK');return res.status(409).json({error:{code:'COUNT_INCOMPLETE',message:`ยังตรวจนับไม่ครบ ${missing.rows[0].n} รายการ`}})}const q=await client.query(`UPDATE inventory_counts SET status='submitted',submitted_at=now() WHERE id=$1 RETURNING *`,[req.params.id]);await audit(client,{actor:req.user.user_id,username:req.user.username,requestId:req.requestId,action:'inventory_count.submit',entity:'inventory_count',entityId:req.params.id,summary:'Inventory count submitted for approval'});await client.query('COMMIT');res.json({count:q.rows[0]});}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release()}}));
app.post('/api/v1/inventory-counts/:id/decision',asyncRoute(async(req,res)=>{
 const decision=String(req.body?.decision||''),note=String(req.body?.note||'').trim();if(!['approved','rejected'].includes(decision)||note.length>500)return res.status(400).json({error:{code:'INVALID_DECISION',message:'ระบุ approved/rejected และหมายเหตุไม่เกิน 500 ตัวอักษร'}});if(!['owner','manager'].includes(req.user.role))return res.status(403).json({error:{code:'FORBIDDEN',message:'เฉพาะเจ้าของร้านหรือผู้จัดการอนุมัติได้'}});
 const client=await pool.connect();try{await client.query('BEGIN');const h=await client.query('SELECT * FROM inventory_counts WHERE id=$1 FOR UPDATE',[req.params.id]);if(!h.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:{code:'COUNT_NOT_FOUND',message:'ไม่พบรอบตรวจนับ'}})}const count=h.rows[0];if(count.status!=='submitted'){await client.query('ROLLBACK');return res.status(409).json({error:{code:'COUNT_NOT_SUBMITTED',message:'อนุมัติได้เฉพาะรอบที่ส่งตรวจแล้ว'}})}if(count.created_by===req.user.user_id){await client.query('ROLLBACK');return res.status(403).json({error:{code:'SELF_APPROVAL',message:'ผู้สร้างรอบตรวจนับไม่สามารถอนุมัติรอบของตนเองได้'}})}
  if(decision==='approved'){const items=await client.query('SELECT i.*,ic.snapshot_at count_snapshot_at FROM inventory_count_items i JOIN inventory_counts ic ON ic.id=i.count_id WHERE i.count_id=$1 ORDER BY i.variant_id FOR UPDATE OF i',[req.params.id]);for(const item of items.rows){await client.query('INSERT INTO inventory_balances(variant_id,quantity) VALUES($1,0) ON CONFLICT DO NOTHING',[item.variant_id]);const b=await client.query('SELECT quantity FROM inventory_balances WHERE variant_id=$1 FOR UPDATE',[item.variant_id]);const movements=await client.query(`SELECT COALESCE(sum(quantity_delta),0) delta FROM inventory_movements WHERE variant_id=$1 AND occurred_at>$2 AND occurred_at<=$3`,[item.variant_id,item.count_snapshot_at,item.counted_at]);const bookAtCount=Math.round((Number(item.snapshot_quantity)+Number(movements.rows[0].delta))*1000)/1000;const delta=calculateCountDelta(bookAtCount,item.counted_quantity);if(delta===0)continue;const next=Math.round((Number(b.rows[0].quantity)+delta)*1000)/1000;if(next<0)throw Object.assign(new Error('ผลปรับสต็อกจะติดลบ มีรายการขายหรือเคลื่อนไหวที่ต้องตรวจสอบก่อน'),{status:409});await client.query('UPDATE inventory_balances SET quantity=$2,updated_at=now() WHERE variant_id=$1',[item.variant_id,next]);await client.query(`INSERT INTO inventory_movements(variant_id,movement_type,quantity_delta,reference_type,reference_id,reason,actor_user_id,idempotency_key) VALUES($1,'adjustment',$2,'inventory_count',$3,$4,$5,$6)`,[item.variant_id,delta,req.params.id,`Inventory count ${count.count_no}: ${count.title}`,req.user.user_id,`inventory-count:${req.params.id}:${item.variant_id}`]);}}
  const q=await client.query(`UPDATE inventory_counts SET status=$2,decided_by=$3,decision_note=$4,decided_at=now() WHERE id=$1 RETURNING *`,[req.params.id,decision,req.user.user_id,note||null]);await audit(client,{actor:req.user.user_id,username:req.user.username,requestId:req.requestId,action:`inventory_count.${decision}`,entity:'inventory_count',entityId:req.params.id,summary:decision==='approved'?'Inventory count approved and stock reconciled':'Inventory count rejected',metadata:{count_no:count.count_no,created_by:count.created_by,note:note||null}});await client.query('COMMIT');res.json({count:q.rows[0],applied:decision==='approved'});
 }catch(e){await client.query('ROLLBACK');if(e.status)return res.status(e.status).json({error:{code:'COUNT_DECISION_FAILED',message:e.message}});if(e.code==='23505')return res.status(409).json({error:{code:'COUNT_ALREADY_APPLIED',message:'รายการปรับสต็อกจากรอบนี้ถูกบันทึกแล้ว'}});throw e;}finally{client.release()}
}));
app.get('/api/v1/inventory/balances',asyncRoute(async(_req,res)=>{const q=await pool.query(`SELECT COALESCE(v.variant_sku,p.sku) sku,p.sku product_sku,p.name,v.id variant_id,v.variant_name,v.unit_name,v.low_stock_threshold,COALESCE(b.quantity,0) quantity FROM products p JOIN product_variants v ON v.product_id=p.id LEFT JOIN inventory_balances b ON b.variant_id=v.id WHERE p.is_active AND v.is_active ORDER BY p.name`);res.json({items:q.rows});}));
app.post('/api/v1/inventory/adjustments',asyncRoute(async(req,res)=>{const {variant_id,quantity_delta,reason}=req.body||{};const delta=Number(quantity_delta);const key=req.get('Idempotency-Key');if(!variant_id||!Number.isFinite(delta)||delta===0||!key)return res.status(400).json({error:{code:'INVALID_ADJUSTMENT',message:'ต้องระบุสินค้า จำนวนที่ไม่เป็นศูนย์ และ Idempotency-Key'}});if(req.user.role!=='owner'&&Math.abs(delta)>=50)return res.status(409).json({error:{code:'APPROVAL_REQUIRED',message:'การปรับสต็อกตั้งแต่ 50 หน่วยขึ้นไปต้องขออนุมัติผ่าน POST /api/v1/approvals',approval_request:{request_type:'inventory_adjustment',entity_id:variant_id,payload:{quantity_delta:delta},reason:String(reason||'').trim()}}});const client=await pool.connect();try{await client.query('BEGIN');const dupe=await client.query('SELECT variant_id,quantity_delta FROM inventory_movements WHERE idempotency_key=$1',[key]);if(dupe.rowCount){if(dupe.rows[0].variant_id!==variant_id){await client.query('ROLLBACK');return res.status(409).json({error:{code:'IDEMPOTENCY_CONFLICT',message:'Idempotency-Key นี้ถูกใช้กับสินค้าอื่นแล้ว'}});}const bal=await client.query('SELECT quantity FROM inventory_balances WHERE variant_id=$1',[variant_id]);await client.query('COMMIT');return res.json({quantity:Number(bal.rows[0]?.quantity||0),idempotent:true});}await client.query('INSERT INTO inventory_balances(variant_id,quantity) VALUES($1,0) ON CONFLICT DO NOTHING',[variant_id]);const b=await client.query('SELECT quantity FROM inventory_balances WHERE variant_id=$1 FOR UPDATE',[variant_id]);if(!b.rowCount)throw Object.assign(new Error('ไม่พบ variant'),{status:404});const next=Number(b.rows[0].quantity)+delta;if(next<0)throw Object.assign(new Error('สต็อกไม่เพียงพอ'),{status:409});await client.query('UPDATE inventory_balances SET quantity=$2,updated_at=now() WHERE variant_id=$1',[variant_id,next]);await client.query(`INSERT INTO inventory_movements(variant_id,movement_type,quantity_delta,reason,actor_user_id,idempotency_key) VALUES($1,'adjustment',$2,$3,$4,$5)`,[variant_id,delta,reason||'Manual adjustment',req.user.user_id,key]);await audit(client,{actor:req.user.user_id,username:req.user.username,requestId:req.requestId,action:'inventory.adjust',entity:'variant',entityId:variant_id,summary:'Inventory adjusted',metadata:{delta,reason}});await client.query('COMMIT');res.json({variant_id,quantity:next});}catch(e){await client.query('ROLLBACK');if(e.status)return res.status(e.status).json({error:{code:'ADJUSTMENT_FAILED',message:e.message}});if(e.code==='23505')return res.status(409).json({error:{code:'IDEMPOTENCY_CONFLICT',message:'Idempotency-Key ถูกใช้แล้ว'}});throw e;}finally{client.release()}}));
app.post('/api/v1/sales',asyncRoute(async(req,res)=>{
 const {items=[],customer_id=null,bill_discount=0,payments=[],note=null}=req.body||{};const operationId=req.get('Idempotency-Key');if(!operationId||!Array.isArray(items)||!items.length||!Array.isArray(payments)||!payments.length)return res.status(400).json({error:{code:'INVALID_SALE',message:'ต้องมีสินค้า วิธีชำระเงิน และ Idempotency-Key'}});
 const client=await pool.connect();try{await client.query('BEGIN');const old=await client.query('SELECT id,bill_no,total_amount FROM bills WHERE operation_id=$1',[operationId]);if(old.rowCount){await client.query('COMMIT');return res.json({bill:old.rows[0],idempotent:true});}
  const ids=[...new Set(items.map(i=>i.variant_id))];if(ids.some(id=>!id))throw Object.assign(new Error('ต้องระบุ variant_id ของสินค้าทุกรายการ'),{status:400});
  const variants=await client.query(`SELECT v.*,COALESCE(v.variant_sku,p.sku) sku,p.name FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=ANY($1::uuid[]) AND v.is_active AND p.is_active ORDER BY v.id FOR UPDATE OF v`,[ids]);if(variants.rowCount!==ids.length)throw Object.assign(new Error('ไม่พบสินค้าบางรายการ'),{status:400});const map=new Map(variants.rows.map(v=>[v.id,v]));
  const sellUnitIds=items.map(i=>i.unit_id).filter(Boolean);const sellUnits=new Map();if(sellUnitIds.length){const us=await client.query('SELECT * FROM product_sell_units WHERE id=ANY($1::uuid[]) AND is_active',[sellUnitIds]);for(const u of us.rows)sellUnits.set(u.id,u);if(sellUnits.size!==new Set(sellUnitIds).size)throw Object.assign(new Error('ไม่พบหน่วยขายบางรายการ'),{status:400});}
  let subtotal=0;const prepared=[],reservedByVariant=new Map();for(const it of items){const v=map.get(it.variant_id),qty=Number(it.quantity);if(!Number.isFinite(qty)||qty<=0||Math.abs(qty*1000-Math.round(qty*1000))>1e-7)throw Object.assign(new Error('จำนวนสินค้าต้องมากกว่า 0 และไม่เกิน 3 ตำแหน่งทศนิยม'),{status:400});const u=it.unit_id?sellUnits.get(it.unit_id):null;if(u&&u.variant_id!==v.id)throw Object.assign(new Error('หน่วยขายไม่ตรงกับสินค้า'),{status:400});const factor=Number(u?.conversion_factor||1),converted=convertToBaseQuantity(qty,factor);if(converted.error)throw Object.assign(new Error(converted.error),{status:400});const baseQty=converted.base_quantity;const b=await client.query('SELECT quantity FROM inventory_balances WHERE variant_id=$1 FOR UPDATE',[v.id]);const stock=Number(b.rows[0]?.quantity||0),reserved=(reservedByVariant.get(v.id)||0)+baseQty;if(stock<reserved)throw Object.assign(new Error(`สต็อกไม่พอ: ${v.name} (เหลือ ${stock} ${v.unit_name})`),{status:409});reservedByVariant.set(v.id,reserved);const price=Number(u?.sale_price??v.sale_price);const line=Math.round(price*qty*100)/100;subtotal=Math.round((subtotal+line)*100)/100;prepared.push({v,unit:u,qty,baseQty,factor,unitName:u?.unit_name||v.unit_name,price,line,stock});}
  const discount=Number(bill_discount);if(!Number.isFinite(discount)||discount<0||discount>subtotal)throw Object.assign(new Error('ส่วนลดไม่ถูกต้อง'),{status:400});const total=Math.round((subtotal-discount)*100)/100;const allocations=allocateBillDiscount(prepared.map(x=>x.line),discount);prepared.forEach((x,i)=>{x.lineDiscount=allocations[i].discount_amount;x.netLine=allocations[i].line_total;});let paid=0,allocated=0,creditPart=0;for(const p of payments){const amount=Number(p.amount);if(!['cash','transfer','credit','other'].includes(p.method)||!Number.isFinite(amount)||amount<=0)throw Object.assign(new Error('วิธีชำระหรือยอดชำระไม่ถูกต้อง'),{status:400});allocated=Math.round((allocated+amount)*100)/100;if(p.method==='credit')creditPart=Math.round((creditPart+amount)*100)/100;else paid=Math.round((paid+amount)*100)/100;}if(allocated>total||paid>total)throw Object.assign(new Error('ยอดชำระรวมเกินยอดสุทธิ'),{status:400});const due=Math.round((total-paid)*100)/100;if(Math.abs(creditPart-due)>0.001)throw Object.assign(new Error('ยอดชำระต้องครบยอดสุทธิ โดยระบุส่วนที่ขายเชื่อเป็นวิธีชำระ credit ให้ตรงกับยอดค้าง'),{status:400});if(due>0&&!customer_id)throw Object.assign(new Error('ยอดค้างชำระต้องระบุลูกค้า'),{status:400});if(payments.some(p=>p.method==='credit')&&!customer_id)throw Object.assign(new Error('ขายเชื่อต้องระบุลูกค้า'),{status:400});if(customer_id){const c=await client.query('SELECT id FROM customers WHERE id=$1 AND is_active=true FOR UPDATE',[customer_id]);if(!c.rowCount)throw Object.assign(new Error('ไม่พบลูกค้า'),{status:400});}
  const cashPaymentTotal=Math.round(payments.filter(p=>p.method==='cash').reduce((a,p)=>a+Number(p.amount),0)*100)/100;let cashShiftId=null;if(cashPaymentTotal>0){const shift=await client.query(`SELECT id FROM shifts WHERE status='open' FOR UPDATE`);if(!shift.rowCount)throw Object.assign(new Error('ต้องเปิดกะเงินสดก่อนรับชำระด้วยเงินสด'),{status:409});cashShiftId=shift.rows[0].id;}
  const billNo='INV-'+new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14)+'-'+crypto.randomBytes(2).toString('hex').toUpperCase();const bill=await client.query(`INSERT INTO bills(bill_no,customer_id,seller_user_id,subtotal,discount_amount,total_amount,paid_amount,due_amount,note,operation_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$3) RETURNING *`,[billNo,customer_id,req.user.user_id,subtotal,discount,total,paid,due,note,operationId]);
  for(const [lineIndex,x] of prepared.entries()){await client.query(`INSERT INTO bill_items(bill_id,variant_id,sku_snapshot,product_name_snapshot,variant_name_snapshot,unit_name_snapshot,quantity,unit_price,unit_cost_snapshot,discount_amount,line_total,sold_unit_id,unit_conversion_factor,base_quantity) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[bill.rows[0].id,x.v.id,x.v.sku,x.v.name,x.v.variant_name,x.unitName,x.qty,x.price,x.v.cost_price,x.lineDiscount,x.netLine,x.unit?.id||null,x.factor,x.baseQty]);await client.query('UPDATE inventory_balances SET quantity=quantity-$2,updated_at=now() WHERE variant_id=$1',[x.v.id,x.baseQty]);await client.query(`INSERT INTO inventory_movements(variant_id,movement_type,quantity_delta,unit_cost,reference_type,reference_id,reason,actor_user_id,idempotency_key) VALUES($1,'sale',$2,$3,'bill',$4,'POS sale',$5,$6)`,[x.v.id,-x.baseQty,x.v.cost_price,bill.rows[0].id,req.user.user_id,`sale:${operationId}:${x.v.id}:${lineIndex}`]);}
  for(let i=0;i<payments.length;i++){const p=payments[i];await client.query('INSERT INTO bill_payments(bill_id,method,amount,reference_no,received_by,operation_id) VALUES($1,$2,$3,$4,$5,$6)',[bill.rows[0].id,p.method,Number(p.amount),p.reference_no||null,req.user.user_id,`payment:${operationId}:${i}`]);}
  if(cashShiftId)for(let i=0;i<payments.length;i++){const p=payments[i];if(p.method==='cash'&&Number(p.amount)>0)await client.query(`INSERT INTO cash_movements(shift_id,movement_type,amount,reference_type,reference_id,note,actor_user_id,operation_id) VALUES($1,'sale_cash',$2,'bill',$3,$4,$5,$6)`,[cashShiftId,Number(p.amount),bill.rows[0].id,`รับชำระบิล ${billNo}`,req.user.user_id,`sale-cash:${operationId}:${i}`]);}
  if(due>0)await client.query(`INSERT INTO customer_ledger(customer_id,entry_type,debit_amount,credit_amount,bill_id,note,actor_user_id,operation_id) VALUES($1,'credit_sale',$2,0,$3,'Credit sale',$4,$5)`,[customer_id,due,bill.rows[0].id,req.user.user_id,`debt:${operationId}`]);
  await audit(client,{actor:req.user.user_id,username:req.user.username,requestId:req.requestId,action:'sale.create',entity:'bill',entityId:bill.rows[0].id,summary:'Sale completed',metadata:{bill_no:billNo,total,items:prepared.length}});await client.query(`INSERT INTO sync_outbox(event_type,entity_type,entity_id,payload) VALUES('sale.completed','bill',$1,$2)`,[bill.rows[0].id,JSON.stringify({bill_id:bill.rows[0].id,bill_no:billNo,total_amount:total,created_at:bill.rows[0].created_at})]);await client.query('COMMIT');res.status(201).json({bill:bill.rows[0],items:prepared.map(x=>({variant_id:x.v.id,quantity:x.qty,unit_price:x.price,discount_amount:x.lineDiscount,line_total:x.netLine})),payments});
 }catch(e){await client.query('ROLLBACK');if(e.status)return res.status(e.status).json({error:{code:'SALE_REJECTED',message:e.message}});if(e.code==='23505')return res.status(409).json({error:{code:'DUPLICATE_OPERATION',message:'รายการนี้อาจถูกบันทึกไปแล้ว ให้ค้นหาบิลก่อนลองใหม่'}});throw e;}finally{client.release()}
}));
// Returns are transactional: validate remaining quantities, refund only the paid portion,
// restore stock, write stock/cash ledgers, and keep an idempotent return record.
app.get('/api/v1/sales/:id',asyncRoute(async(req,res)=>{
 const q=await pool.query(`SELECT b.*,COALESCE(json_agg(json_build_object('id',bi.id,'variant_id',bi.variant_id,'sku',bi.sku_snapshot,'name',bi.product_name_snapshot,'variant_name',bi.variant_name_snapshot,'unit_name',bi.unit_name_snapshot,'quantity',bi.quantity,'base_quantity',COALESCE(bi.base_quantity,bi.quantity),'unit_conversion_factor',COALESCE(bi.unit_conversion_factor,1),'unit_price',bi.unit_price,'discount_amount',bi.discount_amount,'line_total',bi.line_total) ORDER BY bi.id) FILTER (WHERE bi.id IS NOT NULL),'[]'::json) AS items FROM bills b LEFT JOIN bill_items bi ON bi.bill_id=b.id WHERE b.id::text=$1 OR b.bill_no=$1 GROUP BY b.id`,[req.params.id]);
 if(!q.rowCount)return res.status(404).json({error:{code:'BILL_NOT_FOUND',message:'ไม่พบบิล'}});
 const returns=await pool.query(`SELECT sr.id,sr.return_no,sr.reason,sr.refund_amount,sr.status,sr.created_at,COALESCE(json_agg(json_build_object('bill_item_id',sri.bill_item_id,'variant_id',sri.variant_id,'quantity',sri.quantity,'refund_amount',sri.refund_amount)) FILTER (WHERE sri.id IS NOT NULL),'[]'::json) items FROM sales_returns sr LEFT JOIN sales_return_items sri ON sri.return_id=sr.id WHERE sr.bill_id=$1 GROUP BY sr.id ORDER BY sr.created_at DESC`,[q.rows[0].id]);
 res.json({bill:q.rows[0],returns:returns.rows});
}));
app.post('/api/v1/sales/:id/returns',asyncRoute(async(req,res)=>{
 const parsed=validateReturnInput(req.body||{});const operationId=req.get('Idempotency-Key');
 if(!operationId)return res.status(400).json({error:{code:'IDEMPOTENCY_KEY_REQUIRED',message:'ต้องส่ง Idempotency-Key'}});
 if(parsed.error)return res.status(400).json({error:{code:'INVALID_RETURN',message:parsed.error,details:parsed.details}});
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const duplicate=await client.query(`SELECT sr.*,b.bill_no FROM sales_returns sr JOIN bills b ON b.id=sr.bill_id WHERE sr.operation_id=$1`,[operationId]);
  if(duplicate.rowCount){if(duplicate.rows[0].bill_id!==req.params.id && duplicate.rows[0].bill_no!==req.params.id){await client.query('ROLLBACK');return res.status(409).json({error:{code:'IDEMPOTENCY_CONFLICT',message:'Idempotency-Key นี้ถูกใช้กับบิลอื่นแล้ว'}});}await client.query('COMMIT');return res.json({return:duplicate.rows[0],idempotent:true});}
  const billQ=await client.query('SELECT * FROM bills WHERE id::text=$1 OR bill_no=$1 FOR UPDATE',[req.params.id]);
  if(!billQ.rowCount)throw Object.assign(new Error('ไม่พบบิล'),{status:404});
  const bill=billQ.rows[0];if(bill.status==='voided')throw Object.assign(new Error('ไม่สามารถคืนสินค้าจากบิลที่ยกเลิกแล้ว'),{status:409});
  const itemIds=parsed.items.map(x=>x.bill_item_id);
  const original=await client.query(`SELECT bi.*,COALESCE((SELECT SUM(sri.quantity) FROM sales_return_items sri JOIN sales_returns sr ON sr.id=sri.return_id WHERE sri.bill_item_id=bi.id AND sr.status='completed'),0) returned_qty FROM bill_items bi WHERE bi.bill_id=$1 AND bi.id=ANY($2::uuid[]) ORDER BY bi.id FOR UPDATE`,[bill.id,itemIds]);
  if(original.rowCount!==itemIds.length)throw Object.assign(new Error('มีรายการสินค้าที่ไม่อยู่ในบิลนี้'),{status:400});
  const byId=new Map(original.rows.map(x=>[x.id,x]));let refundTotal=0;const items=[];
  for(const requested of parsed.items){const row=byId.get(requested.bill_item_id);const remaining=Number(row.quantity)-Number(row.returned_qty);if(requested.quantity>remaining+0.000001)throw Object.assign(new Error(`จำนวนคืนเกินจำนวนคงเหลือของ ${row.product_name_snapshot} (คืนได้อีก ${remaining})`),{status:409});const lineNet=Number(row.line_total);const refund=Math.round((lineNet*requested.quantity/Number(row.quantity)+Number.EPSILON)*100)/100;refundTotal=Math.round((refundTotal+refund)*100)/100;items.push({row,quantity:requested.quantity,refund});}
  const prior=await client.query(`SELECT COALESCE(SUM(refund_amount),0) amount FROM sales_returns WHERE bill_id=$1 AND status='completed'`,[bill.id]);
  if(refundTotal+Number(prior.rows[0].amount)>Number(bill.paid_amount)+0.001)throw Object.assign(new Error('ยอดคืนเงินรวมเกินยอดที่ลูกค้าชำระจริง'),{status:409});
  let shiftId=null;
  if(parsed.refund_method==='cash'&&refundTotal>0){const shift=await client.query(`SELECT id FROM shifts WHERE status='open' FOR UPDATE`);if(!shift.rowCount)throw Object.assign(new Error('ต้องเปิดกะเงินสดก่อนจึงจะคืนเงินสดได้'),{status:409});shiftId=shift.rows[0].id;}
  const returnNo='RET-'+new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14)+'-'+crypto.randomBytes(2).toString('hex').toUpperCase();
  const ret=await client.query(`INSERT INTO sales_returns(return_no,bill_id,reason,refund_amount,operation_id,actor_user_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[returnNo,bill.id,parsed.reason,refundTotal,operationId,req.user.user_id]);
  for(const item of items){
   await client.query(`INSERT INTO sales_return_items(return_id,bill_item_id,variant_id,quantity,refund_amount) VALUES($1,$2,$3,$4,$5)`,[ret.rows[0].id,item.row.id,item.row.variant_id,item.quantity,item.refund]);
   await client.query('INSERT INTO inventory_balances(variant_id,quantity) VALUES($1,0) ON CONFLICT DO NOTHING',[item.row.variant_id]);
   const baseReturnQty=Math.round(Number(item.quantity)*Number(item.row.unit_conversion_factor||1)*1000)/1000;await client.query('UPDATE inventory_balances SET quantity=quantity+$2,updated_at=now() WHERE variant_id=$1',[item.row.variant_id,baseReturnQty]);
   await client.query(`INSERT INTO inventory_movements(variant_id,movement_type,quantity_delta,unit_cost,reference_type,reference_id,reason,actor_user_id,idempotency_key) VALUES($1,'sale_return',$2,$3,'sales_return',$4,$5,$6,$7)`,[item.row.variant_id,Math.round(Number(item.quantity)*Number(item.row.unit_conversion_factor||1)*1000)/1000,item.row.unit_cost_snapshot,ret.rows[0].id,`Return ${returnNo}`,req.user.user_id,`return:${operationId}:${item.row.id}`]);
  }
  if(parsed.refund_method==='cash'&&refundTotal>0)await client.query(`INSERT INTO cash_movements(shift_id,movement_type,amount,reference_type,reference_id,note,actor_user_id,operation_id) VALUES($1,'refund_cash',$2,'sales_return',$3,$4,$5,$6)`,[shiftId,refundTotal,ret.rows[0].id,`Refund for ${bill.bill_no}`,req.user.user_id,`refund:${operationId}`]);
  const returned=await client.query(`SELECT COALESCE(SUM(refund_amount),0) amount FROM sales_returns WHERE bill_id=$1 AND status='completed'`,[bill.id]);
  const qty=await client.query(`SELECT EXISTS(SELECT 1 FROM bill_items bi WHERE bi.bill_id=$1 AND bi.quantity > COALESCE((SELECT SUM(sri.quantity) FROM sales_return_items sri JOIN sales_returns sr ON sr.id=sri.return_id WHERE sri.bill_item_id=bi.id AND sr.status='completed'),0)) has_remaining`,[bill.id]);
  await client.query('UPDATE bills SET status=$2 WHERE id=$1',[bill.id,qty.rows[0].has_remaining?'partially_returned':'returned']);
  await audit(client,{actor:req.user.user_id,username:req.user.username,requestId:req.requestId,action:'sale.return',entity:'sales_return',entityId:ret.rows[0].id,summary:'Sale return completed',metadata:{bill_no:bill.bill_no,return_no:returnNo,refund_amount:refundTotal,refund_method:parsed.refund_method,items:items.length}});
  await client.query('COMMIT');res.status(201).json({return:ret.rows[0],items:items.map(x=>({bill_item_id:x.row.id,variant_id:x.row.variant_id,quantity:x.quantity,refund_amount:x.refund})),refund_method:parsed.refund_method,total_returned:Number(returned.rows[0].amount)});
 }catch(e){await client.query('ROLLBACK');if(e.status)return res.status(e.status).json({error:{code:'RETURN_REJECTED',message:e.message}});if(e.code==='23505')return res.status(409).json({error:{code:'IDEMPOTENCY_CONFLICT',message:'Idempotency-Key ถูกใช้แล้ว'}});throw e;}finally{client.release();}
}));
app.get('/api/v1/sales',asyncRoute(async(req,res)=>{const from=req.query.from||'1970-01-01',to=req.query.to||'2999-12-31';const q=await pool.query('SELECT id,bill_no,status,subtotal,discount_amount,tax_amount,total_amount,paid_amount,due_amount,created_at FROM bills WHERE created_at >= $1::date AND created_at < ($2::date + interval \'1 day\') ORDER BY created_at DESC LIMIT 500',[from,to]);res.json({items:q.rows});}));
// Reporting endpoints query the authoritative database; date ranges are inclusive and capped.
app.get('/api/v1/reports/summary',asyncRoute(async(req,res)=>{
 const today=new Date().toISOString().slice(0,10);
 const from=String(req.query.from||today),to=String(req.query.to||today);
 const range=validateReportRange(from,to);
 if(range.error)return res.status(400).json({error:{code:'INVALID_REPORT_RANGE',message:range.error}});
 const params=[range.from,range.to];
 const [sales,returns,payments,daily,topProducts,shifts,purchases,costs]=await Promise.all([
  pool.query(`SELECT COUNT(*) FILTER (WHERE b.status<>'voided')::int bill_count,
    COALESCE(SUM(b.total_amount) FILTER (WHERE b.status<>'voided'),0)::numeric(14,2) gross_sales,
    COALESCE(SUM(b.discount_amount) FILTER (WHERE b.status<>'voided'),0)::numeric(14,2) discounts,
    COALESCE(SUM(b.paid_amount) FILTER (WHERE b.status<>'voided'),0)::numeric(14,2) paid_amount,
    COALESCE(SUM(b.due_amount) FILTER (WHERE b.status<>'voided'),0)::numeric(14,2) due_amount,
    COUNT(*) FILTER (WHERE b.status='voided')::int voided_bill_count
    FROM bills b WHERE b.created_at >= $1::date AND b.created_at < ($2::date + interval '1 day')`,params),
  pool.query(`SELECT COUNT(*)::int return_count,COALESCE(SUM(refund_amount),0)::numeric(14,2) refund_total
    FROM sales_returns WHERE status='completed' AND created_at >= $1::date AND created_at < ($2::date + interval '1 day')`,params),
  pool.query(`SELECT bp.method,COALESCE(SUM(bp.amount),0)::numeric(14,2) amount,COUNT(DISTINCT bp.bill_id)::int bill_count
    FROM bill_payments bp JOIN bills b ON b.id=bp.bill_id
    WHERE b.status<>'voided' AND bp.received_at >= $1::date AND bp.received_at < ($2::date + interval '1 day')
    GROUP BY bp.method ORDER BY amount DESC`,params),
  pool.query(`SELECT to_char(d.day,'YYYY-MM-DD') day,COALESCE(s.gross_sales,0)::numeric(14,2) gross_sales,
    (COALESCE(s.gross_sales,0)-COALESCE(r.refund_amount,0))::numeric(14,2) net_sales,COALESCE(s.bill_count,0)::int bill_count
    FROM generate_series($1::date,$2::date,interval '1 day') d(day)
    LEFT JOIN LATERAL (SELECT SUM(b.total_amount) FILTER (WHERE b.status<>'voided') gross_sales,COUNT(*) FILTER (WHERE b.status<>'voided') bill_count FROM bills b WHERE b.created_at >= d.day AND b.created_at < d.day + interval '1 day') s ON true
    LEFT JOIN LATERAL (SELECT SUM(sr.refund_amount) refund_amount FROM sales_returns sr WHERE sr.status='completed' AND sr.created_at >= d.day AND sr.created_at < d.day + interval '1 day') r ON true
    ORDER BY d.day`,params),
  pool.query(`SELECT bi.sku_snapshot sku,bi.product_name_snapshot name,SUM(COALESCE(bi.base_quantity,bi.quantity))::numeric(14,3) sold_quantity,
    COALESCE(SUM(bi.line_total),0)::numeric(14,2) gross_amount,COALESCE(SUM(bi.unit_cost_snapshot*COALESCE(bi.base_quantity,bi.quantity)),0)::numeric(14,2) cost_amount,
    COALESCE(SUM(ret.quantity),0)::numeric(14,3) returned_quantity
    FROM bill_items bi JOIN bills b ON b.id=bi.bill_id
    LEFT JOIN LATERAL (SELECT SUM(sri.quantity*COALESCE(bi.unit_conversion_factor,1)) quantity FROM sales_return_items sri JOIN sales_returns sr ON sr.id=sri.return_id AND sr.status='completed' WHERE sri.bill_item_id=bi.id AND sr.created_at >= $1::date AND sr.created_at < ($2::date + interval '1 day')) ret ON true
    WHERE b.status<>'voided' AND b.created_at >= $1::date AND b.created_at < ($2::date + interval '1 day')
    GROUP BY bi.sku_snapshot,bi.product_name_snapshot ORDER BY SUM(bi.line_total) DESC LIMIT 20`,params),
  pool.query(`SELECT s.id,s.shift_no,s.status,s.opened_at,s.closed_at,s.opening_cash,s.expected_cash,s.counted_cash,s.cash_difference,
    ROUND((s.opening_cash+COALESCE(SUM(CASE WHEN cm.movement_type IN ('cash_in','sale_cash','customer_payment_cash') THEN cm.amount WHEN cm.movement_type IN ('cash_out','refund_cash') THEN -cm.amount ELSE 0 END),0))::numeric,2) calculated_expected_cash,
    COALESCE(SUM(cm.amount) FILTER (WHERE cm.movement_type='sale_cash'),0)::numeric(14,2) cash_sales,
    COALESCE(SUM(cm.amount) FILTER (WHERE cm.movement_type='refund_cash'),0)::numeric(14,2) cash_refunds,
    COALESCE(SUM(cm.amount) FILTER (WHERE cm.movement_type='cash_in'),0)::numeric(14,2) cash_in,
    COALESCE(SUM(cm.amount) FILTER (WHERE cm.movement_type='cash_out'),0)::numeric(14,2) cash_out
    FROM shifts s LEFT JOIN cash_movements cm ON cm.shift_id=s.id
    WHERE s.opened_at >= $1::date AND s.opened_at < ($2::date + interval '1 day')
    GROUP BY s.id ORDER BY s.opened_at DESC LIMIT 300`,params),
  pool.query(`SELECT COUNT(DISTINCT pr.id)::int receipt_count,COALESCE(SUM(pri.quantity_received*pri.unit_cost),0)::numeric(14,2) received_cost
    FROM purchase_receipts pr LEFT JOIN purchase_receipt_items pri ON pri.receipt_id=pr.id
    WHERE pr.status='completed' AND pr.received_at >= $1::date AND pr.received_at < ($2::date + interval '1 day')`,params),
  pool.query(`SELECT (COALESCE(SUM(bi.unit_cost_snapshot*COALESCE(bi.base_quantity,bi.quantity)),0)-COALESCE(SUM(ret.returned_cost),0))::numeric(14,2) cost_amount FROM bill_items bi JOIN bills b ON b.id=bi.bill_id LEFT JOIN LATERAL (SELECT SUM(sri.quantity*COALESCE(bi.unit_conversion_factor,1)*bi.unit_cost_snapshot) returned_cost FROM sales_return_items sri JOIN sales_returns sr ON sr.id=sri.return_id AND sr.status='completed' WHERE sri.bill_item_id=bi.id AND sr.created_at >= $1::date AND sr.created_at < ($2::date + interval '1 day')) ret ON true WHERE b.status<>'voided' AND b.created_at >= $1::date AND b.created_at < ($2::date + interval '1 day')`,params)
 ]);
 const s=sales.rows[0],r=returns.rows[0];
 res.json({from:range.from,to:range.to,summary:{...s,return_count:r.return_count,refund_total:r.refund_total,net_sales:(Number(s.gross_sales)-Number(r.refund_total)).toFixed(2),gross_profit_estimate:(Number(s.gross_sales)-Number(r.refund_total)-Number(costs.rows[0].cost_amount)).toFixed(2)},payments:payments.rows,daily:daily.rows,top_products:topProducts.rows,shifts:shifts.rows,purchases:purchases.rows[0]});
}));
app.use((err,req,res,_next)=>{const id=req.requestId||crypto.randomUUID();console.error(JSON.stringify({request_id:id,error:err.message,code:err.code}));res.status(500).json({error:{code:'INTERNAL_ERROR',message:'เกิดข้อผิดพลาดภายในระบบ',request_id:id}});});
app.listen(port,process.env.HOST||'127.0.0.1',()=>console.log(`Hardware POS API listening on ${process.env.HOST||'127.0.0.1'}:${port}`));
