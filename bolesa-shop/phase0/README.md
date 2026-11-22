# Phase 0 — Vendure + Bolesa integration spikes

Isolated verification workspace. **Not production code.** Do not put real tokens, secrets, or customer labels here.

## Layout

- `spikes/` — runnable experiments and source-analysis notes
- `evidence/` — JSON/text results from spikes
- `generated/` — endpoint inventory (placeholder until live OpenAPI is fetched)

## Run spikes

```bash
cd bolesa-shop
node phase0/spikes/encryption-strategy.spike.mjs
node phase0/spikes/raw-body-middleware.spike.mjs
node phase0/spikes/raw-body-beforelisten.spike.mjs
node phase0/spikes/idempotency-semantics.spike.mjs
```

## Report

See [PHASE0_VERIFICATION_REPORT.md](./PHASE0_VERIFICATION_REPORT.md).
