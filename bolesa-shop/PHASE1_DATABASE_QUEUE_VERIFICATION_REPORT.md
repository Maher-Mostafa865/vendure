# Phase 1.5 — Database & JobQueue Integration Verification Report

**Date:** 2026-11-20  
**Project:** `bolesa-shop`  
**Verdict:** **PASS** (PostgreSQL + JobQueue + Worker integration on isolated DB)

Sandbox E2E / real Partner AWB operations are **not** claimed.

---

## Exact PostgreSQL database used

| Field | Value |
|-------|--------|
| Database | **`vendure-bolesa-test`** |
| Host | `127.0.0.1` |
| Port | `6543` |
| Role | `vendure` (password not logged) |
| Schema | `public` |
| Dev DB left alone | **`vendure-dev`** — no writes; shipment/job counts remained `0` / `0` |

Hard abort if resolved name ≠ `vendure-bolesa-test` (`assert-test-db.ts` + `.env.test` + test config).

---

## Database provisioning result

| Step | Result |
|------|--------|
| Catalog before | Only `vendure-dev` (+ templates) |
| `CREATE DATABASE "vendure-bolesa-test" OWNER vendure` | **Success** |
| Already existed? | No (created fresh) |
| `.env.test` | Created (gitignored via `.env.*`); loads with `override: true`; no fallback to `.env` |

---

## Migration results

Harness: `npm run test:bolesa:migrate` → `migrate-test-db.ts`  
Runs **Init then BolesaPhase1** (empty-DB safe order). Migration **source files were not modified**.

| Migration | Result |
|-----------|--------|
| `Init1794915937588` | Applied successfully |
| `BolesaPhase11763590000000` | Applied successfully |
| `synchronize` | **Not used** (`false`) |
| Exit code | **0** |

Verified on `vendure-bolesa-test`: `bolesa_shipment`, `job_record`, `channel`, `migrations` present.

Note: TypeORM still reports cosmetic naming drift (indexes/FKs) vs entity metadata — same class of drift documented earlier; tables required for tests exist and function.

---

## Ten required tests

Executed by: `npm run test:bolesa:integration`  
Runner: `ts-node` + `emitDecoratorMetadata` (tsx cannot Nest-inject).  
Against: **real PostgreSQL** + **DefaultJobQueuePlugin / `job_record`** + **bootstrapWorker**.  
Partner: `BolesaClient` methods stubbed; `globalThis.fetch` banned.

| # | Test | Result | Evidence |
|---|------|--------|----------|
| 1 | Persist `requested` BolesaShipment | **PASS** | Row id persisted; `syncStatus=requested`; DB=`vendure-bolesa-test` |
| 2 | Recovery enqueues missing create job | **PASS** | `recoverOrphanedRequestedShipments` → `activeJobs=1` for fulfillment |
| 3 | Second recovery no duplicate active job | **PASS** | Second run `enqueued=0`, `skippedActive≥1`, still 1 active job |
| 4 | Detect PENDING / RUNNING / RETRYING | **PASS** | All three states detected; ensure enqueue → `skip_active_job` |
| 5 | Channel isolation | **PASS** | Active job on channel A not matched for channel B |
| 6 | Transaction rollback | **PASS** | `withTransaction` throw → shipment key count `0` |
| 7 | Concurrent recovery | **PASS** | Two parallel recoveries → exactly **1** active create job |
| 8 | Pessimistic `FOR UPDATE` (2 PG sessions) | **PASS** | Session 2 hit `lock_timeout`; `secondSessionBlocked=true` |
| 9 | Worker consumes harmless JobQueue job | **PASS** | `bolesa-integration-harmless` job → `COMPLETED` with result |
| 10 | No Partner API fetch | **PASS** | `fetchCallCount=0`; stubs throw if client methods used |

**Suite:** `# tests 10` / `# pass 10` / `# fail 0` / exit code **0**.

---

## PostgreSQL transaction and locking evidence

- **Rollback:** intentional error inside `TransactionalConnection.withTransaction` left zero rows for the rollback shipment key.
- **Locking:** two `pg.Client` sessions on `vendure-bolesa-test`; session 1 `BEGIN` + `SELECT … FOR UPDATE`; session 2 `lock_timeout=400ms` blocked (asserted).

---

## Job persistence and deduplication evidence

- Create jobs written to real `job_record` with `queueName=bolesa-create-awb`.
- Active-job detection uses SQL on `job_record` (avoids Admin `list-query-limit` of 100 that broke `take: 200` via `findMany`).
- Dedup: second recovery and concurrent recovery kept a single PENDING job per fulfillment/channel/attempt.

---

## Worker consumption evidence

- `bootstrapWorker(testConfig)` against test DB only (no scheduler → no reconcile Partner polls).
- Consumers started only in test 9 after deleting leftover create/cancel jobs.
- Harmless queue `bolesa-integration-harmless` processed to `COMPLETED`.
- Worker closed in `after()` (queues stopped).

---

## Partner API safety

| Control | Status |
|---------|--------|
| `BOLESA_API_BASE_URL=http://127.0.0.1:9/forbidden-partner-api` | Set |
| `BolesaClient.*` stubbed to throw / empty | Yes |
| `globalThis.fetch` throws + counted | Yes; count **0** |
| Real AWB create/cancel | Not performed |

---

## Production code fix during verification

`hasActiveCreateAwbJob` previously used `strategy.findMany({ take: 200 })`, which throws Vendure `error.list-query-limit-exceeded` (default max take 100). Replaced with direct `job_record` SQL via `TransactionalConnection.rawConnection` (LIMIT 500). This is required for recovery to work under DefaultJobQueuePlugin.

Also: explicit `type: 'boolean'` on three `BolesaConnection` columns so tsx/ts-node entity metadata resolves without relying solely on emitDecoratorMetadata for those fields.

---

## Commands and exit codes

| Command | Exit |
|---------|------|
| `CREATE DATABASE "vendure-bolesa-test"` | 0 |
| `npm run test:bolesa:migrate` | **0** |
| `npm run test:bolesa:integration` | **0** |
| `npm run test:bolesa` (38 unit tests) | **0** |
| `npm run typecheck` | **0** |
| `npm run build:server` | **0** |

---

## Files added / updated (test harness + fix)

| Path | Role |
|------|------|
| `apps/server/.env.test` | Isolated env (gitignored) |
| `apps/server/tsconfig.integration.json` | Decorator metadata for Nest DI in tests |
| `apps/server/src/plugins/bolesa/tests/integration/*` | Assert, env load, config, migrate, PG/JobQueue suite |
| `apps/server/package.json` | `test:bolesa:migrate`, `test:bolesa:integration` |
| `apps/server/src/plugins/bolesa/services/bolesa-shipment.service.ts` | SQL-based active-job detection |
| `apps/server/src/plugins/bolesa/entities/bolesa-connection.entity.ts` | Explicit boolean column types |

---

## Remaining blockers (outside this PASS)

1. **Sandbox E2E** — requires approved Partner token + explicit permission for real AWB create/cancel (separate phase).
2. **Migration timestamp order** — on empty DBs, harness must run Init before Bolesa; consider a future baseline rename only with a deliberate migration plan (not done here).
3. **Cosmetic schema drift** (index/FK naming) remains vs TypeORM metadata — does not block these tests.

---

## Acceptance

Phase 1.5 PostgreSQL / JobQueue / concurrency / locking / rollback / Worker integration: **PASS** on `vendure-bolesa-test`.

Unit-only evidence is no longer the sole proof.

*End of report.*
