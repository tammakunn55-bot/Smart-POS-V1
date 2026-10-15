# POS Local API contract — v2.0.0

This contract is the interface target for the PWA and Local Server. PostgreSQL is the source of truth.
Google Sheets is a downstream reporting/sync destination only. All users have equal business permissions;
authentication identifies the actor but does not assign role-based access.

## Transport and common rules
- Base URL: `http://<local-server-host>:<port>/api/v1`
- JSON UTF-8; timestamps are ISO-8601 with timezone; currency is THB.
- Every mutation requires `Idempotency-Key` (unique per user action) and a valid session.
- Server derives `actor_user_id` from the session; never trust an actor ID sent by the browser.
- PIN and session tokens must never appear in audit payloads or application logs.
- Monetary amounts are decimal strings or JSON numbers validated and converted to PostgreSQL `numeric`; do not use floating-point arithmetic for authoritative calculations.
- Errors: `{ "error": { "code": "...", "message": "...", "request_id": "..." } }`.
- Authentication failures are rate-limited and audit logged.

## Setup and authentication
- `GET /setup/status` — returns `{ "initialized": boolean }`.
- `POST /setup/initialize` — only before initialized; body includes `shop: {shop_name, phone?, tax_id?, address?, receipt_footer?}` and `users: [{username, display_name, pin}]`. Validate PIN strength and unique usernames; hash PIN server-side; create settings and initial users in one transaction.
- `POST /auth/login` — `{username, pin, device_id?, device_label?}`; returns `{session_token, expires_at, user:{id,username,display_name}}`. Store only a cryptographic hash of the session token.
- `POST /auth/logout` — revoke current session.
- `GET /auth/me` — current user/session status.
- `POST /users` — create another user; body `{username, display_name, pin}`.
- `PATCH /users/{id}` — update display name / active state; PIN changes use `POST /users/{id}/change-pin`. No roles or permissions fields.
- `POST /users/{id}/change-pin` — change PIN after current-session reauthentication or server-approved identity verification.

## Shop and catalog
- `GET/PATCH /shop`
- `GET/POST /categories`; `PATCH/DELETE /categories/{id}` (delete only if unused; otherwise deactivate).
- `GET/POST /suppliers`; `PATCH/DELETE /suppliers/{id}` (deactivate if referenced).
- `GET /products?query=&category_id=&low_stock=&active=`
- `POST /products`; `GET/PATCH /products/{id}`; `POST /products/{id}/deactivate`
- `POST /products/import` — validate whole file, preview, then commit; report row-level errors.
- `GET /products/export?format=xlsx|csv`
- `POST /products/{id}/image` — server validates image type/size and returns a durable image URL. Do not expose storage secrets.
- Product variants are separate sellable units with unique optional barcode, unit, cost, price, and low-stock threshold.

## Sales and inventory
- `POST /sales` — body `{customer_id?, items:[{variant_id, quantity, unit_price?, discount_amount?}], bill_discount?, payments:[{method, amount, reference_no?}], note?}`. Server locks inventory rows, reads canonical prices unless explicit price override is accepted by shop policy, computes all totals with numeric/rounding rules, rejects negative stock, and commits bill/items/payments/stock movements/customer ledger/audit/outbox atomically. If amount remains due, customer is required. `credit` payment is a debt component, not cash received.
- `GET /sales/{bill_id}`; `GET /sales?from=&to=&seller_id=&payment_method=`
- `POST /sales/{bill_id}/returns` — `{reason, items:[{bill_item_id, quantity}], refund_method, refund_amount?}`. Cannot return more than unreturned quantity; stock, refund, ledger and audit commit atomically.
- `POST /sales/{bill_id}/void` — `{reason}`; only allowed under configured business policy and only if return/settlement state is consistent. Create reversal records; do not delete the bill.
- `POST /inventory/adjustments` — `{variant_id, quantity_delta, reason}`; nonzero delta, stock cannot become negative unless an explicitly audited policy permits it.
- `GET /inventory/balances`; `GET /inventory/movements?variant_id=&from=&to=`
- `GET /inventory/low-stock`

## Purchasing, customers and debt
- `POST /purchase-orders`; `GET /purchase-orders`; `GET/PATCH /purchase-orders/{id}`
- `POST /purchase-orders/{id}/receipts` — supports partial receiving; each receipt adds stock once using idempotency keys.
- `POST /customer-payments` — `{customer_id, amount, method: cash|transfer|other, reference_no?, note?}`. Creates a payment receipt and ledger credit; never creates a sale.
- `GET /customers/{id}/ledger`; `GET /customers/{id}/balance`
- Customer balance = sum(debit_amount) - sum(credit_amount); any balance display must be based on ledger entries, not a mutable client-side field.

## Shifts and cash drawer
- `POST /shifts/open` — `{opening_cash, note?}`; only one open shift globally unless configuration explicitly changes that policy.
- `POST /shifts/{id}/cash-movements` — `{movement_type, amount, note?}`.
- `POST /shifts/{id}/close` — `{counted_cash, note?}`. Server calculates expected cash from opening float + cash sales + cash debt receipts + cash-in - cash-out - cash refunds. Transfer and credit are excluded from drawer cash.
- `GET /shifts`; `GET /shifts/{id}`

## Reports and sync
- `GET /reports/sales?period=day|month|year&date=YYYY-MM-DD` — totals, refunds/voids clearly separated, by cash/transfer/credit/other, by seller.
- `GET /reports/inventory`; `GET /reports/debts`; `GET /reports/audit?from=&to=&actor_user_id=&action=&entity_type=`
- `POST /sync/run` — enqueue/run pending outbox events to Google Sheets; retry safely; do not block sales on Sheets failure.
- `GET /sync/status`; `GET /sync/errors`; `POST /sync/errors/{id}/retry`
- `POST /backups` — start a backup job; server stores backup outside public web root and records checksum.
- `POST /backups/{id}/restore` — maintenance-only operational flow: require confirmation, create pre-restore backup, stop writes, validate checksum/schema, restore transactionally where possible, audit result.
- `GET /health` — process/DB readiness only; must not disclose secrets.

## Required transactional invariants
1. Sale: bill + items + payment splits + stock movements + customer ledger + audit + outbox are atomic.
2. Receipt of goods: receipt + receipt items + stock movements + cost update policy + audit + outbox are atomic.
3. Return/void: reversal entries are atomic; completed financial records are never hard-deleted.
4. All mutation endpoints are idempotent and safe to retry after a lost response.
5. PostgreSQL is authoritative. Google Sheets sync is asynchronous and may lag.
6. If internet is unavailable but LAN and Local Server remain up, local sales continue. If Local Server/LAN is down, multi-device sales require a separately designed per-device offline queue.
7. Equal privileges means no role authorization checks; it does not mean unauthenticated access or skipping PIN/session checks.
