# Phase 0 Verification Report — Vendure + Bolesa Integration

**Date:** 2026-11-19  
**Plan:** `/home/maher/.cursor/plans/vendure_bolesa_integration_d2695136.plan.md` (Revision 2)  
**Scope:** Verification and isolated spikes only. No production behavior changed. No repository move.

---

## 1. Git inspection (before work)

| Repo | Branch | Tracking | Dirty? |
|------|--------|----------|--------|
| `vendure` | `master` @ `74cfe1835` | `origin/master` | Clean before Phase 0; Phase 0 added untracked `bolesa-shop/phase0/` |
| `bolesa-egy` | `dev` @ `948d9a25` | `origin/dev` | Clean |

**Repository move:** Plan Phase 0 includes “move bolesa-shop to its own repo”. **Not done** — user forbade moving/deleting repositories without approval. Remains a **blocker for packaging**, not for Phase 1 plugin coding inside `bolesa-shop`.

---

## 2. Six Phase 0 questions

### Q1 — Is `label_url` externally accessible?

| Status | **Mostly verified: NO for anonymous access** |
|--------|-----------------------------------------------|

**Source**

- `label_url` ← `ShippingAwb::label_link` ← `Storage::disk('shipping_labels_s3')->url($label)`  
  (`bolesa-egy/app/Models/ShippingAwb.php` 411–427)
- Disk `shipping_labels_s3`: root `{prefix}/app/public/labels`, **`visibility => public` commented out**  
  (`bolesa-egy/config/filesystems.php` 90–101)
- Local `.env` (non-secret): `AWS_URL=https://bolesa-cdn.s3.ap-south-1.amazonaws.com/`, bucket `bolesa-cdn`

**Live probe (no customer objects)**

| URL | HTTP |
|-----|------|
| bucket root | **403** |
| `.../app/public/labels/` | **403** |
| `.../app/public/labels/phase0-probe-nonexistent.pdf` | **403** |

Evidence: `phase0/evidence/label-url-s3-probe.result.json`

**Interpretation:** Anonymous S3 access is denied. Unsigned `Storage::url()` links are **not** reliably usable by browsers or Vendure Admin without credentials.  
**Caveat:** A real object key was not probed (no sandbox token / no real label). Prefix-level public policy remains **unverified**.

**Implication for Phase 1:** Serve labels only via a permission-checked Vendure Admin proxy that fetches with server credentials, **or** require Bolesa label endpoint / signed URLs before production.

---

### Q2 — Runtime raw-body webhook signature verification?

| Status | **Verified with caveat** |
|--------|---------------------------|

**Spikes**

1. `raw-body-middleware.spike.mjs` — global `express.json()` **before** route `express.raw`  
   → `req.body` is a **parsed object**, not a Buffer.  
   Evidence: `phase0/evidence/raw-body-after-json.result.json`  
   **FAIL** for safe HMAC (must hash exact bytes).

2. `raw-body-beforelisten.spike.mjs` — route `express.raw` **before** global `express.json()`  
   → `req.body` is a **Buffer**, HMAC OK.  
   Evidence: `phase0/evidence/raw-body-beforelisten.result.json`  
   **PASS**

**Vendure wiring**

- `beforeListen` middleware mounts via `app.use(route, handler)` after `NestFactory.create` (`packages/core/src/bootstrap.ts` 240–252).
- Nest may still register a global JSON parser. Exact Nest 3.8.2 adapter order vs Express spike is **not end-to-end tested** against a full Vendure bootstrap (server was down).

**Recommendation for Phase 1**

1. Prefer `bootstrap(config, { nestApplicationOptions: { rawBody: true } })` (`bootstrap.ts` 232), **or**
2. Mount webhook `express.raw` as a **beforeListen** middleware that wins on `/bolesa/webhooks`, then add an e2e test that posts a signed body and asserts HMAC over `req.rawBody` / Buffer.
3. Do **not** rely on `JSON.stringify(parsedBody)` for HMAC.

---

### Q3 — Can custom code use `EncryptionStrategy`?

| Status | **YES — verified** |
|--------|---------------------|

- Interface: `packages/core/src/config/system/encryption-strategy.ts` — synchronous `encrypt` / `decrypt` / `isEncrypted` / `isConfigured`.
- Default: AES-256-GCM + scrypt (`default-encryption-strategy.ts`).
- Spike: `phase0/spikes/encryption-strategy.spike.mjs` round-trips a fake token; wrong key throws.  
  Evidence: `phase0/evidence/encryption-strategy.result.json`

