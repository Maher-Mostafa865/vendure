# Sandbox E2E Execution Report

**Final status: LOCAL FULL E2E PASS**

**Date:** 2026-11-20  
**Environment identity:** `local-partner-api` (`http://127.0.0.1:8000/api/pcl/v1`)  
**Vendure DB:** `vendure-bolesa-test` only  
**Official remote Bolesa Sandbox:** **NOT VERIFIED**  
**Production readiness:** **NOT APPROVED**

This run completed the real Vendure Shop → Fulfillment → Outbox → Worker → Partner → Reconcile → COD settle → Cancel path against the **allowlisted local Partner host**. It is **not** an official remote Bolesa Sandbox verification. Partner `/me` reported `test_mode=false` on this local account; safety relied on the host allowlist and isolated test DB.

---

## 1. Status matrix

| Area | Result | Required evidence (sanitized) |
| --- | --- | --- |
| Partner connection | **PASS** | Real HTTP to `127.0.0.1:8000`; `/me` + configuration OK |
| Shop checkout | **PASS** | Shop API cart → address → Bolesa shipping → payment → order `9CDTZ5L57LBF92TQ` / COD `LFWQUPCPZKSZMB7A` |
| Shipping | **PASS** | Bolesa shipping method selected; `shippingPrice=1140` (minor units) |
| Fulfillment | **PASS** | Real `OrderService.createFulfillment` → Bolesa fulfillment handler (`fulfillmentId` 9 / 10) |
| Outbox | **PASS** | `bolesa_shipment` row `shipmentKey=bolesa-f9-c9`, `syncStatus=requested`, job `4361` `PENDING` before Worker |
| Worker | **PASS** | Real `bootstrapWorker`; queue `bolesa-create-awb` job `4361` → `COMPLETED` |
| AWB | **PASS** | Partner AWB `1387511730` bound to order `15` / channel `9` / fulfillment `9` |
| Reconciliation | **PASS** | Actual `bolesa-reconcile-shipments` via `ScheduledTask.execute`; `checked=1` |
| Tracking | **PASS** | Reconcile applied Partner status → Vendure `statusCode=DELIVERED` |
| COD | **PASS** | Payment `Authorized` amount `11140` → after DELIVERED `Settled` once; no double-settle |
| Cancellation | **PASS** | Prepaid path: `requestCancel` → `bolesa-cancel-awb` → `syncStatus=canceled` (AWB `1387511730`) |
| Idempotency | **PASS** | Single tracking row per fulfillment (`trackingRowsForFulfillment=1`) |
| Tenant isolation | **PASS** | Cross-channel leakage `0` |
| DB safety | **PASS** | Writes only to `vendure-bolesa-test`; `vendure-dev` channels=`1`, orders=`1` unchanged |

---

## 2. Full-flow evidence (latest run)

Source: `tmp/full-flow-e2e-evidence.json` (gitignored).

| Field | Value |
| --- | --- |
| Partner host | `127.0.0.1:8000` |
| Channel | `9` |
| Prepaid order | `15` / `9CDTZ5L57LBF92TQ` |
| Shipping price | `1140` |
| Consignee / shipper hash | `63f280b2…` / `4c227995…` (resolution hashes, no PII) |
| Outbox shipment | id `244`, key `bolesa-f9-c9`, initial `requested` |
| Create job | id `4361`, `PENDING` → `COMPLETED`, queue `bolesa-create-awb` |
| Prepaid AWB | `1387511730` → canceled |
| COD order | `16` / `LFWQUPCPZKSZMB7A` |
| COD payment | id `12`, `Authorized` → `Settled`, amount `11140` |
| COD AWB | `5420616036`, `codAmount=111.4` |
| Reconcile | task `bolesa-reconcile-shipments`, `checked=1`, `durationMs≈409` |
| Double-settle | Settled count remained `1` |

### COD DELIVERED fixture note

Local Partner has no safe public API to force `DELIVERED` for test AWBs. The suite updates `bolesa_eg.shipping_awbs.status_code` for the **test AWB only** (`account_id=5`), then runs the **real** registered reconcile task so Vendure applies tracking and settles COD. This is a deterministic local fixture exercising the actual reconciliation path — not a faked Partner HTTP success stub.

---

## 3. Prior Partner API baseline (still valid)

Direct real HTTP cases from the earlier partial run remain green: `/me`, configuration, city search, service options, quote, AWB create/get/tracking, idempotency, cancel. Plugin service-level sandbox suite also still passes.

---

## 4. Implementation notes from this continuation

- Dual in-process `bootstrap` + `bootstrapWorker` for isolated E2E (no `DefaultSchedulerPlugin` in that harness — croner name collision); reconcile still uses the real `bolesaReconcileTask` registered by `BolesaPlugin`.
- `ScheduledTask.execute` takes the Nest injector/`app` directly (`.get`), not `{ injector }`.
- Catalog/shipping/COD methods seeded into `vendure-bolesa-test` only via `seedFullE2eCatalog`.
- Fulfillment handler reloads `order.lines` before creating the outbox row.
- Host allowlist (`assertSafePartnerHost`) unchanged.

---

## 5. Verification commands

| Command | Result |
| --- | --- |
| `npm run test:bolesa` | **69** pass |
| `npm run test:bolesa:integration` | **28** pass (sandbox suites skipped without flag) |
| `npm run test:bolesa:sandbox-e2e` | **8** pass (5 plugin + 3 full-flow) |
| `npm run typecheck` | pass |
| `npm run build:server` | pass |

Opt-in: `BOLESA_SANDBOX_E2E=1` + gitignored `bolesa-shop/.env.sandbox`.

---

## 6. Safety

- Vendure writes: `vendure-bolesa-test` only (asserted before bootstrap).
- `vendure-dev` untouched (read-only check: channels=`1`, orders=`1`).
- No TypeORM `synchronize`; no destructive migrations; no production credentials.
- Partner traffic limited to explicit local host allowlist.
- Synthetic EG addresses / hashes only; secrets not logged.

---

## 7. Files (this continuation)

| Path | Role |
| --- | --- |
| `tests/integration/full-flow-e2e.integration.spec.ts` | Shop → Worker → reconcile → COD → cancel E2E |
| `tests/integration/full-e2e-helpers.ts` | Seed, Shop/Admin GraphQL, Partner status fixture |
| `tests/idempotency-key.spec.ts` | Idempotency key format regression |
| `bolesa.plugin.ts` | Idempotent dual-bootstrap-safe registration |
| `bolesa-fulfillment-handler.ts` | Reload lines; real outbox enqueue path |
| `package.json` | `test:bolesa:sandbox-e2e` includes full-flow suite |

Gitignored: `.env.sandbox`, `tmp/*`.

---

## 8. Final status declaration

- **LOCAL FULL E2E PASS** — Entire Vendure Shop → Fulfillment → Worker → Partner → Reconcile → COD settle → Cancel flow passed against the local Partner API.
- **Official remote Bolesa Sandbox:** **NOT VERIFIED**
- **Production readiness:** **NOT APPROVED** (requires separate production audit, remote sandbox credentials, and ops sign-off).
