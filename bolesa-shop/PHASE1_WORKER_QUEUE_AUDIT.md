# Phase 1.5 — Worker & Queue Verification Audit

**Date:** 2026-11-20  
**Scope:** Read-only audit of Worker startup, JobQueue registration, and Bolesa outbox processing  
**Codebase:** `bolesa-shop` (Vendure 3.8.2)  
**Constraints honored:** No code changes, no migrations, no DB resets, no AWB enqueue, no Partner API calls, no process kills, no env/port changes.

---

## Executive verdict: **PARTIAL**

The project is **architecturally set up correctly** for a separate Worker that consumes `bolesa-create-awb` / `bolesa-cancel-awb` via `DefaultJobQueuePlugin` + DB-backed `job_record`. Outbox enqueue is designed to run **after** the fulfillment DB transaction commits (via Vendure `EventBus` commit gating). Retries and attempt-scoped idempotency keys are present in code.

Phase 1.5 cannot be closed as **PASS** because:

1. Correct Worker CLI usage is easy to get wrong (`vendure worker` is invalid).
2. Root script naming causes **duplicate Server** / `EADDRINUSE :::3000` when combined with an already-running server.
3. This audit session did **not** start a Worker process (safety / no process interference); queue **consumption** for Bolesa was therefore not re-observed live.
4. DB evidence: **zero** `bolesa-*` rows in `job_record`; **zero** `bolesa_shipment` rows — so job persistence/consumption for Bolesa has not been proved end-to-end.
5. Unit tests prove client/status/rate/COD helpers with mocks — **not** JobQueue processing or outbox transaction boundaries.

---

## 1. Correct Worker startup command

### CLI truth (Vendure 3.8.2 `@vendure/cli`)

There is **no** top-level `vendure worker` command.

```text
$ npx vendure worker
Unknown command "worker".
```

Valid targets:

| Mode | Command | Entry |
|------|---------|--------|
| Dev Worker only | `npx vendure dev worker` | `./src/index-worker.ts` via ts-node |
| Dev Server only | `npx vendure dev server` | `./src/index.ts` |
| Dev all | `npx vendure dev all` (default) | server + worker + dashboard |
| Prod Worker | `npx vendure start worker` (after build) | `./dist/index-worker.js` |
| Prod Server | `npx vendure start server` | `./dist/index.js` |

Confirmed from CLI help (`vendure dev [target]` → `all | server | worker | dashboard`) and process definitions in Vendure CLI (`packages/cli/src/commands/dev/dev.ts` lines 20, 75–83, 115–158): Worker runs `ts-node ./src/index-worker.ts`.

### Project scripts (authoritative for this repo)

**`apps/server/package.json`** (lines 5–16):

| Script | Expands to | Meaning |
|--------|------------|---------|
| `dev:worker` | `vendure dev worker` | **Correct** isolated Worker in dev |
| `dev:server` | `vendure dev server` | Server only |
| `dev` | `vendure dev all` | Server + Worker + Dashboard |
| `start:worker` | `node ./dist/index-worker.js` | Prod Worker after build |
| `start` | `vendure start all` | Built server + worker |

**Root `bolesa-shop/package.json`** (lines 5–14):

| Script | Expands to | Actual effect |
|--------|------------|---------------|
| `dev:server` | `npm run dev -w server` | Runs workspace script **`dev`** → **`vendure dev all`** (server+worker+dashboard) |
| `dev` | concurrently server workspace `dev` + storefront | Also pulls in `vendure dev all` |

**Recommended commands (from `apps/server/`):**

```bash
# Terminal A — API only
npm run dev:server          # vendure dev server

# Terminal B — Job consumer only
npm run dev:worker          # vendure dev worker
```

Or one process group:

```bash
npm run dev                 # vendure dev all
```

**Do not** use root `npm run dev:server` expecting “server only” — it starts **all** backend targets.

Worker bootstrap entry (`apps/server/src/index-worker.ts` lines 1–8):

```ts
bootstrapWorker(config)
  .then(worker => worker.startJobQueue())
```

Server entry (`apps/server/src/index.ts` lines 1–8) calls `runMigrations` + `bootstrap(config)` only — **does not** call `startJobQueue()`.

---

## 2. Server vs Worker as separate processes

