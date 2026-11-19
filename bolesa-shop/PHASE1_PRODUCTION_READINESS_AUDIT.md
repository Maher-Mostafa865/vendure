# Phase 1.6 — Bolesa Phase 1 Production Readiness Audit

**Date:** 2026-11-20  
**Mode:** Read-only (no code, migration, DB, or env changes)  
**Basis:** Code review + prior Phase 1 / 1.5 reports (unit, outbox, PG/JobQueue integration).  
**Not performed here:** Partner API calls, AWB create/cancel, Sandbox E2E, production deploy.

### Verdict summary

| Gate | Result |
|------|--------|
| **Sandbox E2E readiness** | **NO-GO** |
| **Production readiness** | **NO-GO** |

Architecture for async outbox + Worker is sound and partially proven on `vendure-bolesa-test`. Remaining issues (fresh-migration order, retry/orphan edge cases, missing Sandbox proof, ops tooling) block both Sandbox sign-off and production.

Legend for findings: **Verified** = confirmed in code and/or Phase 1.5 tests. **Assumption** = inferred risk not fully exercised.

---

## 1. Outbox & JobQueue

### F-OQ-01 — Exhausted retries leave `requested` and recovery re-enqueues forever

| | |
|--|--|
| **Severity** | **High** |
| **Where** | `bolesa-shipment.service.ts` `createAwbForFulfillment` (retryable throw); `recoverOrphanedRequestedShipments`; `decideCreateJobEnqueue` |
| **Evidence** | Transient failures rethrow → JobQueue retries (5). On exhaustion job is `FAILED` / settled; `syncStatus` often still `requested`. Recovery only skips active PENDING/RUNNING/RETRYING — not FAILED — so every reconcile (15 min) past grace **enqueues again**. **Verified** in code; **Assumption** on production volume. |
| **Impact** | Partner API hammering; noisy queues; unbounded self-heal without backoff/cap. |
| **Fix** | After final failure set `syncStatus=failed` (or `retry_exhausted`); recovery must not re-enqueue without Admin retry / maxAttempts; optional exponential backoff on `updatedAt`. |
| **Blocks Sandbox E2E?** | No (can test carefully). |
| **Blocks production?** | **Yes** until bounded. |

### F-OQ-02 — `hasActiveCreateAwbJob` global `LIMIT 500` can miss the matching job

| | |
|--|--|
| **Severity** | **High** |
| **Where** | `hasActiveCreateAwbJob` (`bolesa-shipment.service.ts` ~233–251) |
| **Evidence** | SQL filters only `queueName` + active states + `isSettled=false`, then filters in memory. Under >500 active create jobs, the matching row may fall outside LIMIT → false negative → **duplicate enqueue**. Schema of `job_record` (`queueName`, `data` text/json, `state`, `isSettled`) matches query. Active states PENDING/RUNNING/RETRYING are correct vs Vendure `JobState`. **Verified** schema/states; miss rate **Assumption**. |
| **Impact** | Duplicate create jobs (mitigated by Partner idempotency + pre-check, not eliminated). |
| **Fix** | Query by JSON fields (`data->>'fulfillmentId'` etc.) or index expression; remove reliance on global LIMIT scan. |
| **Blocks Sandbox?** | No. **Production?** Prefer fix before scale; not a hard go/no-go alone. |

### F-OQ-03 — Create gate allows non-terminal statuses to “proceed”

| | |
|--|--|
| **Severity** | **High** |
| **Where** | `createAwbForFulfillment` gate (~460–485) |
| **Evidence** | Only `created` (with TN), `abandoned`, `canceled`, `failed` short-circuit. **`awaiting_bolesa`**, **`requested`**, **`cancel_requested`** all `proceed` and may call `createAwb` again. Mitigations: same idempotency key; `findAwbsByMeta`. Weak if Partner 202 left no searchable AWB yet. **Verified** in code. |
| **Impact** | Extra Partner creates / races during 202 window or cancel overlap. |
| **Fix** | Treat `awaiting_bolesa` as wait/reconcile-only; refuse create when `cancel_requested`. |
| **Blocks Sandbox?** | Soft — exercise 202 path carefully. **Production?** **Yes** until clarified. |

### F-OQ-04 — `cancel_requested` has no orphan recovery / active-job dedupe

| | |
|--|--|
| **Severity** | **High** |
| **Where** | `onOrderCancelled`, `requestCancel`, `processCancelAwb`; recovery only handles `requested` |
| **Evidence** | Cancel save + `cancelQueue.add` non-atomic; no `hasActiveCancelJob`; reconcile lists `cancel_requested` for status poll but does not re-enqueue cancel. **Verified**. |
| **Impact** | Stuck cancel after crash between save and enqueue. |
| **Fix** | Mirror create recovery for cancel; dedupe active cancel jobs. |
| **Blocks Sandbox?** | Partial. **Production?** **Yes** for cancel reliability. |

