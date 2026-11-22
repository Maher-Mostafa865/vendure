# Phase 1 Operational Verification Report

**Date:** 2026-11-19  
**Scope:** Prove Phase 1 MVP works operationally (not mocked-only).  
**Decision:** **NO-GO for Phase 2** (infrastructure + sandbox blockers). Static/schema verification **PASS** where runnable.

No production credentials used. No real AWBs created. No sandbox results invented.

---

## 1. Exact commands executed

```bash
# Environment / infra
cd /home/maher/projects/0-Project-Storage-Station/vendure
git status --short
git branch -vv
command -v docker; ls /var/run/docker.sock
ss -ltn | grep -E '5432|6543' || true
pg_isready -h 127.0.0.1 -p 6543
pg_isready -h 127.0.0.1 -p 5432
PGPASSWORD=password psql -h 127.0.0.1 -p 6543 -U vendure -d vendure-dev -c 'SELECT 1'
printenv | grep -E 'BOLESA|PARTNER|SANDBOX'   # none with Partner token

# Config / plugin registration (no DB required for doctor/schema)
cd bolesa-shop/apps/server
npx vendure doctor
npx vendure migrate --run
timeout 20 npm run start:server
npx vendure schema --api admin --dir ../../phase1-ops/schema --file-name admin-schema.graphql --format sdl
npx vendure schema --api shop  --dir ../../phase1-ops/schema --file-name shop-schema.graphql  --format sdl
rg -n "Bolesa|bolesa|labelUrl|tokenEncrypted|bolesaQuote" ../../phase1-ops/schema/*.graphql

# Unit regression
npm run test:bolesa
```

---

## 2. Migration and startup results

| Step | Result | Evidence |
|------|--------|----------|
| Docker | **Unavailable** | `docker` not installed; no `/var/run/docker.sock`; `apt` candidate exists but **no sudo** (`no new privileges`) |
| Postgres `127.0.0.1:6543` | **Down** | `pg_isready` → no response; `psql` → Connection refused |
| `npx vendure doctor` | **PASS with 1 warning** | Config validated; **8 plugins loaded**; Admin+Shop schemas validated; DB warn `ECONNREFUSED 127.0.0.1:6543` |
| `npx vendure migrate --run` | **FAIL** | `connect ECONNREFUSED 127.0.0.1:6543` |
| `npm run start:server` | **FAIL** | Same ECONNREFUSED (migrations in `index.ts` cannot run) |
| Schema dump Admin/Shop | **PASS** | Written to `bolesa-shop/phase1-ops/schema/` |
| Unit tests | **PASS 22/22** | Mocked Bolesa only |

### Safest migration path (when Postgres is available)

Do **not** use `synchronize: true`. Do **not** drop the DB.

```bash
cd bolesa-shop/apps/server
# 1) Start only the compose Postgres (non-destructive volume reuse)
docker compose up -d postgres_db
# 2) Wait until healthy
pg_isready -h 127.0.0.1 -p 6543 -U vendure
# 3) Run pending migrations only
npx vendure migrate --run
# 4) Confirm tables without truncate/drop
PGPASSWORD=password psql -h 127.0.0.1 -p 6543 -U vendure -d vendure-dev \
  -c "\dt bolesa_*" -c "\d+ bolesa_shipment"
# 5) Start server + worker
npm run build:server
npm run start:server &   # or: npm run dev:server
# worker is required for AWB jobs:
npx vendure start worker   # or included in vendure dev all
```

`index.ts` already calls `runMigrations(config)` before bootstrap; `migrate --run` is preferred for explicit, inspectable apply.

---

## 3. Plugin registration verification (proved without live DB)

`vendure doctor` loaded config and completed plugin configuration (**8 plugins**), including `BolesaPlugin`.

Generated schemas prove GraphQL registration:

**Admin API** (`phase1-ops/schema/admin-schema.graphql`):

- Queries: `bolesaConnection`, `bolesaShipments`, `bolesaShipment`
- Mutations: `updateBolesaConnection`, `testBolesaConnection`, `bolesaRetryShipment`, `bolesaCancelShipment`, `bolesaAbandonShipment`
- Permissions: `ReadBolesaConnection`, `WriteBolesaConnection`, `ReadBolesaShipment`, `WriteBolesaShipment`
- Types: `BolesaConnection` exposes `tokenLast4` only — **no** `tokenEncrypted`
- `BolesaShipment` exposes `labelAvailability` — **no** `labelUrl`

**Shop API** (`phase1-ops/schema/shop-schema.graphql`):

- `bolesaSearchCities` + `BolesaCity`
- Public: `paymentPreference`, `bolesaCityHash`, `weightKg`
- **Absent:** `bolesaQuote`, `labelUrl`, `tokenLast4`, `tokenEncrypted`, `codRemittanceStatus`, fulfillment Bolesa custom fields

---

## 4. Connection / permissions / catalog / shipping / COD

| Item | Operational status |
|------|--------------------|
| Bolesa connection row | **NOT VERIFIED** — DB down; no Admin session |
| Permissions assignable | **Schema-verified** present; runtime role grant **NOT VERIFIED** |
| Shipping method (`bolesa-eligibility` / `bolesa-rate` / `bolesa-fulfillment`) | **NOT SEEDED** — no runtime Admin create |
| Payment method (`bolesa-cod`) | **Handler registered in config**; Admin PaymentMethod entity **NOT CREATED** |
| Product `weightKg` | Field on Shop/Admin schema; catalog values **NOT VERIFIED** |
| Shipper `resolution_hash` | Requires connection upsert; **NOT VERIFIED** |
| City resolution hash | Shop query registered; live Partner search **NOT VERIFIED** (no token + no server) |

