## v1.8.0 — Product cards and per-variant catalog
- Added per-variant SKU while retaining a shared product card/name/category and per-variant barcode, price, cost, unit and inventory.
- Added authenticated `POST /api/v1/products/:productId/variants` to create a size/model/color variant with opening stock and inventory movement audit.
- Product list and barcode/sale lookups now return the variant SKU, so each size/model can be identified independently at checkout.
- Added a connected-API UI flow to create variants from an existing product card.
- Added migration `backend/migrations/006_product_variants_catalog.sql` and updated the database blueprint.
- Existing variants receive stable SKUs during migration: first variant retains the product SKU, additional variants receive a stable ID-based suffix. Review these generated SKUs before barcode label printing.
- Validation: automated unit tests and syntax checks run in this release; PostgreSQL integration tests are not performed.

## v1.7.0 — Barcode scanning and multi-level sell units
- Added configurable sell units such as packs, boxes and cartons with a barcode, conversion factor to the stock/base unit, and a separate sale price.
- Added authenticated barcode lookup for both base-unit and packaging barcodes, plus POS barcode scan input.
- Sales now deduct converted base quantity from inventory while preserving sold quantity, sell-unit name, conversion factor and base quantity on bill items.
- Returns restore the converted base quantity; cost reports use base quantity to avoid overstating or understating cost for packaging units.
- Added migration `backend/migrations/005_multi_sell_units.sql` and pure unit-conversion validation tests.

## v1.4.0 — Role-based access control and user administration
- Added five API-enforced roles: owner, manager, cashier, inventory, and accountant. Unknown API routes/methods are denied by default after authentication.
- Added owner-only user administration APIs to create accounts, change roles, activate/deactivate accounts, and reset PINs. PIN hashes are never returned.
- Added protection against disabling/demoting the last active owner and against disabling the currently logged-in account.
- Role/PIN changes revoke existing sessions so permission changes take effect on next login.
- Added a POS page for user administration and recent audit log viewing, available to owners.
- Added migration `backend/migrations/002_roles_and_permissions.sql`; for existing installations, back up the database and apply it before starting v1.4.0. The oldest active user is promoted to owner only if no active owner exists.
- Added six authorization unit tests. Validation: backend tests 30/30 passed; backend/frontend JavaScript syntax checks passed. PostgreSQL integration/end-to-end tests not performed.

# Changelog

## v1.3.0 — Database reports and reconciliation
- Added authenticated `GET /api/v1/reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD` reporting endpoint backed by PostgreSQL.
- Added date-range validation (real calendar dates, start not after end, maximum 367 days).
- Added summary metrics for sales, voided bills, returns/refunds, estimated gross profit, payment methods, daily sales, top products, cash-shift reconciliation, and completed purchase receipts.
- Replaced the browser-local-only report page with date-filtered API reports and CSV export. The page explicitly requires API connection and does not present demo-local values as authoritative reports.
- Added report date-range validation tests.
- Validation: backend unit tests 24/24 passed; Node syntax checks passed. PostgreSQL integration/end-to-end tests not performed.


## v1.1.0 — Sales return/refund UI
- Added a dedicated “คืนสินค้า / คืนเงิน” navigation page in the POS frontend.
- Added bill lookup by bill number or bill ID, recent-bill shortcuts, returnable-quantity display, and prior return history.
- Added a return dialog with per-item quantity, return reason, and refund method (cash/transfer/other).
- Connected the UI to the existing authenticated return API; uses an idempotency key per submission and refreshes stock/sales after success.
- API-connected bill rows now retain bill ID and status for the return workflow.
- Offline/demo mode explicitly directs staff to connect the API instead of pretending a real return was recorded.
- Validation: backend unit tests 18/18 passed; JavaScript syntax check passed. PostgreSQL end-to-end testing not performed.

## v0.9.0
- Added a purchasing screen to the POS frontend with supplier list, purchase orders, and receipt history.
- Added supplier creation and purchase order creation with multiple product lines.
- Added partial/full receiving UI with remaining-quantity limits and idempotency keys.
- Purchasing screens require an authenticated API connection; no fake local purchasing records are created.
- PostgreSQL integration testing remains required.

# Changelog