### F-OQ-05 — `retryShipment` bypasses enqueue guard

| | |
|--|--|
| **Severity** | **Medium** |
| **Where** | `retryShipment` (~374–399) |
| **Evidence** | Bumps attempt, saves, `createQueue.add` directly — no `ensureCreateAwbJobEnqueued`. Can stack jobs if clicked twice. **Verified**. |
| **Impact** | Duplicate jobs (attempt-scoped keys help Partner-side). |
| **Fix** | Use `ensureCreateAwbJobEnqueued` after bump; or disable UI while active job exists. |
| **Blocks?** | Sandbox no; production soft. |

### F-OQ-06 — Channel / fulfillment isolation (create path)

| | |
|--|--|
| **Severity** | **Low** (positive) |
| **Where** | `findByFulfillmentId`, `lockShipmentForFulfillment`, `jobMatchesShipment`, list queries |
| **Evidence** | Lookups use `fulfillmentId` + `channelId`. Job match includes both + attempt. Phase 1.5 test 5 **PASS**. **Verified**. |
| **Impact** | — |
| **Fix** | Keep; extend same pattern to cancel dedupe. |
| **Blocks?** | No. |

### F-OQ-07 — Permanently stuck job / shipment classes

| Stuck pattern | Mechanism | Severity |
|---------------|-----------|----------|
| `requested` + no job + within 60s grace | Waits grace + reconcile | Low |
| `requested` + FAILED jobs after retries | F-OQ-01 re-enqueue storm or silent fail loop | High |
| `failed` (4xx) | No auto recovery (by design); needs Admin retry | OK / Medium ops |
| `awaiting_bolesa` without TN forever | Reconcile meta poll; if Partner never materializes, stuck until manual | Medium |
| `cancel_requested` + no cancel job | F-OQ-04 | High |
| `orderId = '0'` | Create throws; job retries then fails | High (see F-AWB-02) |

---

## 2. Transaction & Concurrency

### F-TX-01 — Partner HTTP outside DB transactions (create path) — good

| | |
|--|--|
| **Severity** | **Low** (positive) |
| **Where** | `createAwbForFulfillment` |
| **Evidence** | Gate txn → HTTP → commit txn; errors recorded in short txns. Phase 1.5 locking test **PASS**. **Verified**. |
| **Blocks?** | No. |

### F-TX-02 — `applyObservedStatus` holds row lock across Vendure transitions

| | |
|--|--|
| **Severity** | **Medium** |
| **Where** | `applyObservedStatus` (~680–739) |
| **Evidence** | Partner `getAwb` is **outside** txn (**good**). Inside txn: `FOR UPDATE` then `settlePayment` / `transitionFulfillmentToState` while lock held. Not Partner HTTP, but lock duration grows. Deadlock **Assumption** under concurrent cancel + reconcile. |
| **Impact** | Lock contention; possible timeout under load. |
| **Fix** | Narrow lock to status field update; run transitions after commit. |
| **Blocks?** | Sandbox no; production harden before scale. |

### F-TX-03 — Cancel processor lacks pessimistic lock

| | |
|--|--|
| **Severity** | **Medium** |
| **Where** | `processCancelAwb` |
| **Evidence** | Read/modify/save without `withTransaction`/`FOR UPDATE`. Dual cancel jobs can race. **Verified**. |
| **Fix** | Same two-phase pattern as create. |
| **Blocks?** | Soft for Sandbox; yes for production cancel safety. |

### F-TX-04 — TOCTOU between `hasActiveCreateAwbJob` and `add`

| | |
|--|--|
| **Severity** | **Medium** |
| **Where** | `ensureCreateAwbJobEnqueued` |
| **Evidence** | Check-then-add not atomic. Phase 1.5 concurrent recovery still got 1 job in practice (**Verified** test 7) but race remains (**Assumption** under higher parallelism). |
| **Fix** | Unique partial index on unsettled jobs by fulfillment/attempt, or advisory lock. |
| **Blocks?** | Soft. |

### F-TX-05 — Stale status overwrite protection

| | |
|--|--|
| **Severity** | **Low** (positive with caveats) |
| **Where** | `shouldIgnoreAsStale` / `status-map.ts` |
| **Evidence** | Rank + timestamp check before apply. **Verified** unit tests. Caveat: equal ranks / clock skew **Assumption**. |
| **Blocks?** | No. |

