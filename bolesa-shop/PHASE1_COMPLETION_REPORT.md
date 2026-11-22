# Phase 1 Completion Report — Bolesa Shipping Plugin MVP

**Date:** 2026-11-19  
**Plan:** Revision 2 (`vendure_bolesa_integration_d2695136.plan.md`)  
**Scope:** Single-channel Bolesa shipping plugin inside `bolesa-shop` only. No webhooks, no SaaS provisioning, no Bolesa core changes.

**Production readiness:** **Not claimed.** No sandbox Partner token end-to-end run was performed (Docker unavailable in this environment; no approved sandbox token).

---

## 1. Implemented features

| # | Feature | Status |
|---|---------|--------|
| 1 | Bolesa Partner API client (`XP-Api-Token`, `Idempotency-Key`, typed errors, 15s timeout) | Done |
| 2 | Channel-scoped `BolesaConnection` with encrypted token via `DefaultEncryptionStrategy` | Done |
| 3 | Address/Order/Fulfillment/ProductVariant custom fields + Shop `bolesaSearchCities` | Done |
| 4 | `bolesa-eligibility` ShippingEligibilityChecker (`shouldRunCheck`) | Done |
| 5 | `bolesa-rate` ShippingCalculator with CacheService + EGP minor/major conversion | Done |
| 6 | Persist selected quote on `OrderPlacedEvent` → `Order.customFields.bolesaQuote` (Admin-only) | Done |
| 7 | `bolesa-cod` handler: Authorized at checkout; settle on DELIVERED; remittance separate | Done |
| 8 | Fulfillment-first async AWB: validate in handler (no HTTP); outbox on `FulfillmentEvent`; job creates AWB | Done |
| 9 | Idempotent AWB: pre-check `meta[vendure_shipment_key]`, attempt-scoped keys, 4xx fail / 5xx+409 retry, Admin retry | Done |
| 10 | Cancel via background job; block manual Cancelled until Bolesa CANCELED | Done |
| 11 | Reconciliation scheduled task (every 15 min) — forward-only status map | Done |
| 12 | Admin GraphQL + Dashboard connection page + order-detail shipment block | Done |
| 13 | Automated unit tests with mocked `fetch` | Done (22 pass) |

**Labels:** Safe unavailable / `url_present` only. Documented required Bolesa endpoint in `apps/server/src/plugins/bolesa/LABEL_ENDPOINT.md`. No download/proxy that pretends S3 works.

---

## 2. Database migrations

File: `apps/server/src/migrations/1763590000000-bolesa-phase1.ts`

- Tables: `bolesa_connection`, `bolesa_shipment` (+ channel join tables)
- Unique: `fulfillmentId`, `shipmentKey`, `idempotencyKey`; partial unique on `trackingNumber` when not null
- Custom field columns on `product_variant`, `address`, `order`, `fulfillment`

**Not applied in this session** — Docker CLI unavailable (`docker: not found`). Apply with:

```bash
cd bolesa-shop/apps/server
docker compose up -d postgres_db
npx vendure migrate
# or: npm run start:server after ensuring migrations run via index.ts
```

---

## 3. API endpoints consumed

| Method | Path | Use |
|--------|------|-----|
| GET | `/me` | Connection test |
| POST | `/geo/cities/search` | Shop city picker |
| POST | `/services/options` | Live rates |
| POST | `/awbs` | Create AWB (async job) |
| GET | `/awbs?meta[vendure_shipment_key]=…` | Duplicate pre-check / adopt |
| GET | `/awbs/{tn}` | Reconcile / apply status |
| POST | `/awbs/{tn}/cancel` | Cancel job |
| GET | `/awbs/{tn}/tracking` | Client helper (not wired to UI yet) |

**Not used in Phase 1:** webhooks, statements remittance polling UI, label download.

---

## 4. Tests and results

Command: `npm run test:bolesa` (workspace `server`)

```
# tests 22
# pass 22
# fail 0
```

Coverage:

- Client: success mapping, 422 definite failure, 409 retryable, 202 queued, Idempotency-Key + XP-Api-Token headers
- Money: minor ↔ major EGP
- Status map: forward targets, stale ignore, terminal detection
- Rates: prepaid/COD absorb/passToCustomer, markup, public metadata whitelist
- COD handler: Authorized then settle/cancel
- Duplicate key / channel isolation helpers

