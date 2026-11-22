# Phase 1.5 — Bolesa Outbox Reliability Report

**Date:** 2026-11-20  
**Project:** `bolesa-shop`  
**Scope:** Orphaned `requested` recovery, create-job dedupe, transactional pessimistic locks  
**Not claimed:** Production readiness, Sandbox Partner verification, live AWB create/cancel

---

## Root cause

`onFulfillmentCreated` (post-commit `FulfillmentEvent`) performed two non-atomic steps:

1. `INSERT`/`save` `BolesaShipment` with `syncStatus=requested`
2. `JobQueue.add('bolesa-create-awb', …)` → separate `job_record` write

A crash between (1) and (2) left an outbox row with **no** create job. Reconciliation only scanned `created | awaiting_bolesa | cancel_requested`, so orphans stayed stuck forever.

Separately, `createAwbForFulfillment` used TypeORM `setLock('pessimistic_write')` **outside** a transaction. `FOR UPDATE` requires an active transaction; concurrent workers were not reliably serialized.

Duplicate `FulfillmentEvent` handling always re-`add`ed a create job even when the shipment was already past `requested` (e.g. `failed` / `created`).

---

## Design chosen and why

**At-least-once enqueue + idempotent consume**, not a single distributed transaction across outbox and JobQueue (Vendure does not provide that atomically).

| Piece | Choice | Why |
|-------|--------|-----|
| Recovery | Scheduled reconcile first calls `recoverOrphanedRequestedShipments()` | Reuses existing Worker schedule; no new queue; no Partner API for recovery |
| Eligibility | Only `syncStatus === 'requested'` | Never auto-retries permanent `failed` (4xx) |
| Dedupe | Inspect `job_record` via `InspectableJobQueueStrategy.findMany` for PENDING/RUNNING/RETRYING matching fulfillment+channel+**attempt** | Avoids unnecessary duplicate jobs; attempt match preserves admin-retry semantics |
| Grace | 60s before orphan recovery enqueues | Avoids racing the happy-path `add` right after save |
| Event path | `ensureCreateAwbJobEnqueued(..., { ignoreGracePeriod: true })` | Immediate enqueue on create; duplicate events skip if active job exists or status ≠ `requested` |
| Concurrency | Two-phase `withTransaction` + `pessimistic_write` around read/write; Partner HTTP **outside** the lock | Real `FOR UPDATE`; short lock hold time; Partner idempotency key + pre-check absorb dual in-flight creates |
| Idempotency | Unchanged attempt-scoped keys; recovery does **not** bump `attempt` | Same key as original orphaned intent |

---

## Changed files

| File | Change |
|------|--------|
| `apps/server/src/plugins/bolesa/util/outbox-recovery.ts` | **New** — pure decision/matching helpers |
| `apps/server/src/plugins/bolesa/services/bolesa-shipment.service.ts` | Recovery + enqueue guard; transactional create/status locks; safer duplicate-event handling |
| `apps/server/src/plugins/bolesa/services/bolesa-reconcile.task.ts` | Logs recovery stats; description updated |
| `apps/server/src/plugins/bolesa/tests/outbox-recovery.spec.ts` | **New** — focused unit tests |
| `PHASE1_OUTBOX_RELIABILITY_REPORT.md` | This report |

No migrations, package scripts, COD, or Phase 2 webhook work.

---

## Transaction and locking guarantees

### Create AWB processor

1. **Gate txn:** `withTransaction` → `lockShipmentForFulfillment` (`pessimistic_write`) → early exit for missing / created / abandoned / canceled / **failed**.
2. **HTTP outside txn:** `findAwbsByMeta` / `createAwb` (same attempt-scoped Idempotency-Key).
3. **Commit txn:** re-lock → re-check terminal/created → apply adopt / `awaiting_bolesa` / failure fields.

Guarantees:

- `FOR UPDATE` runs only inside `TransactionalConnection.withTransaction`.
- Two workers cannot both commit conflicting outbox updates for the same fulfillment/channel row without serialization.
- Permanent 4xx still sets `failed` under lock and returns without throw (JobQueue does not retry).
- Transient 409/5xx records `lastError` under lock and **rethrows** (JobQueue retries; recovery does not bump attempt).

### Apply status

Partner `getAwb` runs outside the lock; status apply + fulfillment transitions run inside `withTransaction` + `pessimistic_write` on trackingNumber+channelId.

### Not guaranteed

- Outbox row insert and `job_record` insert are still **not** one atomic DB transaction.
- Inspectable job query is best-effort (take 200 active create jobs); extreme backlog could miss a match and enqueue a duplicate (processor + Partner idempotency still safe).
- Non-inspectable JobQueue strategies: `hasActiveCreateAwbJob` returns `false` → may enqueue duplicates (safe via processor).

---

## Recovery behavior

```
reconcileOpenShipments()
  ├─ recoverOrphanedRequestedShipments()   // no Partner API
  │    for each channel, syncStatus=requested (≤100, oldest first)
  │      ensureCreateAwbJobEnqueued(shipment)
  │        decide: skip_status | skip_active_job | skip_grace | enqueue
  │        enqueue uses existing attempt + retries:5
  └─ existing open-status reconcile (Partner API; unchanged COD)
```

**Duplicate FulfillmentEvent:** if outbox exists and `requested` → ensure enqueue (ignore grace); otherwise no-op.

**Worker restart:** PENDING/RETRYING jobs remain in `job_record`; recovery sees them as active and does not duplicate. Missing jobs for aged `requested` rows are re-added.

---

## Test cases and results

Command: `npm run test:bolesa` (workspace `server`)

```
# tests 38
# pass 38
# fail 0
```

Also: `npm run typecheck` — pass; `npm run build:server` — pass (~1.7s).

New coverage in `outbox-recovery.spec.ts`:

| Case | Result |
|------|--------|
| Orphaned `requested` past grace → enqueue | Pass |
| Active equivalent job → skip | Pass |
| Repeated recovery idempotent | Pass |
| Concurrent recovery simulation (first enqueue, second skip) | Pass |
| `failed` / non-requested statuses → skip (no auto 4xx retry) | Pass |
| Grace window vs event `ignoreGracePeriod` | Pass |
| Channel isolation + attempt matching | Pass |
| 409/5xx retry vs 4xx permanent (`BolesaApiError` + classifier) | Pass |
| Duplicate event policy (only `requested`) | Pass |
| Lock inside `withTransaction` call-order contract | Pass |

Tests use mocked / pure helpers — **no** live Partner API and **no** DB JobQueue integration harness.

---

## Remaining risks

1. **Race within 60s grace** after save+crash before `add`: orphan waits until next reconcile after grace (≤ ~15 min + grace).
2. **Exhausted JobQueue retries** while status still `requested` (transient failures): recovery may re-enqueue every reconcile after grace — intentional self-heal; monitor for hot loops.
3. **Active-job scan cap (200)** may miss matches under huge PENDING backlog → rare duplicate jobs.
4. **HTTP outside lock** allows two creates with the same idempotency key; correctness depends on Partner idempotency + meta pre-check.
5. **`cancel_requested` without cancel job** is not recovered in this change (out of scope).
6. No Sandbox e2e proof of recovery against real `job_record` / Worker.

---

*End of Phase 1.5 outbox reliability report.*
