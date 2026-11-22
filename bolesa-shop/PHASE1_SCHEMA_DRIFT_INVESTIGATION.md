# Phase 1 Schema Drift Investigation (Read-Only)

**Date:** 2026-11-19  
**Vendure:** 3.8.2  
**Database:** `vendure-dev` via local PostgreSQL 16 (`/tmp` socket, port `6543`)  
**Migrations recorded:** `Init1794915937588`, `BolesaPhase11763590000000`  
**Method:** Compared (1) entity decorators, (2) hand-written `1763590000000-bolesa-phase1.ts`, (3) live `pg_catalog` definitions, (4) full TypeORM `createSchemaBuilder().log()` output captured via `runMigrations` diagnostic callback (0 migrations executed; no schema writes).

**No source, migration, or database objects were modified.**

---

## 1. Executive summary

Schema drift is **real but almost entirely cosmetic / metadata-naming**, caused by the hand-written Phase 1 migration using **human-readable constraint/index names** and **UNIQUE CONSTRAINT** / **partial unique index** shapes that differ from what TypeORM’s `DefaultNamingStrategy` + current entity decorators emit.

There are **26 pending TypeORM sync statements** (CLI truncates after 10 with “…and 16 more”). They fall into four root-cause buckets:

| Bucket | Count (approx.) | Nature |
|--------|-----------------|--------|
| A. Rename join-table FKs (custom → hashed) + add `ON UPDATE CASCADE` | 8 (4 DROP + 4 ADD) | Naming + FK update action |
| B. Rename join-table column indexes (custom → hashed) | 8 (4 DROP + 4 CREATE) | Naming only |
| C. Replace `UNIQUE CONSTRAINT` with `UNIQUE INDEX` (hashed names) on shipment keys | 6 (3 DROP + 3 CREATE) | Constraint vs index form |
| D. `isActive` index rename; `trackingNumber` partial unique → non-unique index | 4 | Naming + **one semantic change** |

**No column add/drop/type/nullability drift** appears in the TypeORM diff. Custom-field columns match the migration and entities for Phase 1 purposes.

**Runtime safety:** The live schema already has the required tables, FKs (`ON DELETE CASCADE`), uniqueness on `fulfillmentId` / `shipmentKey` / `idempotencyKey`, and indexes. The application can run for Phase 1 operational verification **without** applying a sync.

**GO for Phase 1 runtime verification** (with known drift).  
**NO-GO for treating the migration story as “clean”** until a corrective migration or entity naming alignment lands (await approval).

---

## 2. Complete list of schema differences

Full TypeORM `upQueries` (header omitted):