---

## 5. Sandbox end-to-end

| Prerequisite | Status |
|--------------|--------|
| Approved sandbox `XP-Api-Token` in env | **MISSING** (`BOLESA_PARTNER_TOKEN` / similar unset) |
| Explicit approval to create real sandbox AWBs | **NOT GRANTED** in this request |
| Running Vendure + worker | **BLOCKED** (Postgres) |
| Live rates / COD / fulfill / AWB / reconcile / cancel / retry | **NOT RUN** |

No sandbox HTTP calls were made. No AWB IDs invented.

---

## 6. Invariants verified without live Partner API

### Duplicate AWB prevention (design + unit + Phase 0)

- Attempt-scoped `Idempotency-Key` (`{shipmentKey}-a{attempt}`) — code + unit tests.
- Pre-check `GET /awbs?meta[vendure_shipment_key]=…` before create and on retry — code.
- 422 → `failed` (no auto-retry); 409/5xx → retryable — client unit tests.
- Phase 0 idempotency spike evidence already on disk (`phase0/evidence/idempotency-semantics.result.json`).
- **Live duplicate-job race against Partner API:** **NOT RUN**.

### COD settlement vs remittance

- `bolesa-cod` returns `Authorized` at create; settle is a separate handler path — unit tests + code.
- On DELIVERED, job calls `OrderService.settlePayment` and sets `codCollectionStatus=collected`.
- `codRemittanceStatus` defaults to `unknown` and is **not** flipped by settle — remittance remains separate (Phase 1 has no statement remittance writer).
- Admin schema exposes both statuses; Shop schema does not expose remittance.

### Private labels never exposed to shoppers

- Shop schema dump: **no** `labelUrl` / `bolesaQuote` / fulfillment label fields.
- Admin `BolesaShipment`: `labelAvailability` only.
- Dashboard shows availability text; no download that fetches S3.
- Phase 0 S3 anonymous probe: **403** (`phase0/evidence/label-url-s3-probe.result.json`).

---

## 7. Bugs found and fixes made

| Finding | Severity | Action this session |
|---------|----------|---------------------|
| Cannot operationally boot (no Docker/Postgres) | Blocker | None (environment) — documented safe migrate path |
| No sandbox token | Blocker | None — did not invent or scrape production tokens |
| Shipping/COD methods not auto-seeded | Gap (known Phase 1) | No code change (verification-only stop) |
| Shop `Permission` enum lists Bolesa permission names | Cosmetic | Expected Vendure enum exposure; not a data leak |

**No plugin code fixes** were applied during this verification pass (stop after verification).

---

## 8. Remaining blockers

1. Install/start Docker **or** otherwise provide Postgres on `127.0.0.1:6543`.
2. Apply migration: `npx vendure migrate --run`.
3. Start server **and** worker; grant SuperAdmin Bolesa Read/Write permissions.
4. Seed ShippingMethod + `bolesa-cod` PaymentMethod; set variant weights; configure shipper hash.
5. Obtain **approved sandbox** Partner token; get explicit OK before creating AWBs.
6. Bolesa authenticated label endpoint still required before claiming label UX.
7. Webhook raw-body e2e still deferred (Phase 2 prerequisite).

---

## 9. Manual verification checklist (when infra + sandbox ready)

1. `docker compose up -d postgres_db` → `npx vendure migrate --run` → `npx vendure doctor` (DB pass).
2. `npm run dev:server` (server+worker+dashboard).
3. Admin login → assign `Read/WriteBolesaConnection` + `Read/WriteBolesaShipment`.
4. Settings → Bolesa Connection → save sandbox token → **Test connection**.
5. Create shipping method + COD payment method; set `weightKg` on a variant.
6. Shop: `bolesaSearchCities` → set address hash + `paymentPreference=cod` → eligible rates.
7. Place order → Admin fulfill with `bolesa-fulfillment` → shipment `requested`→`created` (job).
8. Force duplicate job / timeout → assert single TN via meta pre-check + idempotency.
9. Reconcile/poll → on DELIVERED: payment Settled, `codCollectionStatus=collected`, `codRemittanceStatus` still `unknown`.
10. Shop order query: assert no `labelUrl` / quote internals.
11. Cancel + retry paths from Admin order block.

---

## 10. GO / NO-GO for Phase 2

### **NO-GO**

Phase 2 (webhooks, real-time COD/status push, production label proxy assumptions) must **not** start until:

- Postgres is up and Phase 1 migration applied successfully.
- Vendure server + worker run and plugin Admin/Shop mutations work live.
- One **approved sandbox** end-to-end path completes: rates → place → fulfill → AWB → status poll → COD settle separation observed → cancel/retry exercised once.
- Webhook HMAC path re-verified on a real Vendure bootstrap (Phase 0 spike only so far).

### What *did* pass this session (non-blocking for coding, insufficient for Phase 2)

- Plugin registration + GraphQL schema isolation (Shop vs Admin).
- Doctor config/schema validation.
- Unit tests 22/22.
- Static confirmation of idempotency/COD remittance/label-safety design.

**Operational MVP: not proven.** **Phase 2: NO-GO.**
