# Hardware POS — v1.8.0

> รุ่นปัจจุบันของชุดไฟล์นี้คือ v1.8.0 (ดู `CHANGELOG.md`) ส่วนหัวข้อรุ่นเก่าด้านล่างเป็นประวัติการพัฒนาและอาจกล่าวถึงข้อจำกัดที่ถูกแก้ไขในรุ่นถัดมา

## รุ่นล่าสุด: รายงานจากฐานข้อมูลและกระทบยอด
- รายงานยอดขายตามช่วงวันที่จาก PostgreSQL พร้อมยอดขายก่อน/หลังคืนสินค้า จำนวนบิล และบิลที่ยกเลิก
- ยอดรับชำระแยกตามเงินสด/โอน/เครดิต/วิธีอื่น
- ยอดขายรายวันและสินค้าขายดี 20 อันดับ
- รายงานกะเงินสด: ยอดขายเงินสด คืนเงินสด ยอดคาดหมาย ยอดนับจริง และผลต่าง
- สรุปจำนวนใบรับสินค้าและมูลค่ารับเข้าคลัง
- ส่งออกรายงานเป็น CSV ที่รองรับภาษาไทย
- API ป้องกันช่วงวันที่ผิดรูปแบบหรือยาวเกิน 367 วัน

## ติดตั้ง/อัปเดต
1. สำรองฐานข้อมูลก่อนเปลี่ยนรุ่น
2. ตรวจสอบและรัน `backend-blueprint/schema.sql` กับฐานข้อมูลใหม่ หรือใช้ migration ที่ตรงกับรุ่นเดิม
3. ใน `backend/` ใช้ Node.js 20+, คัดลอก `.env.example` เป็น `.env` และกำหนด `DATABASE_URL`
4. รัน `npm install` และ `npm test` จากโฟลเดอร์ `backend/`
5. เริ่ม API ด้วย `npm start` และให้บริการ `index.html` ผ่าน HTTP origin ที่อยู่ใน `CORS_ORIGINS`
6. ใน POS ไปที่ **ตั้งค่าร้าน → เข้าสู่ระบบ API** แล้วกลับไปเมนู **รายงาน** เลือกช่วงวันที่และกด **ดูรายงาน**

## API รายงาน
`GET /api/v1/reports/summary?from=2026-10-01&to=2026-10-13`

ต้องส่ง `Authorization: Bearer <session_token>` เช่นเดียวกับ API ที่ต้องล็อกอินทั้งหมด ช่วงวันที่เป็นแบบรวมวันเริ่มต้นและวันสิ้นสุด และจำกัดไม่เกิน 367 วัน

## ข้อจำกัดสำคัญ
โปรเจกต์นี้ยังเป็น starter สำหรับพัฒนาและทดสอบ ไม่ใช่ระบบที่รับรองพร้อมใช้งานเชิงพาณิชย์ แม้ unit tests จะผ่านแล้ว แต่ยังไม่ได้รัน integration/end-to-end tests กับ PostgreSQL จริง รายงานกำไรเป็นเพียงค่าประมาณจากต้นทุนที่บันทึกในบิล ไม่รวมค่าใช้จ่ายดำเนินงาน ภาษี หรือการปรับต้นทุนย้อนหลัง ควรทดสอบกับฐานข้อมูลสำรองและตรวจผลรวมกับธุรกรรมจริงก่อนใช้งานหน้าร้าน

---

# แอปขายหน้าร้านอุปกรณ์ฮาร์ดแวร์ (ต้นแบบ)

## เริ่มใช้งาน
1. แตกไฟล์ ZIP
2. เปิด `index.html` ด้วย Chrome, Edge หรือ Safari
3. เข้าเมนู **ขายหน้าร้าน** เพื่อทดลองเพิ่มสินค้าและออกบิล