```text
01 ALTER TABLE "bolesa_connection_channels_channel" DROP CONSTRAINT "FK_bolesa_conn_ch_channel"
02 ALTER TABLE "bolesa_connection_channels_channel" DROP CONSTRAINT "FK_bolesa_conn_ch_conn"
03 ALTER TABLE "bolesa_shipment_channels_channel" DROP CONSTRAINT "FK_bolesa_ship_ch_channel"
04 ALTER TABLE "bolesa_shipment_channels_channel" DROP CONSTRAINT "FK_bolesa_ship_ch_ship"
05 DROP INDEX "public"."IDX_bolesa_connection_isActive"
06 DROP INDEX "public"."UQ_bolesa_shipment_trackingNumber_notnull"
07 DROP INDEX "public"."IDX_bolesa_conn_ch_conn"
08 DROP INDEX "public"."IDX_bolesa_conn_ch_channel"
09 DROP INDEX "public"."IDX_bolesa_ship_ch_ship"
10 DROP INDEX "public"."IDX_bolesa_ship_ch_channel"
11 ALTER TABLE "bolesa_shipment" DROP CONSTRAINT "UQ_bolesa_shipment_shipmentKey"
12 ALTER TABLE "bolesa_shipment" DROP CONSTRAINT "UQ_bolesa_shipment_idempotencyKey"
13 ALTER TABLE "bolesa_shipment" DROP CONSTRAINT "UQ_bolesa_shipment_fulfillmentId"
14 CREATE INDEX "IDX_8d7d8075b7760b4ea9757db6bc" ON "bolesa_connection" ("isActive")
15 CREATE UNIQUE INDEX "IDX_23901590b38bcb086154ce6867" ON "bolesa_shipment" ("fulfillmentId")
16 CREATE INDEX "IDX_9244c8608a80c8632345e68250" ON "bolesa_shipment" ("trackingNumber")
17 CREATE UNIQUE INDEX "IDX_e7044843dc8ca51a4ff6d5a629" ON "bolesa_shipment" ("shipmentKey")
18 CREATE UNIQUE INDEX "IDX_c6f0cc83a1ad9c3f6c46f5b85e" ON "bolesa_shipment" ("idempotencyKey")
19 CREATE INDEX "IDX_b164d796362da55bff737f5a06" ON "bolesa_connection_channels_channel" ("bolesaConnectionId")
20 CREATE INDEX "IDX_7138f4d4f6b3975503314fb7c5" ON "bolesa_connection_channels_channel" ("channelId")
21 CREATE INDEX "IDX_89c622b5dd08cc96390cd83877" ON "bolesa_shipment_channels_channel" ("bolesaShipmentId")
22 CREATE INDEX "IDX_3bce1a19a8f3f28489df70b11f" ON "bolesa_shipment_channels_channel" ("channelId")
23 ALTER TABLE "bolesa_connection_channels_channel" ADD CONSTRAINT "FK_b164d796362da55bff737f5a062" FOREIGN KEY ("bolesaConnectionId") REFERENCES "bolesa_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE
24 ALTER TABLE "bolesa_connection_channels_channel" ADD CONSTRAINT "FK_7138f4d4f6b3975503314fb7c5e" FOREIGN KEY ("channelId") REFERENCES "channel"("id") ON DELETE CASCADE ON UPDATE CASCADE
25 ALTER TABLE "bolesa_shipment_channels_channel" ADD CONSTRAINT "FK_89c622b5dd08cc96390cd838774" FOREIGN KEY ("bolesaShipmentId") REFERENCES "bolesa_shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE
26 ALTER TABLE "bolesa_shipment_channels_channel" ADD CONSTRAINT "FK_3bce1a19a8f3f28489df70b11fb" FOREIGN KEY ("channelId") REFERENCES "channel"("id") ON DELETE CASCADE ON UPDATE CASCADE
```

These match `DefaultNamingStrategy` hashes computed independently (e.g. `IDX_8d7d8075b7760b4ea9757db6bc` for `bolesa_connection(isActive)`).

---

## 3. Root cause for each difference

### 3.1 Join-table foreign keys (items 01–04, 23–26)

| Aspect | Detail |
|--------|--------|
| **Actual DB** | `FK_bolesa_conn_ch_*`, `FK_bolesa_ship_ch_*` with `ON DELETE CASCADE` (Postgres omits default `ON UPDATE NO ACTION`) |
| **Migration** | Same custom names; `ON DELETE CASCADE ON UPDATE NO ACTION` |
| **Entity** | `@ManyToMany(() => Channel) @JoinTable()` with **no** `foreignKeyConstraintName` |
| **Vendure/TypeORM expects** | Hashed names (`FK_b164d…`, `FK_7138f…`, …) and **`ON UPDATE CASCADE`** on both junction FKs |
| **Why** | Hand-written SQL did not use TypeORM’s naming strategy; bare `@JoinTable()` lets TypeORM invent hashed FK names and its default update rule |
| **Safe / intentional / regression?** | **Safe** for runtime. Naming drift is intentional-by-accident (manual migration). `ON UPDATE CASCADE` vs `NO ACTION` is unlikely to matter (channel/connection PKs are not updated). Aligning is cleanup, not a bugfix |

Compare core Vendure: `product_channels_channel` already uses hashed FK names; entity-side FK often has `ON UPDATE CASCADE`.

