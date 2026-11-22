# Phase 1.10 — Close Operational Readiness Gaps

**Date:** 2026-11-20  
**Safety:** No Partner API / AWB traffic; no `vendure-dev` changes; no production DB writes.

### Verdict summary

| Gate | Result |
|------|--------|
| **Operational documentation** | **PASS** |
| **Alerting readiness** | **PARTIAL** (formats + rules documented; no tested provider wiring) |
| **Multi-instance readiness** | **PARTIAL** (limits documented; in-process limiter retained; no Redis) |
| **Sandbox E2E** | **NO-GO** |
| **Production** | **NO-GO** |

---

## 1. Runbook safety

### Changes

- Rewrote [`BOLESA_OPERATIONS_RUNBOOK.md`](./BOLESA_OPERATIONS_RUNBOOK.md).
- **Every** channel-specific SQL example now requires `"channelId" = :channelId` (or `data::json->>'channelId'` for `job_record`).
- Added stuck `cancel_requested` and active job queries with channel filters.
- Cross-channel exposure called out: unscoped shipment dumps forbidden; queue health API now channel-filters job payloads.
- GraphQL mutations/queries verified against `api-extensions.ts` and resolvers:
  - `bolesaOpsHealth`, `bolesaRetryShipment`, `bolesaRetryCancelShipment`, `bolesaCancelShipment`, `bolesaAbandonShipment`, `testBolesaConnection`
- Root scripts verified against `bolesa-shop/package.json`:
  - `start:server` → workspace `start:server` → `node ./dist/index.js`
  - `start:worker` → workspace `start:worker` → `node ./dist/index-worker.js`
  - `start` → storefront + server only (not Worker / not `vendure start all`)

### Corrections to prior misleading bits

| Before | After |
|--------|-------|
| Stuck-requested SQL missing `channelId` | Channel filter required |
| `lastPartnerVerifiedAt` implied Partner liveness | Renamed/docs → `lastConnectionTestAt` = explicit connection test only |
| Queue counts global in ops health | Filtered by job `channelId` for current Admin channel |
| § numbering mismatched (“§3 Cancel” vs create) | Sections renumbered; cheat sheet aligned |

---

## 2. Partner health semantics

| Item | Detail |
|------|--------|
| **Source** | `bolesa_connection.lastVerifiedAt` set only in `testConnection()` after successful Partner `/me` |
| **GraphQL field** | Renamed `lastPartnerVerifiedAt` → **`lastConnectionTestAt`** on `BolesaOpsHealth` |
| **TypeScript** | `BolesaOpsSnapshot.lastConnectionTestAt` + notes |
| **Not a live health indicator** | Create/cancel/status success does **not** update this timestamp |

---

## 3. Alerting

Deliverable: [`BOLESA_ALERTING.md`](./BOLESA_ALERTING.md)

| Delivered | Not delivered (intentionally) |
|-----------|-------------------------------|
| Exact `BolesaMetric` log format | Tested Datadog/PagerDuty/Prometheus client |
| Recommended thresholds for exhausted / stuck / backlog / reconcile failures | Guaranteed alerts in any environment |
| Integration instructions + example env vars for log shippers / external pollers | In-app notifier |

Also added `BolesaMetric reconcile_failed …` on reconcile exceptions (stable parseable line, truncated message, no PII).

**Alerting readiness: PARTIAL** — operators can wire alerts; this phase did not test a provider end-to-end.

---

## 4. Multi-instance rate limiting

| Item | Status |
|------|--------|
| In-process `FixedWindowRateLimiter` | Retained (local / single-instance) |
| Code comment + runbook §10 | Document production multiplier ≈ instances × limit |
| Redis / shared store | **Not added** — requires explicit plan (key schema, TTL, fail-open/closed, load test) |
| Edge recommendation | Prefer CDN/gateway limits until shared limiter exists |

**Multi-instance readiness: PARTIAL.**

---

## 5. Code / docs touched

| Path | Change |
|------|--------|
| `api-extensions.ts` | `lastConnectionTestAt` + description |
| `util/ops-metrics.ts` | Field rename + semantics |
| `bolesa-shipment.service.ts` | Channel-scoped queue stats; connection-test field/notes |
| `bolesa-reconcile.task.ts` | `reconcile_failed` metric line |
| `util/rate-limit.ts` | Multi-instance limitation docs |
| `BOLESA_OPERATIONS_RUNBOOK.md` | Safety rewrite |
| `BOLESA_ALERTING.md` | **New** |
| `p1-hardening.integration.spec.ts` | Field rename in evidence |
| `PHASE1_10_OPERATIONAL_GAPS_REPORT.md` | This report |

**Migrations / `vendure-dev`:** none.

---

## 6. Final verification

| Command | Result |
|---------|--------|
| `npm run test:bolesa` | **63 pass** |
| `npm run test:bolesa:integration` | **28 pass** |
| `npm run typecheck` | exit 0 |
| `npm run build:server` | success (~1.7s) |
| `vendure-dev` shipment count | **0** (untouched) |

---

## Remaining gaps (explicit)

1. External alert provider not configured/tested in this repo.
2. Shared rate limiter not implemented.
3. Sandbox Partner E2E still absent → Sandbox/Production **NO-GO**.
4. Ops health still requires Admin to select the correct channel context before querying.

---

## Final verdict

| | |
|--|--|
| **Operational documentation** | **PASS** |
| **Alerting readiness** | **PARTIAL** |
| **Multi-instance readiness** | **PARTIAL** |
| **Sandbox E2E** | **NO-GO** |
| **Production** | **NO-GO** |
