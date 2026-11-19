# Bolesa — External Alerting Integration Guide

**Status:** Documentation only — **no** in-repo Prometheus / Datadog / PagerDuty client is shipped or tested.  
**Do not** assume alerts fire until your log shipper / poller is configured and verified in your environment.

---

## 1. Exact metric / log formats

Worker / Server logs use a stable prefix from `formatOpsMetricLine`:

```
BolesaMetric <name> <key>=<value> <key>=<value> ...
```

Values are scalars only (no tokens, addresses, or customer PII).

### Emitted today

| Name | When | Example fields |
|------|------|----------------|
| `ops_health` | Admin `bolesaOpsHealth` query | `channelId`, `stuckRequested`, `stuckCancelRequested`, `failed`, `retryExhausted`, `cancelRetryExhausted`, `createActive`, `cancelActive` |
| `reconcile` | Successful scheduled reconcile | `durationMs`, `checked`, `recovered`, `cancelRecovered`, `markedExhausted`, `cancelMarkedExhausted`, `batches` |
| `reconcile_failed` | Reconcile throws | `errorClass`, `message` (truncated ≤200 chars) |

Example lines:

```
BolesaMetric ops_health channelId=4 stuckRequested=2 stuckCancelRequested=0 failed=1 retryExhausted=3 cancelRetryExhausted=0 createActive=5 cancelActive=1
BolesaMetric reconcile durationMs=842 checked=12 recovered=1 cancelRecovered=0 markedExhausted=0 cancelMarkedExhausted=0 batches=1
BolesaMetric reconcile_failed errorClass=Error message=connect ECONNREFUSED 127.0.0.1:9
```

### GraphQL poll alternative

Poll Admin API with a service account (channel-scoped):

```graphql
query { bolesaOpsHealth { lastConnectionTestAt channels { channelId stuckRequested stuckCancelRequested failed retryExhausted cancelRetryExhausted } queues { queueName active failedUnsettledLike } } }
```

---

## 2. Recommended alert conditions

Tune thresholds per environment. Start conservative.

| Condition | Suggested rule | Severity |
|-----------|----------------|----------|
| Create retries exhausted | `retryExhausted > 0` for **15m** (or any increase vs baseline) | Warning → High if growing |
| Cancel retries exhausted | `cancelRetryExhausted > 0` for **15m** | Warning |
| Failed shipments | `failed` increases by **≥5** in 1h **or** `failed > 20` | Warning |
| Stuck create | `stuckRequested ≥ 3` for **30m** | High |
| Stuck cancel | `stuckCancelRequested ≥ 3` for **30m** | High |
| Queue backlog | `createActive ≥ 50` **or** `cancelActive ≥ 50` for **15m** (channel-scoped) | High |
| Failed jobs | `failedUnsettledLike ≥ 20` on either queue for **15m** | Warning |
| Reconcile failures | `reconcile_failed` **≥2** occurrences in **45m** | High |
| Reconcile missing | No `BolesaMetric reconcile` for **45m** while Worker should be up | High |
| Connection test only | `lastConnectionTestAt` older than **24h** | Info (not Partner outage by itself) |

---

## 3. Integration instructions (untested templates)

Pick **one** approach. None of these are pre-wired in this repo.

### A) Log-based (recommended first)

1. Ship Worker stdout/stderr to your log platform (CloudWatch, Datadog, Loki, Elastic, etc.).
2. Filter: `BolesaMetric`.
3. Parse `key=value` pairs after the metric name.
4. Create monitors from §2.

**Example env (illustrative — names depend on your agent):**

| Variable | Purpose |
|----------|---------|
| `LOG_CHANNEL` / platform shipper config | Ensure Worker logs reach the aggregator |
| `DD_API_KEY` / `DATADOG_API_KEY` | Only if using Datadog agent (configure outside app) |
| `AWS_REGION` + CloudWatch agent | Only if using AWS |

The Vendure app itself does **not** read these for Bolesa metrics.

### B) GraphQL poller / cron

1. Cron every 5–15 minutes calls `bolesaOpsHealth` with Admin bearer token for each critical channel.
2. Evaluate JSON against §2 thresholds.
3. Page via your notifier (PagerDuty Events API, Slack webhook, etc.).

**Example env for a *separate* poller script (not in this repo):**

| Variable | Purpose |
|----------|---------|
| `VENDURE_ADMIN_API_URL` | e.g. `https://shop.example/admin-api` |
| `VENDURE_ADMIN_TOKEN` | Admin API token with shipment read |
| `BOLESA_ALERT_CHANNEL_IDS` | Comma-separated channel ids to poll |
| `PAGERDUTY_ROUTING_KEY` / `SLACK_WEBHOOK_URL` | Notifier sink |

### C) Prometheus (future)

Not implemented. A future exporter would need:

- Authenticated scrape endpoint or log→metrics bridge
- Labels: `channel_id`, `queue_name`
- Load test before relying on it in production

---

## 4. What is intentionally not claimed

- No verified PagerDuty/Datadog/Prometheus integration in CI or staging from this phase.
- `lastConnectionTestAt` is **not** an alert for Partner create/cancel health.
- Multi-instance city-search rate limits are not aggregated — do not alert solely on “rate limit log volume” across replicas without edge limits.