Also:

- `npm run typecheck` — **pass**
- `npm run build:server` — **pass** (1.7s)

**Not run:** live e2e against Postgres/Vendure bootstrap (Docker missing); dashboard Vite build; sandbox AWB creation.

---

## 5. Remaining blockers

1. **Sandbox Partner API token** — required before any real AWB / rate smoke test.
2. **Docker / Postgres** — migration and server boot not verified here.
3. **Bolesa label endpoint** — Phase 0 S3 403; see `LABEL_ENDPOINT.md`.
4. **Shipper `resolution_hash`** — merchant must configure shipper address via Admin before rates work.
5. **Shipping method + payment method seed** — Admin must create ShippingMethod (`bolesa-eligibility` + `bolesa-rate` + `bolesa-fulfillment`) and PaymentMethod (`bolesa-cod`).
6. **Product `weightKg`** — required on variants or fulfillment validation fails.
7. **Webhooks** — deferred to Phase 2; polling only for now.
8. **COD remittance** — fields exist (`codRemittanceStatus`); statement/`awb_no` wiring is Phase 2/3.

---

## 6. Manual UI testing instructions

Prerequisites: Postgres up, migration applied, `VENDURE_ENCRYPTION_KEY` set (stable), optional `BOLESA_API_BASE_URL`.

```bash
cd bolesa-shop
npm run dev:server   # server + worker + dashboard
```

1. **Permissions:** Grant SuperAdmin (or role) `ReadBolesaConnection`, `WriteBolesaConnection`, `ReadBolesaShipment`, `WriteBolesaShipment`.
2. **Connection:** Dashboard → Settings → Bolesa Connection, or Admin GraphQL:

```graphql
mutation {
  updateBolesaConnection(input: {
    apiBaseUrl: "https://<sandbox>/api/pcl/v1"
    token: "<sandbox-token>"
    shipperAddress: {
      name: "Warehouse"
      phone: "01xxxxxxxxx"
      country_code: "EG"
      resolution_hash: "<from city search>"
      address_line: "..."
    }
    codEnabled: true
    codFeeMode: "absorb"
  }) { id tokenLast4 isActive labelNote }
  testBolesaConnection { ok message }
}
```

3. **Catalog:** Set `ProductVariant.customFields.weightKg`.
4. **Shipping method:** checker `bolesa-eligibility`, calculator `bolesa-rate`, fulfillment handler `bolesa-fulfillment`.
5. **Payment method:** handler `bolesa-cod` (and a prepaid method as needed).
6. **Shop:** `bolesaSearchCities(query)` → set `shippingAddress.customFields.bolesaCityHash`; set `order.customFields.paymentPreference`.
7. **Checkout** → place order → Admin fulfill with Bolesa handler → watch shipment sync (`requested` → `created`) and tracking.
8. **Failures:** force 422 → `failed` + Retry (bumps attempt). Cancel via “Cancel Bolesa shipment”.
9. **Labels:** expect unavailable / url_present warning — **no working download**.

---

## 7. Required before Phase 2

- Successful **sandbox** end-to-end: rates → place → fulfill → AWB → poll status → COD settle on DELIVERED.
- Bolesa **label** authenticated endpoint (or signed URLs).
- Confirm Nest/Vendure **raw body** strategy for webhook HMAC (Phase 0 spike guidance).
- Optional: seed script for shipping/payment methods + Egypt channel defaults.
- Do **not** start multi-tenant provisioning until Phase 4.

---

## Plugin layout

```
apps/server/src/plugins/bolesa/
  api/           Admin + Shop GraphQL
  config/        checkers, calculator, COD, fulfillment, custom fields
  dashboard/     connection page + order shipment block
  entities/      BolesaConnection, BolesaShipment
  services/      client, connection, rates, shipment jobs, reconcile task
  tests/         unit specs (mocked Bolesa)
  LABEL_ENDPOINT.md
```

Wired in `apps/server/src/vendure-config.ts` via `BolesaPlugin.init(...)` + `systemOptions.encryptionStrategy`.
