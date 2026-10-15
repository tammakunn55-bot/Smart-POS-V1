#!/usr/bin/env python3
"""อัปเดตรายการ "ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*)" ในหัวไฟล์ public/js/**.js ให้ตรงกับโค้ดจริง
ใช้: python3 tools/update_headers.py            (npm run headers)
     python3 tools/update_headers.py --check    (ใช้ใน CI: ล้มถ้าหัวไฟล์ไม่ตรงกับโค้ด)"""
import re, sys, glob, os
check = '--check' in sys.argv
bad = 0
for p in sorted(glob.glob('public/js/**/*.js', recursive=True)):
    s = open(p, encoding='utf-8').read()
    m = re.match(r'(/\* =+\n(?: \*[^\n]*\n)*? \* ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ \(window\.\*\):\n)((?: \*[^\n]*\n)*?)( \* =+ \*/\n)', s)
    if not m: continue
    body = s[m.end():]
    names = []
    for n in re.findall(r'window\.(\w+)\s*=', body):
        if n not in names: names.append(n)
    text = ', '.join(names) if names else '(ไม่มี)'
    lines, cur = [], ''
    for part in text.split(', '):
        piece = part + ','
        if len(cur) + len(piece) + 1 > 92 and cur: lines.append(cur); cur = ''
        cur = (cur + ' ' + piece).strip()
    lines.append(cur)
    lines[-1] = lines[-1].rstrip(',')
    new = m.group(1) + ''.join(' * ' + l + '\n' for l in lines) + m.group(3) + body
    if new != s:
        if check: print('หัวไฟล์ไม่ตรงกับโค้ด:', p); bad += 1
        else: open(p, 'w', encoding='utf-8').write(new)
sys.exit(1 if bad else 0)