| Concern | Finding |
|---------|---------|
| Separate processes? | **Yes.** CLI `dev`/`start` spawn distinct server and worker children (`dev.ts` lines 80–83, 137–146). |
| Shared config? | **Yes.** Both import `./vendure-config` (`index.ts` / `index-worker.ts`). |
| Who polls queues? | **Worker only**, via `VendureWorker.startJobQueue()` → `JobQueueService.start()` (`packages/core/src/worker/vendure-worker.ts` lines 29–31; `job-queue.service.ts` lines 100–107). |
| Who can enqueue? | **Server** (and Worker if events fire there): `JobQueue.add` persists via `SqlJobQueueStrategy.add` without requiring `hasStarted` (`job-queue.ts` lines 90–100). |
| Job storage | `DefaultJobQueuePlugin.init({ useDatabaseForBuffer: true })` in `vendure-config.ts` line 90 → SQL `job_record` (+ buffer storage when JobBuffers are active). |
| Scheduler / reconcile | `DefaultSchedulerPlugin` + `bolesaReconcileTask`; tasks run when `processContext.isWorker` (default `runTasksInWorkerOnly`) — `scheduler.service.ts` lines 57–59. |

**Architecture intent:** HTTP/GraphQL on Server; queue consumers + scheduled reconcile on Worker. This matches Vendure’s recommended split.

---

## 3. Root cause of duplicate Server / `EADDRINUSE :::3000`

**Identifiable root cause: overlapping Server bootstraps on port 3000, driven by script naming + `vendure dev all`.**

1. **Misnamed root script**  
   Root `npm run dev:server` → `npm run dev -w server` → apps/server’s **`dev`** script = `vendure dev all` (`bolesa-shop/package.json` line 7; `apps/server/package.json` line 9).  
   That always starts a **new Server** child (`dev.ts` lines 80–83, 127–136) listening on `PORT` / `VENDURE_SERVER_PORT` / **3000** (`vendure-config.ts` lines 20, 24).

2. **Conflict with an already-running Server**  
   If `npx vendure dev server` (or any prior Server) already owns `:3000`, starting `vendure dev all` (directly or via root `dev:server`) attempts a **second** `bootstrap()` → Nest listen → **`EADDRINUSE :::3000`**.  
   Log noise that looks like “duplicate Server bootstrap” is consistent with two Server processes, not with Worker also binding HTTP (Worker uses `bootstrapWorker` / standalone Nest context — no API listen).

3. **Not caused by Worker itself**  
   Worker entry does not call `app.listen` on the Shop/Admin port. Duplicate Server is a **process orchestration** issue, not a Bolesa queue bug.

4. **Secondary confusion**  
   Operational docs previously mixed `npx vendure start worker` with `npm run dev:server` (`PHASE1_OPERATIONAL_VERIFICATION_REPORT.md` lines 68–71). `start worker` requires a build; `dev:server` at root is not “server only.”

---

## 4. Queue registration and processing architecture

### Queue names

Defined in `apps/server/src/plugins/bolesa/constants.ts` lines 9–11:

| Constant | Name | Registered? |
|----------|------|-------------|
| `CREATE_AWB_QUEUE` | `bolesa-create-awb` | **Yes** |
| `CANCEL_AWB_QUEUE` | `bolesa-cancel-awb` | **Yes** |
| `APPLY_STATUS_QUEUE` | `bolesa-apply-status` | **No** — constant only; unused |

### Registration

`BolesaShipmentService.onModuleInit` (`bolesa-shipment.service.ts` lines 68–76):

```ts
this.createQueue = await this.jobQueueService.createQueue({
  name: CREATE_AWB_QUEUE,
  process: async job => this.processCreateAwb(job.data),
});
this.cancelQueue = await this.jobQueueService.createQueue({
  name: CANCEL_AWB_QUEUE,
  process: async job => this.processCancelAwb(job.data),
});
```

Plugin providers include `BolesaShipmentService` (`bolesa.plugin.ts` lines 33–39). Comment at lines 92–94 defers queue setup to `onModuleInit`.

Both Server and Worker Nest apps load the plugin and **create** queues (register names + process fn). Only Worker **`start()`**s them, so only Worker polls.

### Enqueue paths

| Trigger | Method | Queue | Retries |
|---------|--------|-------|---------|
| Bolesa fulfillment created (`FulfillmentEvent`) | `onFulfillmentCreated` | create | `{ retries: 5 }` (lines 141–144, 184–187) |
| Admin retry | `retryShipment` | create | `{ retries: 5 }` (lines 281–284) |
| Order → Cancelled with live TN | `onOrderCancelled` | cancel | `{ retries: 5 }` (lines 249–256) |
| Admin cancel | `requestCancel` | cancel | `{ retries: 5 }` (lines 314–321) |

### Process handlers (live Partner HTTP)