## ฟังก์ชันในต้นแบบ
- หน้าภาพรวมยอดขายและสินค้าใกล้หมด
- POS ค้นหาสินค้า เลือกหมวดหมู่ ตะกร้า ส่วนลด ชำระเงิน และใบเสร็จพิมพ์ได้
- เพิ่ม/แก้ไขสินค้า, SKU, หน่วย, ต้นทุน, ราคาขาย, สต็อก และจุดเตือน
- ปรับสต็อกเข้า/ออก/ตั้งยอด
- ประวัติการขายและส่งออก CSV
- รายชื่อลูกค้าและเครดิตตั้งต้น
- รายงานเบื้องต้น
- ตั้งค่าร้าน สำรอง/นำเข้าข้อมูล JSON

## ข้อจำกัดสำคัญ
นี่คือ **ต้นแบบที่เก็บข้อมูลใน Local Storage ของเบราว์เซอร์** เพื่อทดลองหน้าจอและขั้นตอนการขายเท่านั้น ไม่ใช่ระบบพร้อมใช้งานเชิงพาณิชย์:
- ข้อมูลไม่ซิงก์ข้ามอุปกรณ์และอาจหายเมื่อเคลียร์ข้อมูลเบราว์เซอร์
- ยังไม่มี API/ฐานข้อมูลส่วนกลาง, ล็อกอิน PIN, ระบบหลายเครื่อง, สิทธิ์ผู้ใช้, ระบบรับซื้อเข้า/คืนสินค้า/ยกเลิกบิล/ปิดกะเงินสด และการเชื่อม Google Sheets
- การคำนวณในหน้าเว็บไม่ใช่บัญชีทางการ และยังไม่ผ่าน acceptance tests สำหรับใช้งานจริง
- อย่าใช้กับการขายจริงหรือข้อมูลลูกค้าจริงจนกว่าจะพัฒนา backend, ระบบสำรอง, ความปลอดภัย และทดสอบธุรกรรมครบ

ไฟล์ `pos-local-blueprint-v2.0.0.zip` ที่ให้มาเป็น blueprint/schema และ API contract แยกต่างหาก สามารถนำมาใช้เป็นแนวทางพัฒนา backend ต่อได้


## v0.4 — API connection starter
The `index.html` frontend now includes a connector under **ตั้งค่าร้าน → เชื่อมต่อฐานข้อมูล PostgreSQL ผ่าน API**. It can log in with the backend PIN session, load product/stock and recent bill summaries, create products, adjust inventory, submit cash/transfer sales, and update shop settings through the API. Local demo data is not automatically imported into PostgreSQL; connect to a newly initialized database or explicitly migrate data with a reviewed import process.

### Frontend connection steps
1. Configure PostgreSQL and run `backend-blueprint/schema.sql`.
2. In `backend/`, copy `.env.example` to `.env`, set the database credentials, then run `npm install` and `npm start`.
3. Initialize the owner account once using the documented `/api/v1/setup/initialize` endpoint in `backend/README.md`.
4. Serve the project directory from `http://localhost:5500` or `http://127.0.0.1:5500` (for example with a local static-file server). Avoid opening `index.html` directly as a `file://` URL because browser CORS behavior varies.
5. In the POS Settings page, enter the API URL (usually `http://127.0.0.1:8787`), username and PIN, then connect.
6. Run `cd backend && npm test`.

Historical note for the early API connection starter (before v1.7.0): at that stage it supported only one base unit per variant. Later release notes below describe additions made in subsequent versions. Backend and database acceptance tests on a real PostgreSQL instance are still required before live use.


## v0.7 — CSV product import
- In **สินค้าและราคา**, choose **ไฟล์ตัวอย่างนำเข้า** to download a CSV template. Excel workbooks should be saved as CSV UTF-8 before import.
- Use columns `SKU`, `Name`, `Category`, `Barcode`, `Unit`, `CostPrice`, `SalePrice`, `OpeningStock`, `LowStockThreshold`. Thai aliases for common column names are also accepted.
- Import supports up to 500 rows per batch and shows a preview with row-level errors. Duplicate SKU/barcode rows are excluded.
- Import is **create-only**: existing product records and stock are not overwritten. Opening stock is only applied to newly created products.
- In API mode, the backend validates again and commits the batch in one database transaction. If a conflict appears after preview, the batch is rejected without partial import.
- Run `cd backend && npm test` to run the unit tests. Real PostgreSQL integration testing is still required before production use.