---

## 3. AWB Lifecycle

### F-AWB-01 — Fulfillment handler correctly avoids HTTP in DB txn

| | |
|--|--|
| **Severity** | **Low** (positive) |
| **Where** | `bolesa-fulfillment-handler.ts` |
| **Evidence** | Validates city hash, weights, COD full coverage; returns metadata only. Outbox on post-commit `FulfillmentEvent`. **Verified**. |
| **Blocks?** | No. |

### F-AWB-02 — `orderId` may be saved as `'0'`

| | |
|--|--|
| **Severity** | **High** |
| **Where** | `onFulfillmentCreated` (~157–178) |
| **Evidence** | Default `orderId: '0'`; only set if `fulfillment.orders[0]` loads. Create then `findOne(orderId)` throws → retries → fail. **Verified** in code; frequency **Assumption**. |
| **Impact** | Permanent create failure for some fulfillments. |
| **Fix** | Fail outbox creation if order missing; or resolve order via OrderLine join before save. |
| **Blocks Sandbox?** | **Yes** if path hit. **Production?** **Yes**. |

### F-AWB-03 — Idempotency & duplicate detection

| | |
|--|--|
| **Severity** | **Low–Medium** |
| **Where** | `idempotencyKey = shipmentKey-a{attempt}`; `findAwbsByMeta`; Partner `Idempotency-Key` |
| **Evidence** | Design matches Rev 2. Client sends key on create/cancel. **Verified** code + unit tests. Live Partner behavior **unverified** (no Sandbox). |
| **Blocks Sandbox?** | Must prove in E2E. **Production?** Requires Sandbox proof. |

### F-AWB-04 — Permanent vs transient errors

| | |
|--|--|
| **Severity** | **Low** (positive) with F-OQ-01 caveat |
| **Where** | `BolesaApiError.isRetryable` / `isDefiniteFailure`; create catch |
| **Evidence** | 409/5xx retry; other 4xx → `failed` + history. Network → 503 retryable. **Verified**. Exhausted retry gap = F-OQ-01. |
| **Blocks?** | See F-OQ-01. |

### F-AWB-05 — Reconciliation / polling

| | |
|--|--|
| **Severity** | **Medium** |
| **Where** | `bolesa-reconcile.task.ts`, `reconcileOpenShipments` |
| **Evidence** | Every 15 min via `DefaultSchedulerPlugin` (Worker-only). Recovers `requested` then polls open sync statuses (take 100/channel). No webhooks (Phase 2) — **correctly not claimed** in Phase 1 reports. Backlog beyond 100/channel delayed. **Verified**. |
| **Blocks?** | Soft; document capacity. |

### F-AWB-06 — Partial fulfillment / COD rules

| | |
|--|--|
| **Severity** | **Medium** (product limitation) |
| **Where** | fulfillment handler COD check; `buildCreateInput` uses `order.totalWithTax` |
| **Evidence** | COD requires single full fulfillment of all lines. COD amount = **full order** `totalWithTax` (includes shipping) — **Verified**. Partial prepaid fulfillments allowed by handler but COD amount on full order would be wrong if partial COD were ever allowed — currently blocked. |
| **Impact** | Documented MVP constraint; multi-fulfillment COD unsupported. |
| **Blocks?** | No if scope stays single full COD fulfillment. |

---

## 4. Multi-tenancy & Security

### F-SEC-01 — Channel scoping on custom entities

| | |
|--|--|
| **Severity** | **Low** (positive) with note |
| **Where** | Connection `innerJoin` channels; shipment queries by `channelId` |
| **Evidence** | Admin list/find scoped. Connection via channel join. **Verified**. Raw `hasActiveCreateAwbJob` is global then filtered — isolation via match fields (F-OQ-02). |
| **Blocks?** | No. |

### F-SEC-02 — Token encryption & Admin exposure

| | |
|--|--|
| **Severity** | **Low** (positive) |
| **Where** | `DefaultEncryptionStrategy`; `toPublicView`; Admin GraphQL |
| **Evidence** | Token stored encrypted; Admin exposes `tokenLast4` only — not ciphertext/plaintext. Webhook secret not in GraphQL type. Schema review in ops report. **Verified**. |
| **Blocks?** | No. Ensure prod `VENDURE_ENCRYPTION_KEY` is strong (ops). |

### F-SEC-03 — Permissions

| | |
|--|--|
| **Severity** | **Medium** |
| **Where** | `bolesa-admin.resolver.ts`, `permissions.ts` |
| **Evidence** | Queries/mutations use `@Allow` for connection/shipment perms. Runtime role assignment **not re-verified** in this audit (**Assumption**). |
| **Fix** | Confirm Superadmin/roles grant in Sandbox checklist. |
| **Blocks Sandbox?** | Checklist item. |

