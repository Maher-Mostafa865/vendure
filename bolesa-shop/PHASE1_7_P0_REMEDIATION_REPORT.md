# Phase 1.7 — P0 Sandbox Blockers Remediation Report

**Date:** 2026-11-20  
**Scope:** Only F-AWB-02, F-OQ-03, F-MIG-01  
**Safety:** No Partner API / AWB traffic; no writes to `vendure-dev`; no `synchronize:true`; no P1/P2 work.

### Verdict summary

| Gate | Result |
|------|--------|
| **P0 remediation** | **PASS** |
| **Sandbox E2E** | **NO-GO** (not executed; not claimed) |
| **Production** | **NO-GO** (remaining Phase 1.6 High findings still open) |

---

## 1. F-AWB-02 — Invalid `orderId` fallback

### Root cause

`onFulfillmentCreated` defaulted `orderId` to `'0'` when `fulfillment.orders` was not loaded. That created a valid-looking outbox row that later failed `orderService.findOne`, retried via JobQueue, and could be re-enqueued forever by orphan recovery.

### Files changed

| File | Change |
|------|--------|
| `apps/server/src/plugins/bolesa/util/create-awb-gate.ts` | Added `isValidPersistedOrderId` |
| `apps/server/src/plugins/bolesa/services/bolesa-shipment.service.ts` | `resolveOrderIdForFulfillment`; fail-closed `onFulfillmentCreated`; create path rejects invalid `orderId` |
| `apps/server/src/plugins/bolesa/tests/order-resolution.spec.ts` | Regression contract tests |
| `apps/server/src/plugins/bolesa/tests/create-awb-gate.spec.ts` | `isValidPersistedOrderId` cases |

### Behavior before / after

| | Before | After |
|--|--------|-------|
| Missing Order relation | Persist `orderId='0'`, enqueue create | Log actionable error; patch Fulfillment `bolesaSyncStatus=failed`; **no** outbox row |
| Valid `Fulfillment.orders[0]` | Used if present | Used first |
| Fallback | None (fabricated `'0'`) | `FulfillmentLine` → `OrderLine.order` |
| Create with bad persisted `orderId` | Throw / retry | Mark shipment `failed`, return `{ ok: false }` (no indefinite Partner create) |

### Tests added and executed

- `order-resolution.spec.ts` — rejects `0` / empty / null; fail-closed without outbox; accepts real ids
- `create-awb-gate.spec.ts` — `isValidPersistedOrderId` suite
- Executed via `npm run test:bolesa` (51 pass)

### Migration compatibility

N/A (application logic only).

### Remaining risks

- If both `orders` and `FulfillmentLine` relations are empty in a legitimate edge case, create is skipped until Ops/Admin investigates (intentional fail-closed).
- Unit tests cover the gate/contract; full Nest event-bus resolution is not re-proven in this phase’s integration suite.

---

## 2. F-OQ-03 — Tighten `createAwbForFulfillment` state gate

### Root cause

Create processing treated `awaiting_bolesa` and `cancel_requested` like create-eligible states, so a job could POST `/awbs` again during Partner 202 windows or cancel overlap (mitigated only by Partner idempotency / meta lookup).

### Files changed

| File | Change |
|------|--------|
| `apps/server/src/plugins/bolesa/util/create-awb-gate.ts` | `decideCreateAwbGate` with explicit decisions per status |
| `apps/server/src/plugins/bolesa/services/bolesa-shipment.service.ts` | Gate-driven create; `awaiting_lookup` = meta lookup only |
| `apps/server/src/plugins/bolesa/tests/create-awb-gate.spec.ts` | One test per syncStatus decision |

### Explicit create decisions

| `syncStatus` | Decision | Partner create? |
|--------------|----------|-----------------|
| `requested` | `proceed` | Yes (after pre-check) |
| `awaiting_bolesa` | `awaiting_lookup` | **No** — `findAwbsByMeta` only; return ok if still queued |
| `cancel_requested` | `terminal` | **Never** |
| `created` + tracking | `done` | No |
| `created` without tracking | `proceed` | Pre-check / heal only path |
| `failed` | `terminal` | No (Admin `retryShipment` resets to `requested` first) |
| `abandoned` | `terminal` | No |
| `canceled` | `terminal` | No |
| Unknown | `terminal` (`failed`) | No |

Admin retry (`retryShipment`) still sets `syncStatus='requested'`, bumps attempt / idempotency key, then enqueues — eligible failed shipments remain retryable without weakening Partner duplicate detection.

### Behavior before / after

| | Before | After |
|--|--------|-------|
| `awaiting_bolesa` | Could reach `createAwb` again | Lookup/reconcile only |
| `cancel_requested` | Could proceed to create | Hard stop |
| `failed` / `abandoned` / `canceled` | Already short-circuited | Unchanged terminal |
| `requested` | Create | Unchanged proceed |

### Tests added and executed

- `create-awb-gate.spec.ts` — all statuses above
- `npm run test:bolesa` — pass

### Migration compatibility

N/A.

### Remaining risks

