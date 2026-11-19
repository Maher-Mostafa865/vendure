# Bolesa Phase 1 — Operations Runbook

**Audience:** On-call / Admin operators  
**Scope:** Vendure Bolesa plugin (create/cancel AWB outbox + JobQueue)  
**Safety:** Never paste Partner tokens, full addresses, or customer PII into tickets/logs.  
**DB safety:** Prefer staging / `vendure-bolesa-test`. Always filter by `"channelId"`. Never run unscoped shipment dumps on shared DBs.

Cross-reference: [BOLESA_ALERTING.md](./BOLESA_ALERTING.md) for metric formats and alert rules.

---

## 1. Quick health check

Admin GraphQL (permission: `ReadBolesaShipment`). Runs in the **current Admin channel context** — switch channel in the Dashboard before querying.

```graphql
query {
  bolesaOpsHealth {
    generatedAt
    stuckThresholdMs
    lastConnectionTestAt
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

Also scan Worker logs for:

- `BolesaMetric ops_health …`
- `BolesaMetric reconcile …`
- `BolesaMetric reconcile_failed …`

| Signal | Action |
|--------|--------|
| `stuckRequested` rising | §2 Diagnosing stuck create |
| `stuckCancelRequested` / `cancelRetryExhausted` | §4 Cancel path |
| `retryExhausted` / `failed` | Admin retry create (§3) |
| Queue `active` huge (channel-scoped) | Worker down or Partner slow (§7–8) |
| `lastConnectionTestAt` null/stale | Run `testBolesaConnection` — **not** proof that create/cancel APIs are healthy (§11) |

---

## 2. Diagnosing stuck shipments

### Sync status meanings

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

### SQL (always channel-scoped)

Replace `:channelId` with the numeric channel primary key (same as Admin channel).

```sql
-- Counts by status (REQUIRED: channel filter)
SELECT "syncStatus", count(*)
FROM bolesa_shipment
WHERE "channelId" = :channelId
GROUP BY 1;

-- Stuck requested > 30m (REQUIRED: channel filter)
SELECT s."fulfillmentId", s.attempt, s."updatedAt", s."lastError"
FROM bolesa_shipment s
WHERE s."channelId" = :channelId
  AND s."syncStatus" = 'requested'
  AND s."updatedAt" < now() - interval '30 minutes'
ORDER BY s."updatedAt" ASC
LIMIT 50;

-- Stuck cancel_requested > 30m (REQUIRED: channel filter)
SELECT s."fulfillmentId", s."trackingNumber", s."updatedAt", s."lastError"
FROM bolesa_shipment s
WHERE s."channelId" = :channelId
  AND s."syncStatus" = 'cancel_requested'
  AND s."updatedAt" < now() - interval '30 minutes'
ORDER BY s."updatedAt" ASC
LIMIT 50;

-- Active create jobs for this channel (job payload JSON)
SELECT id, state, attempts, retries, left(data, 120) AS data_preview
FROM job_record
WHERE "queueName" = 'bolesa-create-awb'
  AND state IN ('PENDING', 'RUNNING', 'RETRYING')
  AND "isSettled" = false
  AND (data::json->>'channelId') = :channelId::text
ORDER BY id DESC
LIMIT 50;

-- Active cancel jobs for this channel
SELECT id, state, attempts, retries, left(data, 120) AS data_preview
FROM job_record
WHERE "queueName" = 'bolesa-cancel-awb'
  AND state IN ('PENDING', 'RUNNING', 'RETRYING')
  AND "isSettled" = false
  AND (data::json->>'channelId') = :channelId::text