### F-SEC-04 — Shop API surface

| | |
|--|--|
| **Severity** | **Low–Medium** |
| **Where** | `shopApiExtensions`, `bolesa-shop.resolver.ts`, custom fields |
| **Evidence** | Shop: `bolesaSearchCities` only. `bolesaQuote` / fulfillment Bolesa fields `public: false`. City search decrypts Partner token server-side — expected; **no rate limit** (**Assumption** abuse risk). |
| **Blocks?** | Soft; add rate limiting before production traffic. |

### F-SEC-05 — Webhook fields without webhook implementation

| | |
|--|--|
| **Severity** | **Low** |
| **Where** | Entity + Admin `webhookApproved`; no webhook HTTP handlers in Phase 1 |
| **Evidence** | Phase 1 docs correctly say no webhooks. UI field may imply support. **Verified** absence of webhook routes in plugin. |
| **Fix** | Hide/document “Phase 2” in Admin UI. |
| **Blocks?** | No if messaging clear. |

### F-SEC-06 — `labelUrl` stored but not on Shop GraphQL

| | |
|--|--|
| **Severity** | **Low** (positive) |
| **Evidence** | Admin shipment type omits `labelUrl`; availability enum only. Matches Phase 0 S3 limitation. **Verified**. |

---

## 5. COD & Fulfillment

### F-COD-01 — COD amount includes shipping

| | |
|--|--|
| **Severity** | **Low** (meets design) |
| **Where** | `buildCreateInput` → `minorToMajor(order.totalWithTax)` |
| **Evidence** | **Verified**. Aligns with completion report. |
| **Blocks?** | No. |

### F-COD-02 — Vendure settle ≠ Bolesa remittance

| | |
|--|--|
| **Severity** | **Low** (positive) |
| **Where** | COD handler notes; `codRemittanceStatus` default `unknown`; settle on DELIVERED |
| **Evidence** | Remittance not auto-flipped to remitted. **Verified**. No statements polling UI (Phase 1). |
| **Blocks?** | No; ops must not assume remittance from settle. |

### F-COD-03 — Partial fulfillment

| | |
|--|--|
| **Severity** | **Medium** (limitation) |
| **Evidence** | COD blocked unless full coverage. Prepaid partial OK at handler; one outbox per fulfillment. Multi-AWB COD not supported. |
| **Blocks?** | No if product accepts limitation. |

---

## 6. Database & Migrations

### F-MIG-01 — Fresh install migration order (timestamp inversion)

| | |
|--|--|
| **Severity** | **Critical** |
| **Where** | `1763590000000-bolesa-phase1.ts` vs `1794915937588-init.ts` |
| **Evidence** | TypeORM runs ascending timestamps → Bolesa **before** Init on empty DB → fails (ALTER core tables missing). Test harness runs Init then Bolesa; default `npx vendure migrate` / `index.ts` `runMigrations(config)` does **not**. `vendure-dev` happened to apply Init first historically. **Verified** in Phase 1.5 migrate work. |
| **Impact** | Greenfield production/staging installs break. |
| **Fix** | New forward migration strategy (e.g. renumber with careful history plan) or documented ordered migrate; do **not** casually rename without plan (out of scope for this audit). |
| **Blocks Sandbox?** | If using existing populated DB, maybe no. **Production greenfield?** **Yes**. |

### F-MIG-02 — FK/index naming drift

| | |
|--|--|
| **Severity** | **Medium** |
| **Evidence** | Phase 1.5 migrate output / schema drift investigation: TypeORM wants different constraint/index names than migration SQL; partial unique on TN is intentional. Runtime OK. **Verified** warnings. |
| **Impact** | Noise; `synchronize: true` dangerous; future generate-migration confusion. |
| **Fix** | Align names in a deliberate follow-up migration; keep `synchronize: false`. |
| **Blocks?** | Soft. |

### F-MIG-03 — Upgrade path for existing `vendure-dev`-like DBs

| | |
|--|--|
| **Severity** | **Low** |
| **Evidence** | If Init already applied, Bolesa migration applies. **Assumption** for other environments. |
| **Blocks?** | No if Init precedes Bolesa in history. |

---

## 7. Operational Readiness

### F-OPS-01 — Dev scripts fixed; prod `start:server` naming still wrong