**Implication:** Phase 1 can inject `ConfigService.systemOptions.encryptionStrategy` (or construct `DefaultEncryptionStrategy` with `VENDURE_ENCRYPTION_KEY`) and store `BolesaConnection.tokenEncrypted` without needing TypeORM `secret` custom fields. Still configure `systemOptions.encryptionStrategy` in `vendure-config.ts`.

---

### Q4 — Do COD payout statements include `awb_no`?

| Status | **YES for AWB-linked settlements; NO for generic account credits** |
|--------|-------------------------------------------------------------------|

**Verified paths that set `awb_no`**

| Path | Evidence |
|------|----------|
| AWB settlement transaction | `AwbSettlementService.php` 184–192 — always sends `awb_no` + `meta.awb_no` from tracking number |
| Financial settlements bulk billing | `FinancialSettlementsBillingService.php` 114–140 |
| Pending wallet release debit | `ReleaseCustomerBillsService.php` 276–294 (null if tracking empty) |
| Partner webhook envelope | `PartnerWebhookPayloadFactory.php` 150–184 — includes `awb_no` when present in context |
| Partner `GET /statements` | `PartnerAwbTransactionResource.php` 25–44 — exposes nullable `awb_no` |
| Sample webhook | `PartnerWebhookSamples.php` 47–50 |

**Path that may omit `awb_no`**

- Manual account settlement form defaults `awb_no => null` (`AccountsTable.php` 1079). Batch merchant remittances that are not AWB-tagged will not map 1:1 to a Vendure order.

**Implication:** Phase 1 remittance tracking should:

1. Prefer `account_statement.*` / `GET /statements?awb_no={tracking}` when `awb_no` is present.
2. Fall back to statement-level display when `awb_no` is null.
3. Still request Bolesa fields `cod_collected_at` / `cod_settled_at` for production clarity.

**Not verified:** live sandbox webhook payload for `account-settlement-credit` (no sandbox token, DB down).

---

### Q5 — ApiKey behavior after creating a new Channel?

| Status | **Source-verified; runtime smoke not run** |
|--------|---------------------------------------------|

- `ApiKeyService.create` → `assignToCurrentChannel` only (`api-key.service.ts` ~210).
- Lookup requires `channels: { id: ctx.channelId }` (`api-key.service.ts` 451–457).
- Channel comes from `vendure-token` header.

**Conclusion:** An ApiKey created on the default channel **cannot** authorize Admin calls that send a newly provisioned channel’s token. Revision 2’s `provisionBolesaStore` single mutation on the default channel remains correct.

**Runtime:** bolesa-shop API not listening (ports 3000/3001 closed). Notes: `phase0/spikes/apikey-channel.spike.md`.

---

### Q6 — Real-world frequency of backward shipment statuses?

| Status | **Source-verified: possible; frequency UNKNOWN** |
|--------|--------------------------------------------------|

- `AwbTrackingService` overwrites `status_code` with no terminal / monotonic guard (`markAwbStatusOnly` / `markAwbDelivered`, lines 152–268).
- Empty/`NO STATUS` does not overwrite (`hasUsableCarrierStatus`, 185–191).
- No production telemetry or sandbox dataset was available this session.

**Implication:** Keep Revision 2 forward-only Vendure mapping + ignore stale events by `lastStatusAt`. Do not assume carriers never reverse.

---

## 3. Idempotency (409 / 422 / 5xx / duplicates)

**Source:** `PartnerIdempotency.php`

| Behavior | Result |
|----------|--------|
| No header | Pass-through |
| Invalid key format | `422 invalid_idempotency_key` |
| Same key + same body | Replay + `Idempotent-Replayed: true` |
| Same key + different body | `422 idempotency_key_reused` |
| Lock held (concurrent) | `409 idempotency_in_progress` |
| Response status **&lt; 500** | Cached 24h (includes **422**) |
| Response status **≥ 500** | **Not** cached — retry same key |
| Storage | Cache (not DB) |

**Spike:** `idempotency-semantics.spike.mjs` — all six cases **PASS**.  
Evidence: `phase0/evidence/idempotency-semantics.result.json`

**Existing Pest:** `PartnerWriteEndpointsTest.php` covers replay + `idempotency_key_reused`.  
**Pest runtime this session:** **NOT RUN** — Postgres `127.0.0.1:5432` down; Docker not installed.

**Duplicate AWB prevention:** `order_number` is **not** unique per Partner account. Rely on `Idempotency-Key` + Phase 1 `meta.vendure_shipment_key` pre-check (`GET /awbs?meta[...]`). Bolesa unique constraint on meta key remains a recommended API change.

---

## 4. OpenAPI / types

| Item | Status |
|------|--------|
| Live `GET /api/pcl/openapi.json` | **Not fetched** — local APP_URL offline |
| Generated TS client | **Deferred** |
| Placeholder inventory | `phase0/generated/partner-api-endpoint-inventory.json` |

