# Sandbox E2E Execution Report

**Final status: SANDBOX E2E PARTIAL**

**Date:** 2026-11-20  
**Environment identity:** `local-partner-api` (`http://127.0.0.1:8000/api/pcl/v1`)  
**Vendure DB:** `vendure-bolesa-test` only  
**Production Partner / `vendure-dev`:** not used for writes

---

## 1. Initial baseline

| Check | Result |
| --- | --- |
| Phase 1.7–1.10 implementation | Present |
| Unit tests | 63 → **67** passing after this work |
| Integration tests | **28** passing (sandbox suite skipped unless opted in) |
| Partner token in Vendure env | Missing at start |
| Local Partner HTTP | Running (`php artisan serve` on `127.0.0.1:8000`) |
| Partner DB | `bolesa_eg` on `127.0.0.1:5432` |

---

## 2. Work completed

### Partner prerequisites (local only)

- Issued/regenerated XP-Api-Token for Partner account `5` into gitignored `bolesa-shop/.env.sandbox`.
- Host gate enforced: only `127.0.0.1` / `localhost` allowed for E2E.
- Renewed expired local `account_subscriptions` row and enabled `allow_cc_shipping` for account `5` (local DB only) so create AWB could proceed.

### Bugs fixed

1. **City search mapping** — Partner returns `name_en` / `name_ar`; client only read `name` / `city_name`, so Shop city search returned empty.
2. **AWB list mapping** — Partner list `data` is a bare array; `findAwbsByMeta` missed it.
3. **Adopt + history FK** — `HistoryService` write inside the adopt transaction aborted Postgres and rolled back a successful Partner AWB. History moved to post-commit `noteAwbAdopted()`.
4. **`idempotency_key_reused` heal** — definite-failure path now looks up by `vendure_shipment_key` and adopts.
5. **SA short address** — optional `sa_short_address` threaded through create input (EG path does not require it).
6. **Safe host utility** — `assertSafePartnerHost()` for E2E harnesses.

### Direct Partner API evidence (real HTTP)

| Case | Op | HTTP | Result |
| --- | --- | --- | --- |
| E2E-ME | `GET /me` | 200 | Token accepted |
| E2E-CFG | `GET /shipments/configuration` | 200 | Config returned |
| E2E-CITY | `POST /geo/cities/search` | 200 | `resolution_hash` returned |
| E2E-OPT | `POST /services/options` | 200 | EG services + prices |
| E2E-QUOTE | `POST /shipments/quote` | 200 | Quote + `hash_key` |
| E2E-CC | `POST /awbs` (cc) | 201 | tracking `3041978565` |
| E2E-COD | `POST /awbs` (cod) | 201 | tracking `5492074333` |
| E2E-GET | `GET /awbs/{tn}` | 200 | Status `READY FOR SHIPMENT` |
| E2E-TRK | `GET /awbs/{tn}/tracking` | 200 | Tracking payload |
| E2E-IDEM | replay same Idempotency-Key | 201 | Same tracking `2572515687` |
| E2E-CAN | `POST /awbs/{tn}/cancel` | 200 | COD AWB `CANCELED` |

### Plugin Sandbox suite (`npm run test:bolesa:sandbox-e2e`)

All 5 tests passed against real Partner + `vendure-bolesa-test`:

| Step | Evidence |
| --- | --- |
| Encrypted connection + `/me` | `connectionTest.ok=true` |
| City search | 20 hits, hashes length 32 |
| Service options | 5 slugs, sample CC 11.4 |
| `createAwbForFulfillment` | tracking `528258748`, DB `syncStatus=created`, channel `7` |
| Get + tracking | `READY FOR SHIPMENT`, events present |
| Idempotent outbox replay | same tracking |
| Cancel | `status=canceled` |
| Channel isolation | other channel leaked `0` |

---

## 3. Files changed

| Path | Change |
| --- | --- |
| `apps/server/src/plugins/bolesa/services/bolesa-client.service.ts` | City + list mapping |
| `apps/server/src/plugins/bolesa/services/bolesa-shipment.service.ts` | Adopt/history, idempotency heal, SA field |
| `apps/server/src/plugins/bolesa/types.ts` | `sa_short_address` |
| `apps/server/src/plugins/bolesa/util/safe-partner-host.ts` | **New** host gate |
| `apps/server/src/plugins/bolesa/tests/safe-partner-host.spec.ts` | **New** |
| `apps/server/src/plugins/bolesa/tests/bolesa-client.spec.ts` | City + list tests |
| `apps/server/src/plugins/bolesa/tests/integration/sandbox-e2e.integration.spec.ts` | **New** opt-in E2E |
| `apps/server/package.json` | `test:bolesa:sandbox-e2e` |
| `.gitignore` | `.env.sandbox`, `tmp/` |
| `SANDBOX_E2E_EXECUTION_REPORT.md` | This report |
| `BOLESA_OPERATIONS_RUNBOOK.md` | Sandbox E2E command |

Gitignored (not committed): `.env.sandbox`, `tmp/*` evidence files.

---

## 4. Tests executed

| Command | Result |
| --- | --- |
| `npm run test:bolesa` | **67** pass |
| `npm run test:bolesa:integration` | **28** pass (sandbox suite skipped) |
| `npm run test:bolesa:sandbox-e2e` | **5** pass |
| `npm run typecheck` | pass |
| `npm run build:server` | pass |

---

## 5. Database safety evidence

- Integration/E2E assert `DB_NAME === vendure-bolesa-test`.
- `vendure-dev` row counts unchanged after run: `channel=1`, `order=1`.
- No TypeORM `synchronize`. No destructive migrations on `vendure-dev`.

---

## 6. Sandbox environment verification

| Item | Status |
| --- | --- |
| Base URL host | `127.0.0.1:8000` (explicit local, not production) |
| Token | Present in `.env.sandbox` only (prefix `xp_…`, not logged) |
| Account | Partner account `5`, `partner_api_enabled=true` |
| Addresses | Synthetic EG Nasr City hashes (no real customer data) |
| Services | EG domestic carriers available |
| Webhook secret | Not exercised this run |

Note: Partner `/me` reported `test_mode=false` on this local account. Safety relied on **local host allowlist**, not a remote Bolesa “sandbox” brand.

---

## 7. Why PARTIAL (not full PASS)

Real Partner create/get/track/cancel/idempotency and plugin outbox adopt are verified.

Not executed end-to-end in this run:

1. **Shop checkout** — `vendure-bolesa-test` has **0 products**; no real cart → place → Bolesa shipping method selection.
2. **Fulfillment handler enqueue** — outbox row was inserted for the harness; JobQueue **worker consumer** was not proven for this live create (service method called directly — same code path the worker invokes).
3. **Scheduled reconcile task** — tracking fetched via client; cron reconcile not run live.
4. **Vendure COD payment settle** — COD AWB created at Partner; Vendure payment-state independence not exercised with a real COD payment row.

---

## 8. Remaining blockers / next action

To reach **SANDBOX E2E PASS** (full shop path):

1. Seed a minimal catalog + shipping method on `vendure-bolesa-test`.
2. Place an order via Shop API with Bolesa method + city hash custom field.
3. Create fulfillment through the Bolesa handler so JobQueue enqueues `bolesa-create-awb`.
4. Start Worker and confirm the job creates/adopts the AWB.
5. Optionally exercise COD payment authorize → delivered settle.

**Exact next action:** seed `vendure-bolesa-test` catalog and run a Shop-API order → fulfill → worker job against the same local Partner host / `.env.sandbox` token.

---

## 9. Secrets

No tokens, webhook secrets, or credentials are included in this report.