## การจัดซื้อและรับสินค้า (v0.9.0)

API ชุดนี้ต้องยืนยันตัวตนด้วย `Authorization: Bearer <session_token>` เช่นเดียวกับ API อื่น และใช้ PostgreSQL schema ใน `backend-blueprint/schema.sql`

- `GET /api/v1/suppliers?query=` — ค้นหาผู้จำหน่ายที่เปิดใช้งาน
- `POST /api/v1/suppliers` — สร้างผู้จำหน่ายด้วย `name` และข้อมูลเสริม `phone`, `tax_id`, `address`, `note`
- `GET /api/v1/purchase-orders?status=open` — ดูใบสั่งซื้อพร้อมจำนวนสั่ง/รับแล้ว/ค้างรับ
- `POST /api/v1/purchase-orders` — สร้างใบสั่งซื้อ ต้องมี `Idempotency-Key` และ `items: [{variant_id, quantity, unit_cost}]` (1–200 รายการ)
- `POST /api/v1/purchase-orders/:id/receive` — รับสินค้าทั้งหมดหรือบางส่วน ต้องมี `Idempotency-Key` และ `items: [{variant_id, quantity, unit_cost?}]`; หากไม่ส่ง `unit_cost` จะใช้ต้นทุนจากใบสั่งซื้อ
- `GET /api/v1/purchase-receipts` — ประวัติการรับสินค้า

การรับสินค้าอัปเดตยอดคงเหลือ, `inventory_movements`, ประวัติใบรับสินค้า และสถานะใบสั่งซื้อใน transaction เดียวกัน รองรับรับบางส่วนและป้องกันรับเกินยอดสั่งซื้อ ใช้ idempotency key ป้องกันการบันทึกซ้ำ และปรับต้นทุนสินค้าเป็นต้นทุนถัวเฉลี่ยถ่วงน้ำหนักหลังรับสินค้า การทำงานนี้เป็น API backend; ยังไม่มีหน้าจอจัดซื้อ/รับสินค้าใหม่ใน UI รุ่นนี้


## v0.9.0 — หน้าจอจัดซื้อและรับสินค้า
- เพิ่มเมนูจัดซื้อ/รับสินค้าในหน้า POS และแสดงใบสั่งซื้อ ผู้จำหน่าย และประวัติรับสินค้า
- เพิ่มฟอร์มสร้างผู้จำหน่ายและใบสั่งซื้อหลายรายการ พร้อมตรวจจำนวน/ต้นทุนก่อนส่ง API
- เพิ่มฟอร์มรับสินค้าบางส่วนหรือครบ โดยจำกัดจำนวนไม่ให้เกินยอดค้างรับ และบันทึกผ่าน API แบบ idempotent
- หน้าจอนี้ใช้ได้เมื่อเชื่อมต่อ API สำเร็จเท่านั้น ข้อมูลการจัดซื้อไม่ถูกเก็บเป็นเดโมใน Local Storage เพื่อป้องกันข้อมูลจำลองถูกเข้าใจว่าเป็นสต็อกจริง
- ต้องทดสอบกับ PostgreSQL จริงก่อนใช้งานร้านจริง

## Sales returns (v1.0.0)

Retrieve a bill and its return history by bill UUID or bill number:

```http
GET /api/v1/sales/:id
Authorization: Bearer <session_token>
```

Create a partial or full return. `bill_item_id` must be the line-item UUID returned by the bill detail endpoint. Quantity supports up to 3 decimal places. The server calculates refund amounts from the bill's net line totals; clients must not send a refund amount.