| | |
|--|--|
| **Severity** | **Medium** |
| **Where** | Root `package.json` `start:server` → `npm run start -w server` → `vendure start all` |
| **Evidence** | Dev `dev:server` / `dev:worker` corrected. Root `start:server` still starts **all** backend targets. **Verified**. |
| **Impact** | Duplicate processes / confusion in prod-like scripts. |
| **Fix** | Mirror `start:server` / `start:worker` to workspace scripts. |
| **Blocks?** | Soft for Sandbox; fix before production runbooks. |

### F-OPS-02 — Queue registration & Worker entry

| | |
|--|--|
| **Severity** | **Low** (positive) |
| **Where** | `onModuleInit` queues; `index-worker.ts` `startJobQueue()` |
| **Evidence** | Phase 1.5 Worker consumed harmless job; create/cancel queues start with Worker. Graceful stop observed in test teardown. Custom drain/metrics **missing**. **Verified** / gap. |
| **Blocks?** | Monitoring gap → production soft NO. |

### F-OPS-03 — Reconciliation scheduling

| | |
|--|--|
| **Severity** | **Low** |
| **Evidence** | Task registered; runs Worker-only with `DefaultSchedulerPlugin`. Test config omitted scheduler (intentional). Prod config includes it. **Verified**. |
| **Blocks?** | No. |

### F-OPS-04 — Missing monitoring / runbooks

| | |
|--|--|
| **Severity** | **High** (ops) |
| **Evidence** | No alerts on `lastError`, FAILED jobs, stuck `requested`/`cancel_requested`, reconcile failures. No documented on-call recovery beyond Admin retry/abandon. **Verified** absence. |
| **Fix** | Metrics on queue depth/failures; dashboard for syncStatus; runbook for orphan/retry. |
| **Blocks production?** | **Yes** for responsible ops. |

### F-OPS-05 — No Sandbox Partner E2E

| | |
|--|--|
| **Severity** | **Critical** (readiness) |
| **Evidence** | All reports: unit + PG/JobQueue with **mocked** client. No approved token E2E. **Verified**. |
| **Blocks Sandbox E2E gate?** | This **is** the gate — currently **NO-GO**. |
| **Blocks production?** | **Yes**. |

---

## Cross-cutting: what Phase 1.5 did and did not prove

| Proven on `vendure-bolesa-test` | Not proven |
|--------------------------------|------------|
| Persist outbox; recovery enqueue; dedupe; channel isolation; rollback; PG `FOR UPDATE`; Worker job complete; no fetch in tests | Live Partner create/cancel/idempotency; label URLs; COD remittance; webhook; fresh `vendure migrate` without harness; production load; monitoring |

---

## Prioritized remediation plan

### P0 — Before Sandbox E2E

1. Obtain approved Sandbox token + written permission for AWB create/cancel.  
2. Fix **F-AWB-02** (`orderId` resolution) so Sandbox fulfillments cannot stick on `'0'`.  
3. Fix or tightly script **F-MIG-01** if Sandbox starts from empty DB.  
4. Add Sandbox checklist: connection test, rate, fulfill → job → TN, cancel, reconcile, COD settle path.  
5. Soften **F-OQ-03** for `awaiting_bolesa` before exercising 202 responses.

### P1 — Before production

1. **F-OQ-01** bound exhausted-retry recovery.  
2. **F-OQ-04** / **F-TX-03** cancel orphan recovery + locking.  
3. **F-OQ-02** precise active-job SQL.  
4. **F-OPS-01** / **F-OPS-04** scripts + monitoring/runbooks.  
5. **F-MIG-02** naming cleanup migration (planned).  
6. **F-SEC-04** rate-limit city search.  
7. Re-run `test:bolesa` + `test:bolesa:integration` after fixes.

### P2 — Hardening

1. **F-TX-02** shorten status-apply lock scope.  
2. **F-OQ-05** Admin retry dedupe.  
3. **F-SEC-05** hide webhook UI until Phase 2.  
4. Capacity/backlog strategy for reconcile `take: 100`.

---

## Final gates

### 1. Sandbox E2E readiness: **NO-GO**

**Why:** No live Partner E2E; orderId edge case; create-gate/`awaiting_bolesa` risk; migration order hazard on empty DB; cancel orphan gap. Local PG/JobQueue PASS is necessary but not sufficient.

### 2. Production readiness: **NO-GO**

**Why:** All Sandbox blockers, plus unbounded retry recovery (F-OQ-01), cancel reliability (F-OQ-04), monitoring/runbooks (F-OPS-04), greenfield migrate (F-MIG-01), script footguns (F-OPS-01).

### 3. Do not implement fixes in this task

Remediation should follow review of this audit; next engineering slice should tackle P0 items explicitly.

---

*End of Phase 1.6 production readiness audit.*
