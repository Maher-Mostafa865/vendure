# Sandbox E2E Execution Report

**Official remote status: OFFICIAL REMOTE SANDBOX E2E BLOCKED**  
**Local Full E2E:** **PASS** (re-run 2026-11-22 on `vendure-bolesa-test`, Partner `127.0.0.1:8000`)  
**Production readiness:** **NOT APPROVED**

**Date:** 2026-11-22 (local re-run). The 2026-11-20 baseline remains in section A.

Bolesa Laravel project path used: `/home/maher/projects/0-Project-Storage-Station/bolesa-egy`  
(note: `…/vendure/bolesa-eg` does not exist on disk)

---

## A. Local Full E2E (baseline)

| Area | Result |
| --- | --- |
| Local Partner (`127.0.0.1:8000`) Shop → Worker → AWB → reconcile → COD → cancel | **PASS** |
| DB safety (`vendure-bolesa-test`; `vendure-dev` untouched) | **PASS** |

Local `/me` for Account 5: `test_mode=false`. Safety relied on the **local host allowlist**, not remote Sandbox identity.

---

## B. Account 5 discovery (local `bolesa_eg` only)

Sanitized findings (no secrets, no customer PII):

| Item | Value |
| --- | --- |
| Local APP_ENV / APP_URL | `local` / `127.0.0.1` |
| Account | id `5`, `account_no=DCL17884376997315`, class `DIRECT_CLIENT`, type `MAIN`, `approved=true`, `active=true`, `can_shipping_awb=true` |
| Company | `Client Owner` (seed-style local account) |
| Partner API | `partner_api_enabled=true` |
| Shipping flags | `allow_cc_shipping=true`, COD AWBs present historically |
| Subscription | `ACTIVE` plan `2`, ends ~2027-02 |
| Users | user id `5`, **`test_mode=false`** |
| Tokens | 3 rows; **1 active** (`vendure-sandbox-e2e`, prefix redacted); issuing a new token revokes the previous (unique active-per-account index) — **not regenerated** this run |
| Webhooks | 1 active subscription (URL host redacted); secret not logged |
| Local AWBs | 28 total (mix cc/cod; many READY FOR SHIPMENT / CANCELED; 0 delivered) |
| Addresses | 25 rows; EG + SA city samples (Abdeen, Dokki, …) — usable as **city search hints**, not as remote credentials |

### Environment determination

| Question | Finding |
| --- | --- |
| Is local Account 5 also remote Account 5? | **Not proven.** Local DB only; no remote account id mapping in repo. |
| Does a remote Partner API exist? | **Yes (staging):** `https://dev-egy.bolesa.net/api/pcl/v1` returns Partner OpenAPI + `/me` → `401` without token. `sa-api-st.bolesa.net` currently TLS **525**. |
| Does Account 5 have an official remote Sandbox token? | **No.** Local token authenticates **only** on `127.0.0.1` (`/me` 200). Same token on `dev-egy.bolesa.net` → **`401 unauthenticated`**. |
| Authoritative Sandbox signal | Partner `/me` exposes **`test_mode`** (user flag). Local Account 5 has `test_mode=false`. `test_mode` scopes AWBs via `TestModeScope`; it is **not** an environment hostname brand. |
| Can Sandbox be provisioned from local Account 5 alone? | **No supported remote Sandbox provisioning** found. Client token issue/regenerate is per **local** account DB; regenerating would revoke the active local E2E token. |

**Conclusion:** Account 5 resources fully support **local** Partner E2E. They do **not** yield a verified official remote Sandbox credential. Staging Partner host existence ≠ Sandbox identity.

---

## C. Official remote matrix

| Area | Result | Notes |
| --- | --- | --- |
| Official Remote Sandbox connection | **BLOCKED** | No remote token; local token rejected by staging |
| Remote Shop-to-AWB | **BLOCKED** | Safety gate: no mutating calls without `/me.test_mode=true` |
| Remote tracking/reconciliation | **BLOCKED** | — |
| Remote COD | **BLOCKED** | — |
| Remote cancellation | **BLOCKED** | — |
| Independent Server/Worker (remote) | **BLOCKED** | — |
| Database safety | **PASS** | No remote mutating run; `vendure-dev` not written |

