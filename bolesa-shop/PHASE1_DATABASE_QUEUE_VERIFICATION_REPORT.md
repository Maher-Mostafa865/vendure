# Phase 1.5 — Database & JobQueue Integration Verification Report

**Date:** 2026-11-20  
**Project:** `bolesa-shop`  
**Verdict:** **BLOCKED — not executed against PostgreSQL + real Vendure JobQueue**

This report does **not** claim that the ten required integration tests passed. They were **not** run against an isolated PostgreSQL test database or a live Worker JobQueue consumer, because no approved isolated test database exists.

---

## 1. Test database inspection

### Configuration found

| Source | Finding |
|--------|---------|
| `apps/server/.env` | `DB_NAME=vendure-dev`, `DB_HOST=127.0.0.1`, `DB_PORT=6543`, user `vendure` |
| `apps/server/.env.test` | **Absent** |
| `apps/server/docker-compose.yml` | Single Postgres service; `POSTGRES_DB: vendure-dev` only |
| `apps/server/package.json` | `test:bolesa` = Node unit tests only; **no** Postgres/e2e harness |
| Plugin tests dir | Unit specs only (`*.spec.ts`); no `createTestingModule` / DB bootstrap |

### PostgreSQL catalogs (read-only)

Connected via unix socket `/tmp:6543` as role `vendure`:

| Database | Role |
|----------|------|
| `postgres` | system |
| `template0` / `template1` | templates |
| **`vendure-dev`** | **only application database** |

No `vendure-test`, `bolesa-egy_test`, or other dedicated test database is present.

### Read-only snapshot of `vendure-dev` (no writes)

| Object | Present | Row count / notes |
|--------|---------|-------------------|
| `bolesa_shipment` | yes | **0** |
| `job_record` | yes | no `bolesa%` queues; only COMPLETED core queues (`update-search-index`, etc.) |
| `job_record_buffer` | yes | (not mutated) |

### Safety decision

Required tests need **writes** (insert shipment, insert `job_record`, concurrent transactions, Worker consume). Safety rules forbid:

- destructive setup on `vendure-dev`
- creating/modifying databases **without approval**
- enqueuing real AWB create/cancel jobs
- calling Bolesa Partner API

**Therefore:** no isolated test DB → **do not create one** → **skip all ten integration tests** and report the blocker.

---

## 2. Required tests — execution status

| # | Requirement | Status | Reason |
|---|-------------|--------|--------|
| 1 | Save `requested` BolesaShipment on real PG test DB | **SKIPPED** | No isolated test DB; would write to `vendure-dev` |
| 2 | Recovery enqueues missing create job | **SKIPPED** | Needs (1) + JobQueue persistence |
| 3 | Second recovery does not duplicate active job | **SKIPPED** | Needs (2) |
| 4 | Detect existing PENDING/RUNNING/RETRYING job | **SKIPPED** | Needs real `job_record` writes/reads under test control |
| 5 | Channel isolation | **SKIPPED** | Needs multi-channel rows in test DB |
| 6 | Transaction rollback behavior | **SKIPPED** | Needs PG transactions against test DB |
| 7 | Concurrent recovery from two independent txns | **SKIPPED** | Needs PG + controlled concurrency |
| 8 | Pessimistic locking with actual PG transactions | **SKIPPED** | Needs PG `FOR UPDATE` under two sessions |
| 9 | Worker consumes harmless test job with mocked `BolesaClient` | **SKIPPED** | Needs Worker + JobQueue + test DB; risk of touching shared `vendure-dev` |
| 10 | No real Partner API requests | **SKIPPED** | Dependent on (9); not exercised in this session |

**None of the above were executed against PostgreSQL or the real Vendure JobQueue in this verification.**

---

## 3. What *was* executed (non-claim for integration)

| Check | Result | Limits |
|-------|--------|--------|
| Catalog / table presence (read-only SQL) | Pass | Observation only |
| Unit suite `npm run test:bolesa` | **38/38 pass** | Pure/mocked helpers — **not** PG/JobQueue integration |
| Prior code design (outbox recovery + `withTransaction`) | Documented in `PHASE1_OUTBOX_RELIABILITY_REPORT.md` | Design proof ≠ runtime PG proof |

---

## 4. PostgreSQL transaction and lock results

**Not obtained.** No multi-session `BEGIN` / `SELECT … FOR UPDATE` / rollback tests were run.

---

## 5. Job persistence and deduplication results

**Not obtained.** No `bolesa-create-awb` rows were inserted or inspected under a controlled recovery loop in this session.

Read-only observation: `job_record` currently has **zero** `bolesa%` jobs in `vendure-dev`.

---

## 6. Worker processing result

**Not obtained.** No Worker was started for this verification; no mocked create-AWB job was consumed.

---

## 7. Remaining blockers before Sandbox E2E

### Blocker A — Isolated test database (this phase)

**Approval needed** to create and use something like:

```text
Database: vendure-bolesa-test   (or similar; NOT vendure-dev)
Host/port: same PG instance or dedicated compose service
Migrations: applied only to the test DB
```

Until that exists (and is named in env / test harness), Phase 1.5 DB+JobQueue integration verification **cannot** honestly claim PASS.

Suggested minimal harness (after approval only):

1. Create empty DB `vendure-bolesa-test`.
2. Point a test bootstrap at it (`DB_NAME=vendure-bolesa-test`).
3. Run migrations against **that** DB only.
4. Integration tests that:
   - insert `BolesaShipment` (`requested`)
   - call `recoverOrphanedRequestedShipments` / `ensureCreateAwbJobEnqueued` with real `SqlJobQueueStrategy`
   - assert `job_record` counts/states
   - open two PG sessions for lock + rollback proofs
   - start Worker briefly with **mocked** `BolesaClient` and a **non-Partner** process fn or stubbed create path that never `fetch`es
5. Tear down test rows or drop only the test DB — never `vendure-dev`.

### Blocker B — Sandbox Partner token

Even after DB/JobQueue integration PASS, Sandbox E2E still needs an approved Partner token and explicit permission to create/cancel real AWBs. That is out of scope for this report.

### Blocker C — Shared `vendure-dev` is the live local shop DB

Using it for concurrent lock tests or Worker job consumption risks interfering with the running Server (`vendure-dev` already has COMPLETED core jobs and an active local stack).

---

## 8. Approval ask (explicit)

To unblock the next iteration, please approve **one** of:

1. **Create** database `vendure-bolesa-test` on the existing Postgres (`6543`) and allow migrations + write tests **only** there; or  
2. **Add** a compose service / volume for a dedicated test Postgres; or  
3. **Designate** an already-provisioned isolated DB name/credentials if one will be created outside this agent.

Until then, Phase 1.5 database & JobQueue integration remains **BLOCKED**.

---

## 9. Summary

| Claim | Status |
|-------|--------|
| Integration tests 1–10 passed against PG + real JobQueue | **No — not run** |
| Isolated test DB available | **No** |
| `vendure-dev` used for destructive/test writes | **No** (forbidden; avoided) |
| Unit tests still green | **Yes (38/38)** |
| Sandbox E2E | **Not started** |

*End of Phase 1.5 database & JobQueue verification report.*
