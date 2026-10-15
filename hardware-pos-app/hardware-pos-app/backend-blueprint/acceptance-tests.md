# Acceptance tests required before production

These are requirements, not claims that tests have already passed.

## Authentication and audit
- [ ] First-run setup succeeds once; a second initialization attempt is rejected.
- [ ] Two users can log in with different PINs; users have equal business access.
- [ ] Wrong PIN attempts are rate-limited and audited; locked users cannot log in.
- [ ] PINs and session tokens never appear in DB plaintext, browser storage logs, or audit payloads.
- [ ] Every create/update/void/return/payment/stock adjustment records actor, timestamp, action, outcome and entity.
- [ ] Ordinary application DB role cannot update/delete audit history.

## Sales and stock
- [ ] Sale totals are calculated on the server using decimal arithmetic and documented rounding.
- [ ] Sale with multiple payment methods reconciles exactly to total.
- [ ] Credit remainder requires a customer and increases debt ledger, not cash drawer.
- [ ] Two simultaneous sales cannot oversell stock.
- [ ] Repeating the same idempotency key does not create duplicate bills/payments/stock movements.
- [ ] A failed sale leaves no partial bill, payment, ledger or stock movement.
- [ ] Return quantity cannot exceed sold quantity minus previous returns.
- [ ] Voiding a bill creates reversal records and does not delete financial history.

## Purchasing and cash drawer
- [ ] Partial purchase receipts add only received quantities.
- [ ] Retrying a receipt request does not duplicate inventory.
- [ ] Shift expected cash includes only cash movement types, not transfer or credit.
- [ ] Shift close stores counted cash and calculated difference.
- [ ] Only one open shift exists under the default policy.

## Reporting, sync, backup
- [ ] Day/month/year reports reconcile to underlying bills, payment splits, returns and voids.
- [ ] Seller totals are grouped by authenticated seller identity.
- [ ] Sheets outage does not block local sales; outbox retries without duplicates.
- [ ] Backup checksum verifies; restore tested on a separate database.
- [ ] LAN/internet outage scenarios are tested separately and documented.
