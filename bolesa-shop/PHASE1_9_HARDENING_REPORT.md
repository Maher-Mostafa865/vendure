# Phase 1.9 — Final Hardening & Operational Readiness Report

**Date:** 2026-11-20  
**Database:** `vendure-bolesa-test` only for integration writes  
**`vendure-dev`:** Untouched (shipment count `0`)  
**Safety:** No real Partner API / AWB traffic

### Verdict summary

| Gate | Result |
|------|--------|
| **Reliability hardening** | **PASS** |
| **Operational readiness** | **PARTIAL** (monitoring + runbook shipped; alerting wiring / Sandbox E2E still open) |
| **Sandbox E2E** | **NO-GO** |
| **Production** | **NO-GO** |

---

## Scope A — Reliability

### 1. F-OQ-05 — Admin retry deduplication

**Before:** `retryShipment` bumped attempt and called `createQueue.add` directly → double-click could stack jobs.

**After:**

- Partner meta pre-check outside lock.
- `FOR UPDATE` bump of `attempt` / `idempotencyKey` at most once.
- Enqueue via `ensureCreateAwbJobEnqueued` (active-job dedupe).
- Concurrent Admin retries → single attempt bump + single active job (integration test 1).
- Already-`requested` + active job → idempotent no-op (test 2).

**Files:** `bolesa-shipment.service.ts`, `p1-hardening.integration.spec.ts`

### 2. Cancel retry exhaustion

**New status:** `cancel_retry_exhausted`

- Last cancel JobQueue attempt → `markCancelRetryExhausted`.
- Recovery marks exhausted instead of infinite re-enqueue.
- Admin `retryCancelShipment` / GraphQL `bolesaRetryCancelShipment` restores `cancel_requested` and enqueues with dedupe (`ignoreExhausted`).
- Partner cancel key unchanged (idempotent).

**Tests:** hardening suite tests 3–4.

### 3. Created without tracking number

**Decision (documented):** `created` + no TN → gate `awaiting_lookup` only.

- Never blind `POST /awbs`.
- Empty `findAwbsByMeta` → `{ ok: true }` without create.
- Another create requires Admin retry → `requested` + new attempt.

**Tests:** unit gate + hardening test 5 (`createAwbCalls=0`, meta lookup > 0).

---

## Scope B — Operational readiness

### 4. Monitoring (implemented)

| Signal | Implementation |
|--------|----------------|
| Failed / retry_exhausted / cancel_retry_exhausted | `bolesaOpsHealth` channel counts |
| Stuck requested / cancel_requested | Counts with configurable `stuckShipmentThresholdMs` (default 30m) |
| Queue depth / failed jobs | `job_record` aggregates per create/cancel queue |
| Reconcile duration / outcomes | `BolesaMetric reconcile …` structured log |
| Last Partner verify | `lastPartnerVerifiedAt` from connection (`testBolesaConnection`) |
| Channel health | Per-channel snapshot in `bolesaOpsHealth` |

**API:** Admin query `bolesaOpsHealth` (no tokens / addresses / customer PII).

**Alerting gap (documented):** No Prometheus/PagerDuty exporter in-repo. Operators should scrape/log-ship `BolesaMetric` lines and/or poll `bolesaOpsHealth` until an external alert rule is wired.

### 5. Runbook

Deliverable: [`BOLESA_OPERATIONS_RUNBOOK.md`](./BOLESA_OPERATIONS_RUNBOOK.md)

### 6. Rate limiting (Shop city search)

- Abuse risk: unauthenticated Shop query decrypts Partner token server-side → Partner hammering.
- `FixedWindowRateLimiter` (default **30 / 60s** per channel+session/IP).
- Configurable via `BolesaPluginOptions.citySearchRateLimit`.
- Over-limit returns `[]` + warn log (no sensitive payload).
- Unit tests in `rate-limit.spec.ts`.

### 7. Scripts (F-OPS-01)

Root `package.json`:

| Script | Target |
|--------|--------|
| `start:server` | `npm run start:server -w server` → `node ./dist/index.js` |
| `start:worker` | `npm run start:worker -w server` → `node ./dist/index-worker.js` |
| `start` | storefront + **server-only** (not `vendure start all`) |

No accidental Server+Worker double-start from `start:server`.

---

## Scope C — Capacity & database

### Reconcile `take:100`

- Configurable `reconcileBatchSize` (default 100) × `reconcileMaxBatches` (default 10) with `skip` pagination per channel.
- Caps work at ≤1000 open rows/channel/run; backlog beyond that waits for next schedule (documented remaining risk).

### `job_record` JSON expression indexes

EXPLAIN on `vendure-bolesa-test` (empty/light table):

```
Limit → Seq Scan on job_record
Filter: queueName + state ANY + isSettled + data::json->>'…'
cost ≈ 0.00
```

**Decision:** **No index added.** Seq scan is acceptable at current volume; revisit when EXPLAIN shows material cost under production-like `job_record` size.

### Schema

- No `synchronize:true`.
- No constraint-name cleanup migration (still planned separately as F-MIG-02).
- No `vendure-dev` changes. Status values are varchar — no DDL for `cancel_retry_exhausted`.

---

## Tests executed

| Command | Result |
|---------|--------|
| `npm run test:bolesa` | **63 pass** |
| `npm run test:bolesa:integration` | **28 pass** (1.5 + 1.8 + 1.9) |
| `npm run typecheck` | exit 0 |
| `npm run build:server` | success |

---

## Files changed (summary)

- `bolesa-shipment.service.ts` — retry guards, cancel exhaustion, ops health, reconcile paging
- `create-awb-gate.ts` — created-without-TN → lookup only
- `types.ts` / plugin options — rate limit, reconcile batch, stuck threshold, `cancel_retry_exhausted`
- `bolesa-admin.resolver.ts` / `api-extensions.ts` — ops health + cancel retry mutation
- `bolesa-shop.resolver.ts` / `util/rate-limit.ts` — city search rate limit
- `dashboard/index.tsx` — cancel retry UI affordance
- Root `package.json` — start:server / start:worker
- Tests + `BOLESA_OPERATIONS_RUNBOOK.md` + this report

---

## Remaining risks / gaps

1. External alerting not wired (PARTIAL ops).
2. Sandbox Partner E2E still absent → Sandbox/Production **NO-GO**.
3. In-process city rate limit is per-process (multi-instance needs Redis/shared store).
4. Reconcile maxBatches may lag large backlogs until next cron.
5. F-TX-02 status-apply lock scope still Medium (out of this slice).
6. Schema name drift (F-MIG-02) unresolved by design.

---

## Final verdict

| | |
|--|--|
| **Reliability hardening** | **PASS** |
| **Operational readiness** | **PARTIAL** |
| **Sandbox E2E** | **NO-GO** |
| **Production** | **NO-GO** |