| Handler | Lines | Partner calls |
|---------|-------|---------------|
| `processCreateAwb` → `createAwbForFulfillment` | 325–435 | `findAwbsByMeta`, `createAwb` |
| `processCancelAwb` | 437–479 | `cancelAwb` |
| `applyObservedStatus` / `reconcileOpenShipments` | 481–586 | `getAwb`, `findAwbsByMeta` (scheduled, not JobQueue) |

Fulfillment handler **does not** call HTTP (`bolesa-fulfillment-handler.ts` lines 6–8, 58–67) — only validates and returns sync metadata (`bolesaSyncStatus: 'requested'`).

### Status updates

Not via `bolesa-apply-status` queue. Reconciliation is a **ScheduledTask** (`bolesa-reconcile.task.ts` lines 10–24) every 15 minutes calling `reconcileOpenShipments()` directly on the Worker.

---

## 5. Outbox transaction-safety assessment

### Intended design (Rev 2)

1. Inside fulfillment transaction: handler validates; no AWB HTTP; no outbox write.
2. After commit: `FulfillmentEvent` → create `BolesaShipment` outbox row → `createQueue.add(...)`.

### EventBus commit gating (framework)

`EventBus.awaitActiveTransactions` (`packages/core/src/event-bus/event-bus.ts` lines 327–377) waits for the RequestContext transaction to **commit** before subscribers run; on rollback, the event is suppressed (`return` undefined).

`FulfillmentEvent` carries `ctx` + entity, so **`onFulfillmentCreated` runs after commit** of the fulfillment-creating transaction. This satisfies “no AWB / no job side-effect inside the DB txn that creates the Fulfillment.”

### Outbox + job atomicity (application)

Within `onFulfillmentCreated` (lines 133–188):

1. Idempotent path: if shipment already exists → re-`add` create job (lines 140–145).
2. Else: save `BolesaShipment` → patch Fulfillment custom fields → `createQueue.add`.

**Gap:** outbox `save` and `job_record` insert are **not** one DB transaction. Crash between them leaves an outbox row without a job.

**Mitigation present:** re-delivery of `FulfillmentEvent` or any path that sees `existing` re-enqueues (lines 140–145). Admin `retryShipment` also re-enqueues (lines 260–285).

**Residual risk:** if no second event and no admin retry, shipment can sit in `requested` until noticed. Reconcile only looks at `created | awaiting_bolesa | cancel_requested` (lines 556–560) — **not** stuck `requested` without a job. That is a real operational gap.

### Pessimistic lock note

`createAwbForFulfillment` uses `setLock('pessimistic_write')` (lines 345–352) **without** an explicit `TransactionalConnection.withTransaction` / query-runner transaction. TypeORM typically requires an open transaction for `FOR UPDATE`. Lock effectiveness at runtime is **unverified** in this audit; treat as a hardening risk for concurrent create jobs.

---

## 6. Retry and idempotency assessment

| Mechanism | Assessment |
|-----------|------------|
| Job retries `{ retries: 5 }` | Present on all enqueue sites. |
| Attempt-scoped Idempotency-Key | `idempotencyKey = \`${shipmentKey}-a${attempt}\`` (lines 149–155, 276–277); passed to `client.createAwb` (line 387). |
| Pre-check adopt | `findAwbsByMeta(..., 'vendure_shipment_key', shipment.shipmentKey)` before create (lines 368–373); same on admin retry (lines 271–275). |
| Retryable HTTP | 409 and ≥500 → save `lastError`, **rethrow** for JobQueue retry (lines 404–410). |
| Definite 4xx | Mark `failed`, history note, **return** without throw (lines 412–428) — no further job retries. |
| Already created | Early return if `syncStatus === 'created'` + TN (lines 358–360). |
| Cancel idempotency | `cancel-${shipmentKey}-a${attempt}` (line 445). |
| Non-cancellable | `awb_not_cancellable` → soft fail, no throw (lines 471–475). |
| Manual Cancelled guard | Fulfillment handler blocks Cancelled until Bolesa `CANCELED` (handler lines 69–76). |

**Safety verdict:** Design is sound for Partner idempotency + bounded retries. Not runtime-proved against live Bolesa in this audit.

**Caveats:**

- Re-enqueue on `existing` (lines 140–145) can add **duplicate** create jobs for the same fulfillment; processor early-exit / adopt should make that mostly harmless if locks/idempotency hold.
- Cancel jobs do not bump attempt; cancel key tied to current attempt only.

---

## 7. Can Worker run without unintended live Bolesa API calls?