## v0.7.0
- Added CSV product import from Excel-exported CSV, with an example template.
- Added pre-import validation for required SKU/name, numeric values, duplicate SKUs/barcodes in the file, and existing products in API mode.
- Import is create-only and atomic on the API: it never updates existing product records or existing stock balances.
- Imported opening stock is written to inventory balances and a corresponding opening movement is recorded.
- Limited batches to 500 rows and files to 2 MB in the frontend.
- Added automated tests for import validation and regression checks.


## v0.4.0
- Added Settings controls for API URL, PIN login, refresh, and logout.
- Added an API adapter to load product/stock and recent sales summaries from PostgreSQL.
- Routed new product creation, stock adjustments, sales checkout, and shop settings updates to the API when logged in.
- Added setup notes for serving the frontend from a CORS-allowed local origin.
- Known limits: product editing and customer/credit checkout are not connected; multi-unit conversions and live PostgreSQL integration tests are not included.


## v0.3.0
- Fixed inventory-adjustment idempotency lookup to use the actual `quantity_delta` column.
- Detects reuse of an inventory idempotency key for a different variant and returns a conflict.
- Allocates bill-level discounts proportionally across bill items so item line totals reconcile to the bill total.
- Requires any amount due to be explicitly allocated to a `credit` payment and associated customer.
- Includes request IDs in audit events generated by authenticated API requests.
- Added automated tests for discount allocation and cent rounding.

## Known limitations
- Several frontend views still use Local Storage semantics; remote customer/credit workflows and product editing are not yet connected.
- No live PostgreSQL integration test was run in this environment.
- Full production acceptance, backups, permissions/role checks, returns/voids, purchasing, shift close and device synchronization are still outstanding.


## v0.8.0 — Purchasing & Receiving
- Added supplier list/search and supplier creation endpoints.
- Added purchase order creation/listing with per-item ordered, received, and remaining quantities.
- Added partial and complete receiving with idempotency, over-receipt validation, transactional stock updates, inventory movement ledger, receipt history, and audit events.
- Received stock updates variant cost using weighted-average cost.
- Added pure validation tests for order and receipt payloads.
- Note: API/backend only; no new purchasing UI screen yet, and live PostgreSQL integration was not exercised in this build.

## v1.0.0 — Sales returns and refunds
- Added bill detail and return history endpoint: `GET /api/v1/sales/:id` (accepts bill UUID or bill number).
- Added idempotent partial/full return endpoint: `POST /api/v1/sales/:id/returns`.
- Return workflow validates remaining returnable quantity, rejects refunds above the amount actually paid, restores inventory and writes `sale_return` movements in the same transaction.
- Cash refunds require an open cash shift and are recorded in `cash_movements`; transfer/other refunds are recorded on the return without cash-drawer movement.
- Bill status becomes `partially_returned` or `returned`; audit logs capture return actions.
- Added return-input validation tests.


## v1.2.0 — Cash shifts and reconciliation
- Added API and POS screen to open a cash shift, view recent cash movements, record cash-in/cash-out, count cash and close the shift.
- Added idempotent shift open/close operations and audit log events.
- Cash sales now require an open shift and add `sale_cash` movements within the sale transaction.
- Added expected-cash calculation and reconciliation tests.
- Requires applying the updated schema to add idempotency columns to `shifts`.
- PostgreSQL integration and end-to-end UI testing are still required before real-store use.


## v1.5.0 — Approval workflow and product history
- Added auditable approval requests for inventory adjustments and product sale-price/cost changes.
- Added two-person approval: the requester cannot approve their own request; owner/manager decisions apply the change transactionally.
- Non-owner direct price/cost edits are blocked; stock adjustments of 50 units or more require approval.
- Added product variant history API combining audit events, inventory movements and approval history.
- Added migration `003_approvals_and_product_history.sql` and validation tests.
- Dedicated approval UI and PostgreSQL end-to-end validation remain follow-up work.

## v1.6.0 — Inventory counts and reconciliation
- Added inventory count sessions with a locked snapshot of book quantities at session start, item-by-item physical count entry, submission, and separate owner/manager decision.
- Reconciliation reconstructs book quantity at each item’s physical-count timestamp from the session snapshot plus ledger movements up to that time, then applies the variance to the current balance to preserve movements after the physical count.
- Approved differences are recorded as inventory adjustment movements and audit events in one database transaction; negative resulting stock is rejected.
- Added two-person approval, role-protected API routes, migration `004_inventory_counts.sql`, frontend count workflow, and validation tests.
- PostgreSQL end-to-end testing is still required before live-store use.