ORDER BY id DESC
LIMIT 50;
```

Do **not** select `orderId` joined to customer/address tables into chat/tickets.

---

## 3. Retrying create safely

Admin UI: **Retry AWB** when `syncStatus` is `failed`, `retry_exhausted`, or `requested`.  
GraphQL (permission: `UpdateBolesaShipment` / Write shipment permission):

```graphql
mutation {
  bolesaRetryShipment(fulfillmentId: "123") {
    fulfillmentId
    syncStatus
    attempt
    idempotencyKey
    lastError
  }
}
```

Behavior (verified against `retryShipment`):

1. Partner meta pre-check (adopt if AWB already exists).
2. Under row lock: bump `attempt` + `idempotencyKey` **at most once** when leaving failed/retry_exhausted/awaiting/created-without-TN.
3. Enqueue via `ensureCreateAwbJobEnqueued` (dedupes active jobs; double-click safe).
4. Rejected when status is `cancel_requested`, `cancel_retry_exhausted`, `canceled`, or `abandoned`.

---

## 4. Retrying cancel safely

Admin UI: **Retry cancel** when `cancel_retry_exhausted` or stuck `cancel_requested` (with tracking number).  
GraphQL:

```graphql
mutation {
  bolesaRetryCancelShipment(fulfillmentId: "123") {
    fulfillmentId
    syncStatus
    trackingNumber
    lastError
  }
}
```

Initial cancel (from `created` with TN):

```graphql
mutation {
  bolesaCancelShipment(fulfillmentId: "123") {
    fulfillmentId
    syncStatus
  }
}
```

- Restores/sets `cancel_requested` and enqueues cancel (deduped).
- Partner cancel key: `cancel-{shipmentKey}-a{attempt}` (idempotent).
- Exhausted cancel jobs become `cancel_retry_exhausted` — use **retry cancel**, not create retry.

---

## 5. Abandoning shipments

```graphql
mutation {
  bolesaAbandonShipment(fulfillmentId: "123")
}
```

Only when there is **no** live non-terminal Partner AWB. If a tracking number exists and status is non-terminal, cancel first.

---

## 6. Duplicate AWBs

Prevention:

- Attempt-scoped Idempotency-Key on create.
- Pre-check `findAwbsByMeta(vendure_shipment_key)` before POST.
- `awaiting_bolesa` / `created`-without-TN never blind POST.

If duplicates appear at Partner: adopt preferred TN, cancel unwanted AWB in Partner portal if needed, align outbox `trackingNumber` + `syncStatus=created`.

---

## 7. Partner outages (429 / 409 / 5xx)

| Response | Outbox behavior | Operator action |
|----------|-----------------|-----------------|
| 409 / 5xx | JobQueue retries (same idempotency key) | Wait; check Partner status |
| Exhausted retries | `retry_exhausted` | Admin create retry after outage |
| 4xx (non-409) | `failed` | Fix data; Admin retry |
| 429 | Depends on client classification — treat as back-off; do not hammer Admin retry | |
| Cancel refused (`awb_not_cancellable`) | Error recorded; may need RTO | Partner return process |

Do not enable `synchronize:true` or re-run migrations to “fix” outages. Do not modify `vendure-dev` from ops procedures aimed at production.

---

## 8. Worker restart & queue recovery

Verified root scripts (`bolesa-shop/package.json`):

| Goal | Command | Process |
|------|---------|---------|
| API only | `npm run start:server` | `apps/server` → `node ./dist/index.js` |
| Worker only | `npm run start:worker` | `apps/server` → `node ./dist/index-worker.js` |
| Storefront + API | `npm start` | concurrently storefront + **server only** (not Worker) |

Do **not** use `vendure start all` / `npm run start -w server` for single-role production processes (that starts all backend targets).

On Worker restart: PENDING/RETRYING jobs resume; orphan rows heal via reconcile (~15m) or Admin retry.

---

## 9. Reconciliation procedures

Scheduled task id: `bolesa-reconcile-shipments` (Worker + DefaultSchedulerPlugin).

Each run:

1. Recover orphaned create jobs / mark create exhaustion.
2. Recover orphaned cancel jobs / mark cancel exhaustion.
3. Page open shipments (`reconcileBatchSize` × `reconcileMaxBatches`, default 100×10).
4. Lookup `awaiting_bolesa` / created-without-TN; poll status for TNs.

Failures emit `BolesaMetric reconcile_failed …` (see alerting doc). Fix Partner connectivity; do not disable the task long-term.

---

## 10. City search rate limiting

- Shop query: `bolesaSearchCities(query)`.
- Default: **30 requests / 60s** per channel + session/IP (`citySearchRateLimit` plugin option).
- Over-limit returns `[]` and a warn log (no token/PII).

**Multi-instance:** limiter is **in-process only**. N Server replicas ≈ N× effective budget. Shared Redis limiter is **not** implemented — see Phase 1.10 report for the required plan before adding a dependency. Prefer edge rate limits and/or a single Shop API instance until then.

---

## 11. Partner health semantics (`lastConnectionTestAt`)

| Field | Source | Means | Does **not** mean |
|-------|--------|-------|-------------------|
| `bolesaOpsHealth.lastConnectionTestAt` | `bolesa_connection.lastVerifiedAt` | Last **successful** Admin `testBolesaConnection` (`/me`) | Last create/cancel/status Partner call succeeded |
| `bolesaConnection.lastVerifiedAt` | Same column | Same | Live outbox health |

To refresh: run `testBolesaConnection` for the channel. A stale/null value is **not** by itself an AWB outage — check `retry_exhausted`, queue depth, and Partner status pages.

---

## 12. Process cheat sheet

| Goal | Command / API |
|------|----------------|
| Start API only | `npm run start:server` |
| Start Worker only | `npm run start:worker` |
| Ops snapshot | `bolesaOpsHealth` |
| Retry create | `bolesaRetryShipment(fulfillmentId)` |
| Retry cancel | `bolesaRetryCancelShipment(fulfillmentId)` |
| Cancel | `bolesaCancelShipment(fulfillmentId)` |
| Abandon | `bolesaAbandonShipment(fulfillmentId)` |
| Explicit Partner token test | `testBolesaConnection` |
