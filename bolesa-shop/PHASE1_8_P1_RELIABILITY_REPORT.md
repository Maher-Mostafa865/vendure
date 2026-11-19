# Phase 1.8 — P1 Outbox & Cancellation Reliability Report

**Date:** 2026-11-20  
**Database used:** `vendure-bolesa-test` only (host `127.0.0.1:6543`)  
**`vendure-dev`:** Untouched (shipment count `0`; migrations still Init + BolesaPhase1 only)  
**Safety:** No Partner API / AWB traffic; fetch banned in integration; stubs only.

### Verdict summary

| Gate | Result |
|------|--------|
| **P1 reliability** | **PASS** |
| **Sandbox E2E** | **NO-GO** (not executed; not claimed) |
| **Production** | **NO-GO** (ops/Sandbox/remaining Phase 1.6 items still open) |

---

## Findings implemented

### F-OQ-01 — Exhausted create job recovery

**Root cause:** After JobQueue create retries exhausted (`FAILED`, `attempts > retries`), outbox often stayed `requested`. Orphan recovery treated that as “missing job” and re-enqueued forever.

**Fix:**

- New sync status `retry_exhausted` (terminal for auto-recovery; not abandon).
- On last JobQueue attempt failure → `markCreateRetryExhausted`.
- Recovery: if `requested` + exhausted FAILED job for same fulfillment/channel/attempt → mark `retry_exhausted`, do **not** enqueue.
- Admin `retryShipment` restores `requested`, bumps `attempt` + `idempotencyKey`, enqueues new job.
- Dashboard Retry button includes `retry_exhausted`.

### F-OQ-04 — Cancel orphan recovery

**Root cause:** `cancel_requested` save + `cancelQueue.add` non-atomic; no active-job dedupe; reconcile did not re-enqueue cancel.

**Fix:**

- `ensureCancelAwbJobEnqueued` / `hasActiveCancelAwbJob` / `hasExhaustedCancelAwbJob`
- `recoverOrphanedCancelRequestedShipments` (only `cancel_requested` + trackingNumber)
- Explicit `requestCancel` / `onOrderCancelled` use ignoreGrace + ignoreExhausted
- Recovery skips exhausted FAILED cancel jobs (no unbounded re-enqueue)
- Concurrent recoveries serialized with FOR UPDATE on shipment row before enqueue

### F-TX-03 — Cancel processor locking

**Fix:** Two-phase cancel matching create:

1. Gate txn + `pessimistic_write`
2. Partner `cancelAwb` **outside** txn (proven: `txnDepth === 0` during HTTP)
3. Commit txn: re-lock, re-check `cancel_requested` / already `canceled`, then apply

### F-OQ-02 — Precise active create job query

**Root cause:** Global `LIMIT 500` scan could miss the matching active job.

**Fix:** Filter at DB using real `job_record` schema (`data` is JSON **text**):

```sql
WHERE "queueName" = $1
  AND state = ANY($2::text[])
  AND "isSettled" = false
  AND (data::json->>'fulfillmentId') = $3
  AND (data::json->>'channelId') = $4
  AND (data::json->>'attempt') = $5
LIMIT 1
```

Same pattern for cancel (`trackingNumber` instead of `attempt`).  
No new index in this phase (precise `LIMIT 1` is sufficient for current scale; optional expression index left as remaining risk).

---

## Files changed

| File | Change |
|------|--------|
| `apps/server/src/plugins/bolesa/types.ts` | `retry_exhausted`; cancel job `attempt` |
| `apps/server/src/plugins/bolesa/util/outbox-recovery.ts` | Exhaustion helpers; cancel enqueue decisions |
| `apps/server/src/plugins/bolesa/util/create-awb-gate.ts` | Gate `retry_exhausted` as terminal |
| `apps/server/src/plugins/bolesa/services/bolesa-shipment.service.ts` | Exhaustion, cancel recovery/dedupe, cancel locking, precise SQL, enqueue row-lock |
| `apps/server/src/plugins/bolesa/services/bolesa-reconcile.task.ts` | Logs cancel recovery + exhausted counts |
| `apps/server/src/plugins/bolesa/dashboard/index.tsx` | Retry UI for `retry_exhausted` |
| `apps/server/src/plugins/bolesa/tests/outbox-recovery.spec.ts` | Unit coverage |
| `apps/server/src/plugins/bolesa/tests/create-awb-gate.spec.ts` | `retry_exhausted` gate |
| `apps/server/src/plugins/bolesa/tests/integration/p1-reliability.integration.spec.ts` | **New** Phase 1.8 suite |
| `apps/server/package.json` | Integration `--test-concurrency=1` (suites share DB) |

### Migration impact

**None.** `retry_exhausted` is a new varchar status value; no DDL. No `synchronize:true`. No changes to `vendure-dev`.

---

## Test evidence

### Commands

| Command | Result |
|---------|--------|
| `npm run test:bolesa` | **59 pass** / 0 fail |
| `npm run test:bolesa:integration` | **21 pass** / 0 fail (Phase 1.5: 10 + Phase 1.8: 11) |
| `npm run typecheck` | exit 0 |
| `npm run build:server` | Built successfully (~1.7s) |

### Phase 1.8 integration cases (`vendure-bolesa-test`)

| # | Case | Result |
|---|------|--------|
| 1 | Exhausted create retries → `retry_exhausted`; second recovery does not re-enqueue | **PASS** (`status1/2=retry_exhausted`, `active=0`) |
| 2 | Admin retry → `requested`, attempt 2, new idempotency key | **PASS** |
| 3 | Missing cancel job recovered | **PASS** (`enqueued=1`) |
| 4 | Existing active cancel job not duplicated | **PASS** (`skippedActive=1`) |
| 5 | Concurrent cancel recoveries → exactly 1 active job | **PASS** |
| 6 | Channel isolation for cancel matching | **PASS** |
| 7 | Independent PG sessions blocked by `FOR UPDATE` | **PASS** |
| 8 | Partner cancel HTTP outside DB txn (`inDbTxnDuringPartnerHttp=false`) | **PASS** |
| 9 | Late create cannot overwrite `cancel_requested` | **PASS** |
| 10 | No real Partner API (`fetchCallCount=0`) | **PASS** |
| 11 | F-OQ-02: 520 unrelated jobs + match beyond old LIMIT 500 | **PASS** (`detected=true`, `skip_active_job`) |

---

## Remaining risks

- **F-TX-04 residual:** Enqueue still cannot be one atomic DB txn with `job_record` insert (Vendure JobQueue API). Mitigated by FOR UPDATE around check+add; extreme multi-process races still theoretically possible if JobQueue write is delayed past commit.
- **Cancel exhaustion:** Recovery skips exhausted cancel jobs; Admin must call `requestCancel` again (`ignoreExhausted`) — no dedicated `cancel_retry_exhausted` status.
- **No expression index** on `job_record` JSON fields yet; OK at current volume.
- **Schema name drift** (Phase 1.7) between TypeORM entity hashes and SQL constraint names remains.
- **Sandbox E2E / production ops** (monitoring, runbooks, F-OPS-*) not done.
- **F-OQ-05** Admin retry still bypasses `ensureCreateAwbJobEnqueued` (P2).

---

## Final verdict

| | |
|--|--|
| **P1 reliability** | **PASS** |
| **Sandbox E2E** | **NO-GO** |
| **Production** | **NO-GO** |