### 3.2 Join-table indexes (items 07–10, 19–22)

| Aspect | Detail |
|--------|--------|
| **Actual DB / migration** | `IDX_bolesa_conn_ch_conn`, `IDX_bolesa_conn_ch_channel`, `IDX_bolesa_ship_ch_ship`, `IDX_bolesa_ship_ch_channel` |
| **Entity** | Implicit indexes from `@JoinTable()` / relation metadata (unnamed) |
| **Expected** | Hashed `IDX_b164d…`, `IDX_7138f…`, `IDX_89c622…`, `IDX_3bce1…` on the same columns |
| **Why** | Same manual-vs-TypeORM naming mismatch |
| **Classification** | **Safe**, cosmetic |

### 3.3 `isActive` index (items 05, 14)

| Aspect | Detail |
|--------|--------|
| **Actual DB / migration** | `CREATE INDEX "IDX_bolesa_connection_isActive" ON bolesa_connection ("isActive")` |
| **Entity** | `@Index()` on `isActive` (unnamed) |
| **Expected** | `IDX_8d7d8075b7760b4ea9757db6bc` |
| **Why** | Unnamed `@Index()` → TypeORM hash; migration chose a readable name |
| **Classification** | **Safe**, cosmetic |

### 3.4 Unique keys on `bolesa_shipment` (items 11–13, 15, 17–18)

| Aspect | Detail |
|--------|--------|
| **Actual DB / migration** | `CONSTRAINT "UQ_bolesa_shipment_fulfillmentId|shipmentKey|idempotencyKey" UNIQUE (...)` |
| **Entity** | `@Index({ unique: true })` on those three fields |
| **Expected** | `CREATE UNIQUE INDEX "IDX_<hash>" ON "bolesa_shipment" (...)` — unique **index**, not unique **constraint**, with hashed names |
| **Why** | Migration expressed uniqueness as table constraints with custom names; decorator `@Index({ unique: true })` maps to unique indexes named by TypeORM |
| **Classification** | **Safe** functionally (same uniqueness). Form/name drift only. Not a regression of uniqueness |

### 3.5 `trackingNumber` index (items 06, 16) — only semantic drift

| Aspect | Detail |
|--------|--------|
| **Actual DB / migration** | Partial unique: `UQ_bolesa_shipment_trackingNumber_notnull` … `WHERE ("trackingNumber" IS NOT NULL)` |
| **Entity (current)** | `@Index()` **non-unique**, no `where` clause (earlier partial-unique decorator was removed) |
| **Expected** | Non-unique `IDX_9244c8608a80c8632345e68250` on `"trackingNumber"` |
| **Why** | DB still has the stronger partial unique from the hand migration; entity metadata no longer declares uniqueness |
| **Classification** | **Intentional hardening in DB** vs **weaker entity expectation**. Not a runtime blocker. Dropping the partial unique to “fix” drift would be a **mild regression** of DB-level duplicate TN protection. Prefer keeping partial unique and teaching TypeORM about it, or accepting documented intentional drift |

### 3.6 What is *not* drifting

- Table/column sets for `bolesa_connection`, `bolesa_shipment`, and both join tables.
- Custom field columns on `address` / `order` / `fulfillment` / `product_variant` (present; varchar lengths 255 as migrated).
- Primary key presence on Bolesa tables (TypeORM did **not** ask to rename `PK_bolesa_*` even though hashed PK names would differ).
- No missing/extra business columns in the sync log.

### 3.7 Contributing process issue

`1763590000000-bolesa-phase1.ts` was authored manually (not via `vendure migrate -g`), used `IF NOT EXISTS` / `.catch(() => undefined)` on FKs, and chose readable names. That is the systemic root cause of buckets A–C. Bucket D is entity/migration divergence on `trackingNumber` uniqueness.

---

## 4. Recommended minimal correction (await approval — not applied)

**Goal:** Clear `schema-out-of-sync` without weakening uniqueness.

