# POS Local Blueprint v2.0.0

This bundle is a revised schema foundation and API contract for a single-shop hardware-store POS.

## Architecture
- PWA frontend: GitHub Pages.
- Local Server: runs on the shop LAN and exposes `/api/v1`.
- PostgreSQL: authoritative data and accounting calculations.
- Google Sheets: asynchronous reporting/sync destination only.
- Users: individual username + PIN; all authenticated users have equal business permissions.
- Audit: append-only activity history with actor, action, entity, time, outcome and request/device metadata.

## Important limitation
This is **not a production-certified complete application**. The SQL establishes core tables and a few helper functions, but does not yet implement all transactional business operations such as complete sale creation, returns, voids, purchase receiving, shift open/close, reports, authentication/session API, or Google Sheets worker. Do not point a live shop at it until those pieces and the security grants are completed and tested.

## Files
- `schema.sql`: PostgreSQL schema foundation.
- `api-contract.md`: intended PWA/Local Server interface and accounting invariants.
- `acceptance-tests.md`: manual/automated test cases required before production.
- `README.md`: deployment and limitations.

## Initial deployment outline
1. Create a new PostgreSQL database on the Local Server and take a backup before any schema changes.
2. Review `schema.sql`; run it only on the intended database with an administrative account.
3. Implement the Local Server according to `api-contract.md`. Never connect the browser directly to PostgreSQL.
4. Bind the Local Server to the shop LAN only; configure firewall rules and HTTPS where practical.
5. Implement PIN hashing with a vetted password-hashing library in the server (Argon2id preferred), login throttling, session token hashing, expiry and revocation.
6. Add least-privilege database roles/grants. Do not expose the PostgreSQL port publicly.
7. Implement the remaining transactional operations and tests before entering real sales data.
8. Configure automated backups and test a restore on a separate database.
9. Configure the Sheets sync worker to consume `sync_outbox` idempotently.
10. Keep GitHub Pages limited to static frontend assets; never put DB passwords or service secrets in the repository.