| Condition | Live Partner HTTP? |
|-----------|-------------------|
| Worker starts, **no** pending `bolesa-*` jobs, **no** open shipments | Queue start logs only; reconcile finds nothing → **no** AWB create/cancel. `requireActive` may still run per channel inside reconcile loop and throw/continue without HTTP if no connection (`reconcileOpenShipments` lines 550–555). |
| Pending create/cancel jobs in `job_record` | **Yes** — process handlers call Partner API. |
| Open shipments `created` / `awaiting_bolesa` / `cancel_requested` | **Yes** — reconcile polls `getAwb` / `findAwbsByMeta`. |
| Server only (no Worker) | Jobs can be **enqueued** to DB; **not consumed**. Reconcile does not run on Server (worker-only default). |

**DB snapshot this audit (read-only, `/tmp:6543` / `vendure-dev`):**

- `job_record`: no `bolesa%` rows (other Vendure queues have COMPLETED history).
- `job_record_buffer`: 0 rows.
- `bolesa_shipment`: 0 rows.
- `bolesa_connection`: 0 rows.

So **today**, starting Worker should not call create/cancel AWB APIs unless config/connection/seeding changes and work appears. This audit **did not** start Worker to re-confirm logs.

**There is no dry-run / mock mode** in `BolesaClient` — any processed job or reconcile hit uses real `fetch` to `BOLESA_API_BASE_URL`.

---

## 8. Test coverage vs queue processing

Tests under `apps/server/src/plugins/bolesa/tests/`:

| File | What it proves |
|------|----------------|
| `bolesa-client.spec.ts` | Mocked `fetch`: headers, 422/409/202 queued mapping |
| `money.spec.ts` | EGP minor/major |
| `status-map.spec.ts` | Forward/stale/terminal helpers |
| `rate-and-cod.spec.ts` | Rate markup/COD fee modes; COD handler settle/cancel behavior |

**Missing (blockers for “queue verified”):**

- No test that `createQueue` / `cancelQueue` register with expected names.
- No test that `FulfillmentEvent` after commit creates outbox + enqueues (integration with EventBus / JobQueueStrategy).
- No test of `processCreateAwb` / `processCancelAwb` with mocked client + fake JobQueue.
- No test of crash between outbox save and `add`.
- No test that Server does not call `JobQueueService.start()`.
- No e2e: fulfill → `job_record` row → Worker completes → shipment `created`.

Phase 1 “22/22 passing” proves **helpers and client mapping**, not Worker/queue processing.

---

## 9. Safe manual verification procedure

Perform only when ready; still avoid live AWB unless sandbox token is approved.

### A. Process layout (no Partner calls required)

1. Ensure nothing else should own port 3000, **or** stop the existing Server yourself (this audit does not kill processes).
2. From `bolesa-shop/apps/server`:
   - Terminal A: `npm run dev:server`
   - Terminal B: `npm run dev:worker`
3. Expect Worker logs approximately:
   - `Bootstrapping Vendure Worker`
   - `Starting queue: bolesa-create-awb`
   - `Starting queue: bolesa-cancel-awb`
   - `Vendure Worker is ready` (or equivalent ready banner)
4. Expect **one** Server listen on `:3000`. Do **not** also run root `npm run dev:server` or a second `vendure dev all`.

### B. Persistence check without creating AWBs

```sql
-- Read-only
SELECT "queueName", state, count(*) FROM job_record
WHERE "queueName" LIKE 'bolesa%' GROUP BY 1, 2;
SELECT count(*) FROM bolesa_shipment;
```

Should stay empty until a Bolesa fulfillment is created.

### C. Controlled enqueue (sandbox only — not done in this audit)

1. Configure `BolesaConnection` with approved sandbox token.
2. Create shipping method + fulfill with `bolesa-fulfillment`.
3. Confirm **after** mutation success: one `bolesa_shipment` (`syncStatus=requested`) and one PENDING/RUNNING/COMPLETED `bolesa-create-awb` job.
4. Confirm Worker log processes job; shipment moves to `created` / `awaiting_bolesa` / `failed` as appropriate.
5. Cancel path: Admin `bolesaCancelShipment` → `bolesa-cancel-awb` job → `canceled`.

### D. Explicit anti-patterns

- `npx vendure worker` → unknown command.
- Root `npm run dev:server` while Server already running → `EADDRINUSE`.
- Running Worker against production Partner URL with open jobs/shipments → live side effects.

---

## 10. Blockers before Phase 1.5 can be closed