### Option 1 — Prefer: entity naming alignment (minimal DB churn)

1. Give indexes explicit names matching the **current DB** (or matching TypeORM hashes if you prefer one rename migration):
   - `@Index('IDX_bolesa_connection_isActive')` on `isActive`
   - `@Index('IDX_9244c…')` or keep readable names consistently
2. On `@JoinTable`, set `joinColumn` / `inverseJoinColumn` `foreignKeyConstraintName` to the existing `FK_bolesa_*` names (TypeORM supports `foreignKeyConstraintName`).
3. For unique fields, either:
   - keep `@Index({ unique: true, name: '…' })` with names TypeORM will accept, or
   - accept one small migration that only renames/rebuilds uniques to hashed `IDX_*`.
4. For `trackingNumber`, restore an explicit partial unique in metadata **if** TypeORM/Vendure version can express it; otherwise **document intentional drift** and do **not** drop the partial unique.

Re-run `npx vendure migrate --run` diagnostics until empty.

### Option 2 — Single corrective migration (DB follows TypeORM)

Generate **one** migration (after approval) that applies the 26 statements (or equivalent `ALTER … RENAME` where possible).  
**Caution:** Prefer `RENAME` / recreate carefully under a transaction; do not use `synchronize: true`.  
**Do not** drop the partial unique without replacing equivalent protection.

### Option 3 — Do nothing for Phase 1 verify

Leave drift; proceed with runtime tests. Clear drift before packaging / CI that treats schema-out-of-sync as failure.

---

## 5. Is a new migration necessary?

| Goal | Necessary? |
|------|------------|
| Phase 1 runtime verification | **No** |
| Silence TypeORM/Vendure drift warning | **Yes** (migration **or** entity name alignment) |
| Production / shared environments | **Yes** before relying on `migrate --run` cleanliness in CI |

If choosing a migration, it should be a **new** forward migration, not editing `BolesaPhase11763590000000` (already recorded as applied).

---

## 6. Is the current database safe for Phase 1 runtime verification?

**Yes.**

Evidence:

- Doctor connects successfully (on host).
- Bolesa tables + join tables + FKs exist.
- Uniqueness on shipment identity columns is present (constraints).
- Phase 1 custom fields exist.
- Drift statements do not add missing columns or drop business data structures; they rename/recreate indexes/FKs.

Caveats:

- Drift warning will keep appearing on `migrate --run`.
- Live DB’s partial unique on `trackingNumber` is **stricter** than current entity metadata (good for safety).
- Logs previously showed a noisy re-apply attempt (`bolesa_connection` type already exists) — consistent with `IF NOT EXISTS` / partial re-runs; current applied migration list is coherent.

---

## 7. GO / NO-GO

| Decision | Verdict |
|----------|---------|
| **Phase 1 operational / runtime verification on this DB** | **GO** |
| **Declare schema migration story “clean” / merge without follow-up** | **NO-GO** until Option 1 or 2 is approved and applied |
| **Enable `synchronize: true` or regenerate DB** | **NO-GO** |
| **Blindly apply raw TypeORM DROP of partial unique without replacement** | **NO-GO** |

**Overall:** **GO for Phase 1 runtime verification; NO-GO for closing the migration/drift workstream.**

---

## Appendix — Evidence commands (read-only)

```bash
# Live catalog
psql -h /tmp -p 6543 -d vendure-dev -c "\d+ bolesa_connection"
psql -h /tmp -p 6543 -d vendure-dev -c "\d+ bolesa_shipment"

# Full drift list (0 migrations applied; diagnostic only)
# DB_HOST=/tmp used when agent TCP to 127.0.0.1 is blocked
DB_HOST=/tmp DB_USERNAME=maher node /tmp/vendure-drift-probe.cjs
```

Probe used `runMigrations(..., { onDiagnostic })` after `build:server`; returned `RAN_MIGRATIONS=[]` and `CODE=schema-out-of-sync` with 26 change lines.