```http
POST /api/v1/sales/:id/returns
Authorization: Bearer <session_token>
Idempotency-Key: <unique-operation-key>
Content-Type: application/json

{
  "reason": "สินค้าเสียหาย",
  "refund_method": "cash",
  "items": [
    { "bill_item_id": "<bill-item-uuid>", "quantity": 1 }
  ]
}
```

`refund_method` accepts `cash`, `transfer`, or `other`. Cash refunds require an open cash shift and create a `refund_cash` movement. Returns cannot exceed quantities originally sold minus previous completed returns, and the cumulative refund cannot exceed the amount paid on the bill. Inventory balance, inventory movement, return records, bill status, cash movement (when applicable), and audit log are updated in one database transaction.

**Important:** v1.0.0 exposes this workflow through the authenticated API; a dedicated return/refund screen in the POS frontend and an end-to-end test against a live PostgreSQL database remain future work. Test with a backup or staging database before handling real transactions.


## Sales return/refund screen (v1.1.0)

The POS frontend now has a dedicated **คืนสินค้า / คืนเงิน** page. With an authenticated API session, staff can search for a bill by bill number, review remaining returnable quantities and previous returns, select item quantities, enter a reason, choose cash/transfer/other, and submit to `POST /api/v1/sales/:id/returns`. The screen sends an `Idempotency-Key` and refreshes the server-backed data after success. Cash refunds require an open cash shift as enforced by the API.

This UI is available only when connected to the backend; demo/localStorage mode does not record actual server-side returns. The return amount and remaining quantities are recalculated and validated by the server. Unit tests pass, but a real PostgreSQL end-to-end run has not been performed. Test on a staging database before live transactions.


## v1.4.0 — Roles, permissions, and user administration

### Roles
- `owner`: full access, user management, shop settings, and audit log.
- `manager`: sales, returns, shifts, product/inventory operations, purchasing, reports, and audit log.
- `cashier`: sales, product lookup, and cash-shift operations.
- `inventory`: product maintenance, stock adjustments, and purchasing/receiving.
- `accountant`: read-only sales, shifts, reports, and audit log.

Authorization is enforced in the API. Unknown API paths and unsupported methods are denied after authentication; hiding a page in the frontend is not considered a security boundary.

### Upgrade existing database
1. Back up PostgreSQL first.
2. Apply `backend/migrations/002_roles_and_permissions.sql` using a database administrator.
3. Restart the API and log in again. If no active owner role exists, the migration promotes the oldest active user to owner.
4. Open **ผู้ใช้และสิทธิ์** in the POS while signed in as owner to create accounts, assign roles, enable/disable accounts, reset PINs, and inspect recent audit entries.

User-management API endpoints: `GET/POST /api/v1/users`, `PATCH /api/v1/users/:id`, and `GET /api/v1/audit-logs`. New users default to the cashier role. PINs must be 4–8 digits and are stored as scrypt hashes. Role changes, account deactivation, and PIN resets revoke the user's active sessions. At least one active owner must remain.

The default setup flow assigns the first user as owner and additional setup users as cashiers. Never expose the API directly to the public internet without further deployment hardening. This release has unit and syntax checks only; PostgreSQL integration tests, role-matrix end-to-end tests, and a production security review are still required.


## v1.5.0 — Approval workflow and product history

Before starting the API, back up PostgreSQL and apply `backend/migrations/003_approvals_and_product_history.sql`. The migration creates `approval_requests`.

### Approval API

- `GET /api/v1/approvals?status=pending` — owner/manager can review all requests; other roles see only their own requests.
- `POST /api/v1/approvals` — submit a request; requires `Idempotency-Key`. Supported `request_type`: `inventory_adjustment`, `product_price_change`, `product_cost_change`. All requests need `entity_id` (variant UUID), `reason` (3–500 characters), and `payload`. For inventory use `payload: {"quantity_delta": 12}`; for price/cost use `payload: {"value": 99.5}`.
- `POST /api/v1/approvals/:id/decision` — owner/manager approves or rejects with `{"decision":"approved","note":"ตรวจสอบแล้ว"}`. The requester cannot approve their own request. Approval applies the inventory movement or price/cost change in the same database transaction as the decision.
- `GET /api/v1/products/:variantId/history` — returns audit changes, stock movements and approval history for a product variant.

