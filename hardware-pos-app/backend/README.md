# Hardware POS Local API starter

This is a **development scaffold**, not a production-ready server. It adds a first server-side path for setup, PIN login, product catalog, stock adjustments, sales, and sales history. It uses the supplied `schema.sql` from `../backend-blueprint/`.

## Requirements
- Node.js 20+
- PostgreSQL 14+

## Setup
1. Create a dedicated empty PostgreSQL database and database user.
2. Review `../backend-blueprint/schema.sql` and run it against that database as a database administrator.
3. Copy `.env.example` to `.env`, then set `DATABASE_URL` to the dedicated application database credentials. Keep `.env` private and never commit it.
4. Run `npm install`, then `npm start`.
5. Check `GET http://127.0.0.1:8787/api/v1/health`.
6. Call `GET /api/v1/setup/status`. If not initialized, call `POST /api/v1/setup/initialize` once with `{ "shop": {"shop_name":"ร้านฮาร์ดแวร์"}, "users": [{"username":"owner","display_name":"เจ้าของร้าน","pin":"CHANGE_THIS_PIN"}] }`.
7. Log in using `POST /api/v1/auth/login`, then send `Authorization: Bearer <session_token>` for protected routes.

## Implemented routes
- `GET /api/v1/health`
- `GET /api/v1/setup/status`, `POST /api/v1/setup/initialize`
- `POST /api/v1/auth/login`, `GET /api/v1/auth/me`, `POST /api/v1/auth/logout`
- `GET/PATCH /api/v1/shop`
- `GET/POST /api/v1/products`
- `GET /api/v1/inventory/balances`, `POST /api/v1/inventory/adjustments`
- `GET/POST /api/v1/sales`

Mutating stock and sale requests require an `Idempotency-Key` header. Sale totals and stock changes are recalculated on the server and committed in a transaction.

## Not yet production-ready
- The `index.html` frontend has an early API connector (v0.4) for catalog reads, product creation, inventory adjustments, cash/transfer sales, and shop settings. Some screens still use Local Storage semantics; customer/credit workflows and product editing are not yet connected.
- The current API is a starter and has not been security-reviewed or acceptance-tested against a live PostgreSQL instance.
- Missing routes include returns/voids, purchase receiving, customer ledger/payment, shifts/cash drawer, user management/PIN change, audit browsing, image uploads, import validation, backup/restore service, and Google Sheets outbox worker.
- Configure strict database grants and network firewall before use. Bind to loopback by default. Do not expose PostgreSQL or this API publicly.
- Before live sales: add automated tests, proper audit request IDs, TLS for non-loopback access, operational monitoring, backup/restore drills, schema migration handling, and a full review of authorization and business invariants.


## Regression checks (v0.3)

Run `npm test` to check the pure sale-math rules. Current automated checks cover bill-discount allocation across bill lines, cent rounding, and invalid discounts. The API source can be syntax-checked with `node --check src/server.js`.

### Important transaction rules
- Every sale must account for the full net bill amount. Any unpaid portion must be explicitly included as a `credit` payment and tied to a customer; underpayment is not silently converted into debt.
- Bill-level discounts are allocated proportionally to `bill_items.discount_amount`; each line's `line_total` is stored net of its allocated discount. The sum of line totals should equal the bill total.
- Reusing an inventory `Idempotency-Key` for a different variant returns a conflict instead of reporting a false success.
- Audit entries for authenticated requests include the request ID for troubleshooting.

This remains a starter backend. Automated tests do not replace running the schema against a real PostgreSQL database and executing the full acceptance checklist before production use.


## Frontend connector (v0.4)
Serve the project folder from an origin listed in `CORS_ORIGINS` (default `http://localhost:5500,http://127.0.0.1:5500`) and open `index.html`. Do not use `file://` if CORS blocks the request. In Settings, enter the API base URL and an initialized username/PIN. The session token is stored in browser Local Storage; use a trusted device and log out when finished.

### v1.2.0 cash-shift migration
For an existing database, back it up and apply `migrations/001_cash_shift_idempotency.sql` before starting the v1.2.0 API. The full schema blueprint also includes these idempotency columns for fresh installs. Cash sales now require an open shift and are added to the cash ledger.


### v1.3.0 database reports
`GET /api/v1/reports/summary?from=2026-10-01&to=2026-10-13` requires an authenticated session. Dates are inclusive, must be valid `YYYY-MM-DD` calendar dates, and cannot span more than 367 days. Report results are queried from PostgreSQL. Estimated gross profit is not a formal accounting figure; verify timezone, tax, cost and return-accounting requirements before production use.