---

## 5. Tests passed / failed / skipped

| Test / spike | Result |
|--------------|--------|
| EncryptionStrategy round-trip | **PASS** |
| Raw body after global JSON | **FAIL** (expected — documents wrong pattern) |
| Raw body before global JSON | **PASS** |
| Idempotency semantics (isolated) | **PASS** (6/6) |
| S3 anonymous label probe | **PASS as evidence** (403) |
| Pest `PartnerWriteEndpointsTest` idempotency | **SKIPPED** (no DB/Docker) |
| Full Vendure bootstrap webhook e2e | **SKIPPED** (server down) |
| Live ApiKey + createChannel GraphQL | **SKIPPED** (server down) |
| Live Partner API with sandbox token | **SKIPPED** (no `BOLESA_PARTNER_TOKEN`) |
| Live OpenAPI download | **SKIPPED** |
| Production backward-status frequency | **SKIPPED** (no data) |

---

## 6. Remaining blockers

1. **No Bolesa sandbox Partner token** in environment — cannot exercise live create/cancel/webhook/label object.
2. **Postgres + Docker unavailable** — cannot run Pest PartnerApi suite locally.
3. **bolesa-shop server not running** — cannot run ApiKey/createChannel or Nest rawBody e2e.
4. **bolesa-shop not moved to own repo** — awaiting explicit approval.
5. **Full OpenAPI JSON** not captured — regenerate when Partner docs host is up.
6. **Real label object accessibility** still a small residual unknown without a sandbox AWB.

---

## 7. Required Bolesa API changes (priority for Phase 1+)

Confirmed still needed (aligned with plan §9):

1. **Label download endpoint** (+ signed/temporary URLs) — critical; unsigned public URLs fail anonymous access.
2. **Webhook auto-approve** for Bolesa Shops allowlist — otherwise polling-only MVP.
3. **COD visibility fields / `awb.cod_settled`** — remittance mapping is incomplete without them; `awb_no` helps but is nullable on some statement types.
4. **Webhook `status_changed_at` / sequence + replay API** — suspended subscriptions drop events.
5. **Named tokens / provisioning service** — needed before SaaS Phase 4.
6. **`insufficient_balance` stable error code** — today often generic `request_failed`.
7. **Optional:** unique `meta.vendure_shipment_key` per account.

No changes to core pricing/CreateAwb required for Phase 1 MVP plugin coding.

---

## 8. Go / No-Go for Phase 1

### **GO — with conditions**

Phase 1 (single-channel MVP plugin: client, connection encryption, rates, COD authorize/settle-on-DELIVERED, async AWB job, poll reconciliation, Admin label proxy) may start **inside** `bolesa-shop` because:

- Architecture risks from Revision 2 are confirmed by source + spikes.
- EncryptionStrategy is usable.
- Idempotency semantics match the async-job design (new key after 4xx; same key after 5xx; meta pre-check required).
- Label strategy must assume **private** storage and use server-side fetch / future Bolesa label API.
- Webhook raw body must use **beforeListen-first** or Nest `rawBody: true`, with an e2e test in Phase 1.

### Conditions / do-not-block-but-schedule

| Condition | When |
|-----------|------|
| Obtain sandbox `XP-Api-Token` and re-run live create/idempotency/cancel | ASAP, parallel to Phase 1 |
| Bring up test Postgres (or Docker) and run Partner Pest suite | Before calling Partner API “production-ready” |
| Vendure Nest rawBody e2e once server is up | Before enabling webhooks (Phase 2) |
| Approval to extract `bolesa-shop` to its own repo | Before npm publish / SaaS deploy |
| Fetch and commit `openapi.json` snapshot for CI contract tests | Early Phase 1 |

### **NO-GO** for Phase 2+ (webhooks/SaaS) until

- Webhook HMAC verified against a real Vendure bootstrap.
- Webhook auto-approve or reliable polling SLA accepted.
- Sandbox end-to-end AWB + statement + label exercised once.

---

## 9. Artifacts

```
bolesa-shop/phase0/
  README.md
  PHASE0_VERIFICATION_REPORT.md
  spikes/
    encryption-strategy.spike.mjs
    raw-body-middleware.spike.mjs
    raw-body-beforelisten.spike.mjs
    idempotency-semantics.spike.mjs
    apikey-channel.spike.md
  evidence/
    encryption-strategy.result.json
    raw-body-after-json.result.json
    raw-body-beforelisten.result.json
    idempotency-semantics.result.json
    label-url-s3-probe.result.json
  generated/
    partner-api-endpoint-inventory.json
```

No secrets committed. No production code paths modified in `bolesa-egy` or Vendure core.