Policy: non-owner users cannot directly change sale price/cost through the product PATCH endpoint. Stock adjustments of 50 units or more require approval for non-owner users. Smaller stock adjustments retain the existing workflow. Rejections do not change product or stock data.

The approval UI is not included in this version; use the authenticated API endpoints until the dedicated review screen is implemented. Unit tests validate request/decision input but do not replace end-to-end tests against PostgreSQL.

## v1.6.0 — ตรวจนับสต็อกและกระทบยอด
- เปิดเมนู **ตรวจนับสต็อก** เมื่อเชื่อมต่อ API แล้ว เพื่อเริ่มรอบตรวจนับ บันทึกจำนวนจริงทีละรายการ และส่งให้ผู้จัดการ/เจ้าของร้านอนุมัติ
- API: `GET/POST /api/v1/inventory-counts`, `GET /api/v1/inventory-counts/:id`, `PATCH /api/v1/inventory-counts/:id/items/:itemId`, `POST /api/v1/inventory-counts/:id/submit`, `POST /api/v1/inventory-counts/:id/decision`.
- ต้องรัน migration `backend/migrations/004_inventory_counts.sql` หลังสำรองฐานข้อมูล และติดตั้ง/เริ่ม Backend ใหม่
- รอบตรวจนับเก็บยอดสต็อก ณ เวลาที่ snapshot หลังล็อกยอดสินค้าและเวลาที่นับสินค้าแต่ละรายการ ระบบคำนวณยอดตามบัญชี ณ เวลานับโดยรวม movement ระหว่างนั้น แล้วนำผลต่างไปปรับยอดปัจจุบัน เพื่อคงการขาย/รับเข้าที่เกิดหลังเวลานับไว้; หากผลจะทำให้สต็อกติดลบ ระบบปฏิเสธและต้องตรวจสอบรายการก่อน
- ผู้สร้างรอบตรวจนับไม่สามารถอนุมัติรอบของตนเองได้ การทดสอบ PostgreSQL แบบครบวงจรยังจำเป็นก่อนใช้จริง

## v1.8.0: product cards with multiple sizes/models

Apply `backend/migrations/006_product_variants_catalog.sql` after migrations 001–005 on an existing database. Back up the database first. Each variant can have its own SKU, barcode, base unit, cost, sale price, low-stock threshold, and stock, while sharing the parent product card name/category/image. In API-connected mode, open an existing product and choose **+ เพิ่มรุ่นสินค้า** to add another size/model/color. New variants can be created through `POST /api/v1/products/:productId/variants` with `variant_sku`, `variant_name`, `unit_name`, optional `barcode`, `cost_price`, `sale_price`, `low_stock_threshold`, and `opening_stock`.

The migration keeps the first variant's existing product SKU and assigns stable ID-based suffixes to additional variants that previously shared that SKU. Review the generated SKU values before printing barcode labels. Unit tests do not replace integration/end-to-end testing against a PostgreSQL database; test on a backup first.

## v1.7.0: barcode scanning and multiple sell units

Apply `backend/migrations/005_multi_sell_units.sql` after the earlier migrations. Inventory is always held in the variant's base unit (for example, each or metre). Add packaging units from **สินค้าและราคา → หน่วยขาย** with a unit name, optional barcode, conversion factor, and selling price. For example, a carton containing 12 pieces uses conversion factor `12`; selling one carton reduces stock by 12 base pieces. Scan a base or packaging barcode from the POS barcode field and press Enter.

The sales API accepts an optional `unit_id` on each item; when omitted, it sells in the base unit as before. Bill items keep the sold unit quantity and also record `base_quantity` and `unit_conversion_factor`. Returns restore base-unit inventory. Use the API-connected mode for server-managed sell units; local demo mode only resolves barcodes already loaded in local product data and does not persist multi-unit setup.
