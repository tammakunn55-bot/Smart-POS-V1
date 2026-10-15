#!/usr/bin/env python3
"""ตรวจ supabase/schema.sql แบบสถิต (ไม่ต้องมี Postgres): ใช้ใน CI และก่อน commit
  - เครื่องหมาย $$ ครบคู่ · นิยามฟังก์ชัน/ตาราง/trigger ไม่ซ้ำ · FK อ้างถึงตารางที่ประกาศไว้ก่อน
  - คอลัมน์ที่ใช้ใน insert/update และฟิลด์ของตัวแปร record มีอยู่จริง
  - security definer ทุกตัวมี search_path · ทุกตารางเปิด RLS · policy/trigger เรียกฟังก์ชันที่ประกาศไว้ก่อน
ใช้: python3 tools/check_sql.py [supabase/schema.sql]
"""
import re, sys
path = sys.argv[1] if len(sys.argv) > 1 else 'supabase/schema.sql'
s = open(path, encoding='utf-8').read()
errs = []
def err(m): errs.append(m)

if s.count('$$') % 2: err('เครื่องหมาย $$ ไม่ครบคู่')

# ---- ตาราง/คอลัมน์ ----
tables, cols, fk_order = {}, {}, []
for m in re.finditer(r'create table (?:if not exists )?(?:public\.)?(\w+)\s*\((.*?)\n\);', s, re.S | re.I):
    t, body = m.group(1), m.group(2)
    if t in tables: err(f'ตาราง {t} ประกาศซ้ำ')
    tables[t] = m.start()
    cs = set()
    for l in body.split('\n'):
        l = re.sub(r'--.*$', '', l).strip()
        if not l: continue
        w = l.split()[0].strip(',')
        if w.lower() in ('constraint', 'primary', 'unique', 'check', 'foreign'): continue
        cs.add(w)
        r = re.search(r'references\s+(?:auth\.)?(\w+)\s*\(', l)
        if r and 'auth.' not in l and r.group(1) != t:
            if r.group(1) not in tables: err(f'{t}.{w} อ้างถึงตาราง {r.group(1)} ที่ยังไม่ได้ประกาศ (ลำดับผิด)')
    cols[t] = cs
if re.search(r'alter table \w+ add column', s, re.I): err('ยังมี ALTER TABLE ... ADD COLUMN (ควรรวมใน CREATE TABLE)')

for m in re.finditer(r'insert into (\w+)\s*\(([^)]*)\)\s*(?:values|select)', s, re.I):
    t = m.group(1)
    if t not in cols: continue
    miss = [c.strip() for c in m.group(2).split(',') if c.strip() not in cols[t]]
    if miss: err(f'INSERT {t}: ไม่มีคอลัมน์ {miss}')
for m in re.finditer(r'\bupdate (\w+)\s+set\s+(.*?)(?:\swhere\b|;)', s, re.I | re.S):
    t = m.group(1)
    if t not in cols: continue
    for a in re.findall(r'(?:^|,)\s*(\w+)\s*=', m.group(2)):
        if a not in cols[t]: err(f'UPDATE {t}: ไม่มีคอลัมน์ {a}')
rec = {'v_variant': 'product_variants', 'v_customer': 'customers', 'v_bill': 'bills', 'v_bi': 'bill_items', 'v_poi': 'purchase_order_items',
       'v_po': 'purchase_orders', 'v_fraction': 'product_fractions', 'v_me': 'app_users', 'v_existing': 'bills', 'v_v': 'product_variants', 'v_c': 'customers'}
for var, t in rec.items():
    for f in set(re.findall(r'\b' + var + r'\.(\w+)', s)):
        if f not in cols[t]: err(f'{var}.{f} ไม่มีในตาราง {t}')

# ---- ฟังก์ชัน ----
funcs = {}
for m in re.finditer(r'create or replace function (\w+)\s*\(([^)]*)\)(.*?)(?:as \$\$)', s, re.S | re.I):
    name, args, head = m.group(1), m.group(2), m.group(3)
    key = (name, re.sub(r'\s+', ' ', args).strip())
    if key in funcs: err(f'ฟังก์ชัน {name}({key[1]}) ประกาศซ้ำ')
    funcs[key] = m.start()
    if 'security definer' in head.lower() and 'search_path' not in head.lower():
        err(f'ฟังก์ชัน {name} เป็น security definer แต่ไม่มี search_path')
names = {k[0]: v for k, v in funcs.items()}
for fn in ('is_staff', 'is_manager', 'is_owner', 'has_perm'):
    if fn not in names: err(f'ไม่พบ {fn}')
for m in re.finditer(r'create (?:policy|trigger)[^;]*?(?:using|check)\s*\(([^;]*?)\)\s*;', s, re.S):
    for f in re.findall(r'\b(is_staff|is_manager|is_owner|has_perm)\s*\(', m.group(1)):
        if names.get(f, 10**9) > m.start(): err(f'policy ใช้ {f}() ก่อนประกาศ')
for m in re.finditer(r'execute function (\w+)\(', s):
    if m.group(1) not in names or names[m.group(1)] > m.start(): err(f'trigger เรียก {m.group(1)} ก่อนประกาศ/ไม่มี')

# ---- RLS ----
rls = set(re.findall(r'alter table (\w+)\s+enable row level security', s))
for t in tables:
    if t not in rls: err(f'ตาราง {t} ไม่ได้เปิด RLS')

print(f'ตาราง {len(tables)} · ฟังก์ชัน {len(funcs)} · RLS {len(rls)} ตาราง')
if errs:
    print('\n'.join('❌ ' + e for e in errs)); sys.exit(1)
print('✅ schema.sql ผ่านการตรวจสถิต')
