# Required Bolesa label endpoint (blocker for production labels)

## Phase 0 finding

Partner API `label_url` is an unsigned S3 URL from `Storage::disk('shipping_labels_s3')->url(...)`.
Anonymous probes against the configured CDN bucket returned **HTTP 403**.

Therefore Phase 1 **does not download or proxy labels**. The Admin UI shows:

- `labelAvailability: unavailable` — no URL stored
- `labelAvailability: url_present` — Partner returned a URL, but Vendure will not fetch it (may 403 / expose PII)

## Required Bolesa change before Phase 2 / production

Add an authenticated Partner API endpoint, for example:

```
GET /api/pcl/v1/awbs/{trackingNumber}/label
Authorization: XP-Api-Token
→ 200 application/pdf
```

Optional:

```
POST /api/pcl/v1/labels/combined
Body: { "tracking_numbers": ["..."] }  // max 100
→ 200 application/pdf
```

Prefer `Storage::temporaryUrl(..., now()->addMinutes(15))` for any browser-facing URL.

Until this exists, Vendure Admin should keep labels in the safe unavailable / url_present state only.