1. **Document / standardize** Worker start: `npm run dev:worker` or `npx vendure dev worker` from `apps/server` (and prod `start:worker` / `vendure start worker` after build).
2. **Fix or clearly rename** root `dev:server` so it does not mean `vendure dev all` (implementation is out of scope for this audit; naming is a Phase 1.5 close risk).
3. **Runtime proof** (operator-run): Worker starts queues; at least one create job round-trip in sandbox **or** a focused integration test with mocked `BolesaClient` + real JobQueue/DB.
4. **Address stuck-`requested` gap**: reconcile or a sweeper should re-enqueue orphaned outbox rows without jobs.
5. **Clarify / remove** unused `APPLY_STATUS_QUEUE` constant to avoid false expectations.
6. **Verify** pessimistic lock runs inside a transaction (or replace with safer concurrency control).
7. Keep **zero** unintentional Partner calls: no Worker against non-empty open shipments without sandbox approval.

---

## 11. Recommended next actions (priority order)

1. **P0 — Operator runbook:** Use `apps/server` `dev:server` + `dev:worker` (or single `dev` / `vendure dev all`), never bare `vendure worker`; never stack root `dev:server` on an existing Server.
2. **P0 — Rename or fix root scripts** so `dev:server` means server-only (`vendure dev server`), matching apps/server’s `dev:server`.
3. **P1 — Safe Worker smoke:** Start Worker alone; confirm queue start lines; confirm no `bolesa-*` jobs appear spontaneously (read-only SQL).
4. **P1 — Integration tests:** Mock `BolesaClient`; assert outbox + `JobQueue.add` after fulfillment event; assert create processor idempotency and 4xx vs 5xx behavior; assert cancel processor.
5. **P1 — Orphan recovery:** Include `requested` (and maybe `failed` retry policy) in reconcile or a dedicated sweeper that re-adds create jobs when no active job exists.
6. **P2 — Harden concurrency:** Wrap create processor lock/update in `withTransaction`.
7. **P2 — Remove or implement** `bolesa-apply-status` queue; document that Phase 1 status path is scheduled reconcile only.
8. **P2 — Update** `PHASE1_OPERATIONAL_VERIFICATION_REPORT.md` Worker commands to match CLI (`dev worker` vs `start worker`).
9. **P3 — Sandbox E2E** (requires approved token): one create + one cancel through Worker; capture `job_record` state transitions.

---

## Finding index (path + lines)

| ID | Finding | Verdict | References |
|----|---------|---------|------------|
| F1 | `vendure worker` invalid; use `vendure dev worker` / `start worker` | Confirmed | CLI help; `apps/server/package.json` 6–7, 15–16 |
| F2 | Root `dev:server` runs `vendure dev all` | Confirmed | Root `package.json` 7; server `package.json` 9 |
| F3 | `EADDRINUSE` from second Server on 3000 | Confirmed cause | `dev.ts` 80–83; `vendure-config.ts` 20, 24 |
| F4 | Server/Worker split + `startJobQueue` only on Worker | Pass | `index.ts`; `index-worker.ts`; `vendure-worker.ts` 29–31 |
| F5 | Queues `bolesa-create-awb` / `bolesa-cancel-awb` registered | Pass (code) | `constants.ts` 9–10; `bolesa-shipment.service.ts` 68–76 |
| F6 | `bolesa-apply-status` unused | Gap | `constants.ts` 11 |
| F7 | Outbox after EventBus commit | Pass (design) | `event-bus.ts` 327–377; shipment service 130–188 |
| F8 | Outbox save vs job add not atomic; stuck `requested` possible | Risk | shipment service 172–187, 556–560 |
| F9 | Retries + attempt idempotency + pre-check | Pass (design) | shipment service 184–187, 368–428 |
| F10 | Worker/reconcile will call live API if work exists | Risk | process handlers; `bolesa-reconcile.task.ts` |
| F11 | DB: zero Bolesa jobs/shipments | No e2e proof | Read-only SQL this audit |
| F12 | Tests do not cover queues/outbox | Gap | `plugins/bolesa/tests/*` |
| F13 | Fulfillment handler has no HTTP | Pass | `bolesa-fulfillment-handler.ts` 6–8, 58–67 |
| F14 | Job plugin DB buffer enabled | Config OK | `vendure-config.ts` 90 |

---

## Runtime verification performed in this audit

| Check | Result |
|-------|--------|
| Read package.json / entries / config / plugin / shipment service | Done |
| `npx vendure worker` → unknown command | Done |
| `npx vendure dev --help` / `start --help` targets | Done |
| Read-only SQL `job_record` / buffer / `bolesa_*` | Done |
| Start Worker / enqueue AWB / call Partner API | **Not performed** |
| Re-observe “Vendure Worker is ready” in this session | **Not performed** (prior session evidence only; not re-claimed here) |

---

*End of Phase 1.5 Worker & Queue Verification Audit — report only; no fixes applied.*
