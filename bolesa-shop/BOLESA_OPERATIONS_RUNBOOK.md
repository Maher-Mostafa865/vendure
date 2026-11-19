# Bolesa Phase 1 — Operations Runbook

**Audience:** On-call / Admin operators  
**Scope:** Vendure Bolesa plugin (create/cancel AWB outbox + JobQueue)  
**Safety:** Never paste Partner tokens, full addresses, or customer PII into tickets/logs.

---

## 1. Quick health check

Admin GraphQL (requires `ReadBolesaShipment`):

```graphql
query {
  bolesaOpsHealth {
    generatedAt
    stuckThresholdMs
    lastPartnerVerifiedAt
    channels {
      channelId
      bySyncStatus
      stuckRequested
      stuckCancelRequested
      failed
      retryExhausted
      cancelRetryExhausted
    }
    queues {
      queueName
      active
      failedUnsettledLike
    }
    notes
  }
}
```

Also scan Worker logs for lines starting with `BolesaMetric reconcile` / `BolesaMetric ops_health`.

| Signal | Action |
|--------|--------|
| `stuckRequested` rising | §2 Diagnosing stuck create |
| `stuckCancelRequested` / `cancelRetryExhausted` | §3 Cancel path |
| `retryExhausted` / `failed` | Admin retry create (§4) |
| Queue `active` huge | Worker down or Partner slow (§7) |
| `lastPartnerVerifiedAt` stale | Run `testBolesaConnection`; check outage (§6) |

---

## 2. Diagnosing stuck shipments

### Sync status meanings (create)

| Status | Meaning | Auto recovery? |
|--------|---------|----------------|
| `requested` | Waiting for create job | Yes (orphan enqueue after 60s grace) |
| `awaiting_bolesa` | Partner accepted async (202) | Lookup/reconcile only — **no** new POST |
| `created` + TN | Done | — |
| `created` without TN | Anomalous | **Lookup only**; Admin retry → new create |
| `failed` | Permanent 4xx | Admin retry only |
| `retry_exhausted` | JobQueue create retries spent | Admin retry only |
| `cancel_requested` | Cancel in flight | Cancel orphan recovery |
| `cancel_retry_exhausted` | Cancel JobQueue spent | Admin cancel retry |
| `canceled` / `abandoned` | Terminal | — |

### SQL (ops DB — prefer `vendure-bolesa-test` / staging first)

```sql
-- Counts by status (channel-scoped)
SELECT "syncStatus", count(*) FROM bolesa_shipment
WHERE "channelId" = :channelId GROUP BY 1;

-- Stuck requested > 30m without active job
SELECT s."fulfillmentId", s.attempt, s."updatedAt", s."lastError"
FROM bolesa_shipment s
WHERE s."syncStatus" = 'requested'
  AND s."updatedAt" < now() - interval '30 minutes';
```

Do **not** log `orderId` lists with customer joins in public channels.

---

## 3. Retrying create safely

Admin UI: **Retry AWB** on `failed` / `retry_exhausted` / `requested`.  
GraphQL: `bolesaRetryShipment(fulfillmentId)`.

Behavior:

1. Partner meta pre-check (adopt if AWB already exists).
2. Under row lock: bump `attempt` + `idempotencyKey` **once** (from failed/retry_exhausted/awaiting/created-without-TN).
3. Enqueue via shared guard (no duplicate active jobs; double-click safe).

If status is `cancel_requested` / `canceled` / `abandoned` / `cancel_retry_exhausted` → create retry is rejected.

---

## 4. Retrying cancel safely

Admin UI: **Retry cancel** on `cancel_retry_exhausted` (or stuck `cancel_requested`).  
GraphQL: `bolesaRetryCancelShipment(fulfillmentId)`.

- Restores `cancel_requested` and enqueues cancel job (deduped).
- Partner cancel key remains `cancel-{shipmentKey}-a{attempt}` (idempotent).
- Does **not** invent a second cancel while an active cancel job exists.

Initial cancel: `bolesaCancelShipment` (requires tracking number).

---

## 5. Abandoning shipments

`bolesaAbandonShipment` — only when there is **no** live Partner AWB (or status already terminal).  
If a tracking number exists and status is non-terminal, cancel first.

---

## 6. Duplicate AWBs

Prevention:

- Attempt-scoped Idempotency-Key on create.
- Pre-check `findAwbsByMeta(vendure_shipment_key)` before POST.
- `awaiting_bolesa` / `created`-without-TN never blind POST.

If duplicates appear at Partner:

1. Adopt the preferred TN via meta lookup / Admin note.
2. Cancel the unwanted AWB at Partner (manual Partner portal if needed).
3. Align Vendure outbox `trackingNumber` + `syncStatus=created`.

---

## 7. Partner outages (429 / 409 / 5xx)

| Response | Outbox behavior | Operator action |
|----------|-----------------|-----------------|
| 409 / 5xx | JobQueue retries (same idempotency key) | Wait; check Partner status |
| Exhausted retries | `retry_exhausted` | Admin create retry after outage |
| 4xx (non-409) | `failed` | Fix data; Admin retry |
| 429 | Treated as retryable if classified 5xx-like / client maps retryable | Back off; do not hammer Admin retry |
| Cancel refused (`awb_not_cancellable`) | Error recorded; may need RTO | Follow Partner return process |

Do not flip `synchronize` or re-run migrations on production to “fix” outages.

---

## 8. Worker restart & queue recovery

1. `npm run start:worker` (root) → **only** Worker (`dist/index-worker.js`).
2. `npm run start:server` → **only** Server (`dist/index.js`).
3. Do **not** use root `npm start -w server` / `vendure start all` for single-role processes.

On restart:

- PENDING/RETRYING jobs resume.
- Orphan `requested` / `cancel_requested` rows are healed by reconcile (every 15m) or sooner via Admin retry.

---

## 9. Reconciliation procedures

Scheduled task: `bolesa-reconcile-shipments` (Worker + DefaultSchedulerPlugin).

Each run:

1. Recover orphaned create jobs / mark create exhaustion.
2. Recover orphaned cancel jobs / mark cancel exhaustion.
3. Page open shipments (`reconcileBatchSize` × `reconcileMaxBatches`, default 100×10).
4. Lookup `awaiting_bolesa` / created-without-TN; poll status for TNs.

If reconcile fails: check Worker logs for `Bolesa reconcile failed` / `BolesaMetric reconcile`.  
Fix Partner connectivity; do not disable the task long-term.

---

## 10. Process cheat sheet

| Goal | Command / API |
|------|----------------|
| Start API only | `npm run start:server` |
| Start Worker only | `npm run start:worker` |
| Ops snapshot | `bolesaOpsHealth` |
| Retry create | `bolesaRetryShipment` |
| Retry cancel | `bolesaRetryCancelShipment` |
| Cancel | `bolesaCancelShipment` |
| Abandon | `bolesaAbandonShipment` |
| Verify Partner token | `testBolesaConnection` |