Non-mutating probes executed (no credentials on remote mutating paths):

- `GET https://dev-egy.bolesa.net/api/pcl/v1/me` → `401` (endpoint live)
- `GET https://dev-egy.bolesa.net/api/pcl/openapi.json` → `200`
- Local token → local `/me` → `200`, `test_mode=false`
- Local token → staging `/me` → `401`

`.env.remote-sandbox` was **not** written (would be incomplete / unsafe without a remote Sandbox token that proves `test_mode=true`).

---

## D. Reusable from Account 5 / local E2E (for when remote creds arrive)

| Asset | Reuse |
| --- | --- |
| Synthetic EG city search (`Nasr` / existing city names) | Yes, for remote city search once authenticated |
| Local resolution hashes + service slug patterns from prior local E2E | Starting point only — **must re-resolve on remote** |
| Vendure Shop → Worker harness | Yes (`vendure-bolesa-test`, remote host gate + identity checks) |
| Local Partner token / Account 5 id | **Local E2E only** — not interchangeable with remote |

---

## E. Safety gates (unchanged / strengthened)

- Local allowlist: `127.0.0.1` / `localhost` only (`assertSafePartnerHost`)
- Remote allowlist: https + explicit `BOLESA_REMOTE_SANDBOX_ALLOWED_HOSTS` (`assertOfficialRemoteSandboxHost`)
- Mutating remote E2E requires `/me.test_mode === true`
- No production credentials used; no remote AWB create/cancel; no token regeneration

---

## F. Final status

- **OFFICIAL REMOTE SANDBOX E2E BLOCKED** — remote staging Partner API host is reachable, but Account 5 provides **no** remote Sandbox token, and local identity is `test_mode=false`.
- **Local Full E2E:** **PASS** (2026-11-20 run; not re-executed for the 2026-11-22 currency review)
- **Production readiness:** **NOT APPROVED**

## G. 2026-11-22 currency and lifecycle review

Not a sandbox run. No remote AWB was created or cancelled. `vendure-dev` was not written by this review.

Code now refuses to charge a Partner shipping amount unless `price.currency` equals the Vendure channel currency. Egypt Partner config is EGP. Saudi Partner config is SAR. The `$` checkout symbol is the channel currency, not a Partner currency. Details and the AWB trigger decision are in `BOLESA_VENDURE_SHIPPING_ARCHITECTURE_REVIEW.md`.

The path `/home/maher/projects/0-Project-Storage-Station/bolesa-egy` from the 2026-11-20 note is not on this machine. The Partner tree used here is `/home/maher/Projects/bolesa-egy`.

## H. 2026-11-22 COD handler and currency precision

Not a sandbox run. No remote AWB was created. `vendure-dev` was not written.

COD for automatic fulfillment and for the AWB is the channel PaymentMethod handler `bolesa-cod`, not `order.customFields.paymentPreference`. Prepaid payments still wait for `PaymentSettled`. COD still waits for `PaymentAuthorized` and is not settled by that transition.

Money conversion uses `moneyStrategy.precision` (default 2). Unit tests cover precision 0, 2, and 3.

At the time of this section, integration and local sandbox E2E had not been executed. Section I is the later re-run. The prerequisites listed here were recovered after this note:

- `bolesa-shop/apps/server/.env.test`
- PostgreSQL database `vendure-bolesa-test` (only `vendure-dev` existed on `localhost:5432`; port `6543` from the 2026-11-20 run is not the current server)
- `bolesa-shop/.env.sandbox`

Those files were not invented at the time of this section, and `vendure-dev` was not copied or migrated.

## I. 2026-11-22 isolated environment recovery and re-run

PostgreSQL is only on `127.0.0.1:5432` (PostgreSQL 19). Port `6543` is closed. Role `vendure` has `CREATEDB`. Database `vendure-bolesa-test` did not exist and was created with `OWNER vendure`. `vendure-dev` was not migrated, reset, or written by the harness. The full-flow assertion recorded `vendure-dev` at 2 channels and 3 orders.