- Jobs already mid-flight that race with `cancel_requested` still rely on re-check after Partner response (late create must not overwrite terminal/cancel state — guarded in post-create transaction).
- F-OQ-01 (unbounded recovery of exhausted `requested`) and F-OQ-04 (cancel orphan recovery) remain open (P1/out of scope).

---

## 3. F-MIG-01 — Fresh database migration ordering

### Root cause

Historical `BolesaPhase11763590000000` timestamp sorts **before** `Init1794915937588`. On a fresh empty DB, default `runMigrations` applied Bolesa DDL first and failed (missing `channel` / core tables). Renaming/reordering the historical migration would break installs that already recorded it.

### Strategy chosen (safe, no history rewrite)

1. **Keep** `BolesaPhase11763590000000` name/timestamp for upgrade compatibility.
2. Make its `up()` a **no-op when `channel` is missing** (fresh empty DB); apply full DDL when core tables already exist (legacy path).
3. Add **`BolesaPhase1EnsureAfterInit1794915937589`** (timestamp after Init) that applies the same idempotent DDL (`IF NOT EXISTS` + transaction-safe FK adds).
4. Shared helper lives in `migrations/lib/` so it is **not** picked up by the TypeORM migrations glob (a helper file in `migrations/*.ts` previously caused `someClass is not a constructor`).

Default production order on empty DB:

1. `BolesaPhase1` → no-op (recorded)
2. `Init` → core schema
3. `BolesaPhase1EnsureAfterInit` → Bolesa schema

Upgrade path (Init + historical Bolesa already recorded): only Ensure runs; DDL is idempotent.

### Files changed

| File | Change |
|------|--------|
| `apps/server/src/migrations/1763590000000-bolesa-phase1.ts` | Defer when no `channel` |
| `apps/server/src/migrations/1794915937589-bolesa-phase1-ensure-after-init.ts` | **New** post-Init ensure |
| `apps/server/src/migrations/lib/apply-bolesa-phase1-schema.ts` | Shared idempotent DDL |
| `apps/server/src/plugins/bolesa/tests/integration/migrate-test-db.ts` | Uses `runMigrations(testConfig)` (production order) |
| `apps/server/package.json` | `test:bolesa:migrate` via `ts-node` + `reflect-metadata` |

### Behavior before / after

| Path | Before | After |
|------|--------|-------|
| Fresh empty DB | Fail (Bolesa before Init) | Succeed: no-op → Init → Ensure |
| Existing (Init + Bolesa recorded) | Already had tables | Ensure applies idempotently; history preserved |
| `vendure-dev` | — | **Untouched** (Ensure not applied there in this task) |

### Migration compatibility evidence (`vendure-bolesa-test` only)

**Upgrade path** (DB already had Init + BolesaPhase1):

```
Successfully ran migration: BolesaPhase1EnsureAfterInit1794915937589
migrations: Init1794915937588, BolesaPhase11763590000000, BolesaPhase1EnsureAfterInit1794915937589
bolesa_shipment / bolesa_connection present
```

**Fresh path** (DROP/CREATE empty `vendure-bolesa-test`, then migrate):

```
Successfully ran migration: BolesaPhase11763590000000
Successfully ran migration: Init1794915937588
Successfully ran migration: BolesaPhase1EnsureAfterInit1794915937589
channel + bolesa_shipment present
```

**`vendure-dev` check after tests:** still only Init + BolesaPhase1 in `migrations`; shipment count `0`.

### Remaining risks

- TypeORM/Vendure prints a **schema drift warning** after migrate: entity metadata prefers hashed index/FK names vs our explicit SQL names. Runtime uniqueness/FKs still enforce correctly; a future P1 cleanup migration could align names. **Not** fixed here (would be a broader schema-alignment plan).
- Fresh installs record historical `BolesaPhase1` as executed even when it no-op’d — intentional so history stays consistent with the class name.
- Existing databases must run Ensure once (normal `runMigrations`); this task did not apply it to `vendure-dev`.

---

## Commands executed

| Command | Result |
|---------|--------|
| `npm run test:bolesa` | **51 pass** / 0 fail |
| `npm run test:bolesa:integration` | **10 pass** / 0 fail (`vendure-bolesa-test`) |
| `npm run typecheck` | **exit 0** |
| `npm run build:server` | **Built server successfully** |
| `npm run test:bolesa:migrate` | Upgrade + fresh paths **exit 0** |

---

## What was explicitly not done

- Sandbox E2E / real Bolesa AWB create or cancel
- Production DB access
- Changes to `vendure-dev`
- P1/P2 findings (F-OQ-01 unbounded recovery, F-OQ-04 cancel orphans, ops tooling, schema name alignment, etc.)

---

## Final verdict

| | |
|--|--|
| **P0 remediation** | **PASS** |
| **Sandbox E2E** | **NO-GO** |
| **Production** | **NO-GO** |

P0 Sandbox blockers F-AWB-02, F-OQ-03, and F-MIG-01 are remediated and verified on `vendure-bolesa-test`. Sandbox readiness still requires a dedicated E2E pass against Partner Sandbox; production remains blocked by remaining High findings from Phase 1.6.
