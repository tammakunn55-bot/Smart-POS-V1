#!/usr/bin/env python3
"""ตรวจไฟล์ Excel นำเข้าสินค้าก่อนอัปโหลดเข้าแอป (ตรรกะเดียวกับตัวนำเข้าใน public/index.html)
ใช้: python3 tools/validate_import.py data/import/สินค้าพร้อมนำเข้า_YOJIONLINE.xlsx [image_mapping.json] [โฟลเดอร์รูป]
"""
import sys, json, os, unicodedata
import pandas as pd

def nfc(v): return unicodedata.normalize('NFC', str(v)).strip() if pd.notna(v) else ''

def main(xlsx, mapping=None, img_dir=None):
    df = pd.read_excel(xlsx, sheet_name='รายการสินค้า', dtype=str)
    df = df.dropna(how='all')
    groups, seen_sku, seen_bar = {}, set(), set()
    w = dict(zero_price=[], no_cost=0, dup_sku=0, dup_bar=0, no_image=0)
    for i, r in df.iterrows():
        name = nfc(r.get('ชื่อสินค้า'))
        if not name: continue
        sku = nfc(r.get('SKU')) or f'IMP-{i+2}'
        if sku in seen_sku: w['dup_sku'] += 1; sku += f'-DUP{i+2}'
        seen_sku.add(sku)
        bar = nfc(r.get('บาร์โค้ด')) or sku
        if bar in seen_bar: w['dup_bar'] += 1; bar = sku
        seen_bar.add(bar)
        price = pd.to_numeric(r.get('ราคาขาย'), errors='coerce'); cost = pd.to_numeric(r.get('ราคาทุน'), errors='coerce')
        if not (price > 0): w['zero_price'].append(f'{name} ({sku})')
        if not (cost > 0): w['no_cost'] += 1
        if not nfc(r.get('ไฟล์รูปภาพ')): w['no_image'] += 1
        groups.setdefault(name, []).append(sku)
    print(f'แถวสินค้า {len(df)}  →  กลุ่มสินค้า (นำเข้าเป็น 1 สินค้า หลายขนาด) {len(groups)}  | กลุ่มที่มีหลายขนาด {sum(len(v) > 1 for v in groups.values())}')
    print(f'ราคาขาย 0/ว่าง: {len(w["zero_price"])}', w['zero_price'][:10])
    print(f'ไม่มีราคาทุน: {w["no_cost"]}  | SKU ซ้ำ: {w["dup_sku"]}  | บาร์โค้ดซ้ำ: {w["dup_bar"]}  | ไม่มีรูป: {w["no_image"]}')
    sp = [s for s in seen_sku if ' ' in s]
    print(f'SKU ที่มีช่องว่าง: {len(sp)} (ตัวนำเข้าใหม่ใช้ได้ แต่ควรสแกนด้วยบาร์โค้ด EAN แทน)')
    bad_ean = 0
    for b in seen_bar:
        if len(b) == 13 and b.isdigit():
            d = list(map(int, b)); 
            if (10 - (sum(d[k] * (3 if k % 2 else 1) for k in range(12)) % 10)) % 10 != d[12]: bad_ean += 1
    print(f'EAN-13 ที่ check digit ผิด: {bad_ean}')
    if mapping and img_dir:
        m = json.load(open(mapping, encoding='utf-8'))
        have = set(os.listdir(img_dir))
        miss = [v for v in m.values() if v not in have]
        print(f'image_mapping: {len(m)} รายการ | ไฟล์รูปหาย {len(miss)}', miss[:5])

if __name__ == '__main__':
    if len(sys.argv) < 2: sys.exit(__doc__)
    main(*sys.argv[1:4])