| File | Result |
| --- | --- |
| `apps/server/.env.test` | Created, gitignored. `DB_NAME=vendure-bolesa-test`, port `5432`. Partner URL in this file is the unroutable `http://127.0.0.1:9/forbidden-partner-api`. |
| `bolesa-shop/.env.sandbox` | Created, gitignored. Host `127.0.0.1:8000` only. Token reused from the existing local connection (last4 `mqQ6`), not printed. |
| `.env.remote-sandbox` | Still absent. Not invented. |

`synchronize` stayed false. Migrations applied to `vendure-bolesa-test` only: BolesaPhase1, Init, BolesaPhase1EnsureAfterInit, BolesaServiceSlug, BolesaVariantWeight, BolesaMerchantSettings.

Local Partner identity is not official Sandbox. `GET /me` on `127.0.0.1:8000` returned HTTP 200 and `test_mode=false`. The local database named by `bolesa-egy/.env` is `bs_egypt`. AWBs created by this run are on account `6`.

### Results

| Suite | Result | Command | Database / endpoint | Counts |
| --- | --- | --- | --- | --- |
| Unit | **PASS** | `npm run test:bolesa` | no database | 122 pass, 0 fail |
| Typecheck | **PASS** | `npm run typecheck` | none | exit 0 |
| Build | **PASS** | `npm run build` | none | dashboard 28.2s, server/worker 3.2s, exit 0 |
| Integration | **PASS** | `npm run test:bolesa:integration` | `vendure-bolesa-test` @ `127.0.0.1:5432`. Partner fetch banned. | 29 pass, 0 fail. Full-flow and local plugin E2E skipped because `BOLESA_SANDBOX_E2E` was unset. Remote suite recorded the missing `.env.remote-sandbox` blocker. |
| Local Partner E2E | **PASS** | `npm run test:bolesa:sandbox-e2e`, then the full-flow file again after the harness fix | `vendure-bolesa-test`. Partner `http://127.0.0.1:8000/api/pcl/v1` | Plugin file 5 pass (connection, cities, 5 priced services, create/idempotent replay/cancel, channel leak 0). Full flow 3 pass. |
| Official remote Sandbox | **BLOCKED** | not run | `.env.remote-sandbox` missing | No remote AWB create or cancel. |
| Production | **NOT APPROVED** | — | — | Local pass does not approve production. |

### COD evidence from the full-flow Payment rows

- Prepaid method `dummy-prepaid-e2e` (dummy handler, automatic settle) produced one Worker AWB and one cancel. Tracking `292284550` ended `CANCELED`. One shipment row for that fulfillment.
- COD method `bolesa-cod-e2e` (handler `bolesa-cod`) was `Authorized` for the order total (`11140`) before fulfillment. The AWB `cod_amount` was `111.4`. The payment was not settled by authorization.
- After the local AWB was marked `DELIVERED` and `bolesa-reconcile-shipments` ran, that payment became `Settled` once and `codCollectionStatus` became `collected`. A second reconcile left the settled count at 1.
- Fulfillment in this harness is manual `OrderService.createFulfillment`. The connection leaves `autoCreateAwb` at its default `false`. `maybeAutoFulfill` returns unless that flag is true. Forged client metadata is rejected by `payment-kind.spec.ts`, not by this database flow.
- Channel isolation: leaked shipment rows `0`.

### Defects fixed in this run

- `setLocalPartnerAwbStatus` no longer reads the missing `0-Project-Storage-Station` path, database `bolesa_eg`, or account `5`. It uses `BOLESA_LOCAL_PARTNER_ENV` or the sibling `bolesa-egy/.env`, and updates the single row for that tracking number. It refuses `vendure-dev` and `vendure-bolesa-test`.
- `POST /awbs` and cancel wait 60 seconds. Other Partner calls stay at 15 seconds. A 15-second abort had returned while the local Partner had already created the AWB.

### Cleanup outside the harness

While clearing local AWBs left `READY FOR SHIPMENT` by the first failed run, cancel was also sent for tracking `3835252745` (order number `7389KG9D28FLZ2WC`, created earlier the same day, account 6). That shipment was not created by this re-run. It is now `CANCELED` on the local Partner. Create it again from the dashboard if that order should still ship. Test AWBs from the passing run were cancelled by the harness.
