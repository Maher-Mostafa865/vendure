# Bolesa × Vendure — Shipping, Currency, Checkout & AWB Lifecycle

Date: 2026-11-22. Verified against the code in this workspace. Paths below are the repositories that exist on disk.

## Repository map

| Requested path | On disk |
| --- | --- |
| `…/0-Project-Storage-Station/vendure/bolesa-shop` | Absent |
| `…/0-Project-Storage-Station/bolesa-egy` | Absent |
| Vendure monorepo | `/home/maher/Projects/vendure` (git root). Shop app: `/home/maher/Projects/vendure/bolesa-shop` |
| Partner API | `/home/maher/Projects/bolesa-egy` (git root) |
| Create-AWB wizard UI | `/home/maher/Projects/Bolesa-Egypt-UI` |
| Carrier HTTP client used by Partner | `/home/maher/Projects/bolesa-egy/packages/Storageitsolutions/carrier_service` |

`bolesa-shop` is not its own git root. Its remote is the Vendure fork `Maher-Mostafa865/vendure`.

Phase reports in `bolesa-shop/`: `PHASE1_7_P0_REMEDIATION_REPORT.md` through `PHASE1_10_OPERATIONAL_GAPS_REPORT.md`, `SANDBOX_E2E_EXECUTION_REPORT.md`, `BOLESA_ALERTING.md`. There is no `BOLESA_OPERATIONS_RUNBOOK.md` in this tree.

## Currency contract

### What Partner returns

`cc_price`, `cod_price`, and `cod_collection_fee` are **2-decimal major units**. `PartnerServiceOptionResource::amount()` rounds to 2 decimals. They are not minor units.

The currency is the **deployment country currency**, not a per-service or per-account currency:

- `config/shipment/countries/EG.php` → `EGP`
- `config/shipment/countries/SA.php` → `SAR`

The explicit code on a quoted row is `price.currency` (also nested under `prices_by_address[].price.currency`). The top-level `cc_price` / `cod_price` fields do not repeat the code. Partner rejects a caller-supplied `currency` that is not the deployment currency (`currency_mismatch` in `partner-api.php`). There is no FX conversion in the Partner options or AWB create path.

A live Egypt quote inspected earlier in this project carried `"currency": "EGP"`. SAR applies when the Partner process is the Saudi deployment. This workspace's `bolesa-egy` country file is Egypt, so the local API's authoritative currency is **EGP** unless that config is changed.

`1140` in the calculator log is `majorToMinor(11.40)` = `round(11.40 * 100)`. It is the Partner major amount times 100. It is **not** evidence that the amount is USD, and it is not evidence that it is SAR. On the Egypt deployment it is 11.40 EGP expressed as 1140 minor units.

### What the shop was doing

Vendure shipping prices are minor units of the **order/channel currency**. The storefront formats with `order.currencyCode` (`delivery-step.tsx`, `order-summary.tsx`). The `$` sign is the channel currency (the dev channel was created as USD, Vendure's default). The old fallback `order.currencyCode || 'USD'` also forced a dollar sign when the code was missing. That fallback is removed.

The calculator used to stamp `ctx.channel.defaultCurrencyCode` onto the quote and multiply the Partner number by 100. A SAR or EGP 11.40 therefore became $11.40. No exchange-rate source exists in either repository. None was added.

### Rule now in force

`buildQuote` returns a price only when `price.currency` is present and equals the channel currency (case-insensitive). Otherwise the Bolesa method is omitted:

| Partner `price.currency` | Channel | Result |
| --- | --- | --- |
| Same code (EGP/EGP, SAR/SAR, USD/USD) | match | `round(major * 100)` minor units, `priceIncludesTax: true`, `taxRate: 0` |
| Different code (SAR vs USD, EGP vs USD) | mismatch | method omitted, log reason `currency_mismatch` |
| Missing | unknown | method omitted, log reason `currency_unknown` |
| Prices null | — | method omitted, log reason `missing_price`. A real `0` is free, not a failure |
| HTTP error | — | method omitted. Not turned into price 0 |

The rate cache key includes the channel currency so a currency change cannot reuse the previous quote.

To show Bolesa prices, set the Vendure channel currency to the Partner deployment currency (EGP here, SAR on a Saudi Partner). Product prices already stored as USD numbers are a separate catalog problem. They are not converted by this change.

## Shipping methods coexist

`bolesa-shipping` is one Vendure shipping method. Its calculator returns one price and `metadata.options` for every priced carrier. It does not replace Standard or Express.

Vendure runs each method's checker and calculator on its own (`packages/core/src/service/helpers/shipping-calculator/shipping-calculator.ts`). A Bolesa `undefined` result, inactive connection, missing city hash, non-EG country, Partner HTTP error, null price, or currency mismatch drops only `bolesa-shipping`. The storefront lists every method Shop API returns and does not filter by code.

The customer selection is `setOrderShippingMethod`. A Bolesa carrier choice is `setOrderCustomFields.bolesaServiceSlug` and is used only when that method is the one selected.

## CC and COD

Checkout rates still use `paymentPreference`, because `eligibleShippingMethods` runs before a payment exists. Empty or `prepaid` means CC; `cod` means COD. Changing it later requires another eligibility call. The cache key includes the preference.

Automatic fulfillment and the AWB do not use that field once a payment exists. The source of truth is the PaymentMethod handler stored for `Payment.method` in the current channel:

- Handler code `bolesa-cod` and state `Authorized` or `Settled` means COD.
- Any other successful payment means prepaid.
- Client metadata, including a forged `metadata.method`, is ignored. The `bolesa-cod` handler itself returns `Authorized` and does not settle. Settlement stays on the existing DELIVERED reconciliation path. Partner `codRemittanceStatus` stays separate.

| | Prepaid (`cc`) | COD (`cod`) |
| --- | --- | --- |
| Shipping price charged in Vendure | `cc_price`, else `cod_price` | `cod_price`, else `cc_price` |
| `cod_collection_fee` | not added | added only when connection `codFeeMode` is `passToCustomer` (default `absorb`) |
| Partner `payment_type` | `cc` | `cod` |
| Partner `cod_amount` | omitted | `order.totalWithTax` converted from channel minor units to major units |
| What `cod_amount` is | — | goods + discounts + shipping already on the order, not `cod_price` and not the collection fee |
| Vendure payment | the shop's online handler. Settled by that handler | `bolesa-cod` authorizes at checkout and settles when Partner reports delivered |
| Partner wallet / remittance | separate from the Vendure payment | `codCollectionStatus` / `codRemittanceStatus` on the shipment row. Not the Vendure payment |

`cod_price` is the shipping fee for a COD shipment. It is not the amount the carrier collects from the consignee.

COD collection fee and markup are applied in `BolesaRateService.buildQuote`. AWB `cod_amount` is the Vendure order total in major units. Those two numbers are intentionally different. Because a mismatched currency never becomes the shipping line, the order total and `cod_amount` stay in one currency.

`allow_open` is the channel setting `allowOpen` (default false). The same value is sent on `POST /services/options` and on AWB create. Omitting it would leave the open fee at 0, which would not match a merchant who turned the setting on. Bosta still rejects `allow_open` without public product image URLs (`allow_open_images_required`). The setting is not forced back to false; that rejection is stored on the shipment.

## Merchant settings

Stored on `bolesa_connection` for the channel, edited on the Bolesa Connection page, and saved through `updateBolesaConnection`:

- `allowOpen` — Partner `allow_open`. Default false.
- `autoCreateAwb` — when true, the plugin creates the Vendure fulfillment itself. Default false, so existing connections stay manual.
- `enabledServiceSlugs` — Partner slugs the customer may see. Empty means every priced, currency-matching service. A non-empty list is checked against `GET /pcl/v1/services` before save. Those catalogue prices are not checkout prices.
- `defaultServiceSlug` — required when automatic creation is on, and it must be in the enabled list. It is used only when the customer did not choose a service. An unavailable default is an error. Another carrier is not substituted.

The customer's choice stays on `order.customFields.bolesaServiceSlug`. One `bolesa-shipping` method still carries every offered carrier in `metadata.options`. Standard and Express are separate methods and stay listed when Bolesa cannot quote.

## AWB lifecycle — decision

**The Partner call stays after a Bolesa fulfillment is committed: outbox row, then `bolesa-create-awb`, then the worker. Nothing in the order transaction calls Partner.**

`autoCreateAwb` decides who creates that fulfillment:

- false: the merchant fulfills from the dashboard, as before. No AWB is created on order placement.
- true: after the order is allowed to ship, `maybeAutoFulfill` creates the fulfillment with handler `bolesa-fulfillment`. A `bolesa-cod` payment fulfills on `PaymentAuthorized` only. Every other successful payment fulfills on `PaymentSettled`. A COD order that later settles does not fulfill again. An existing Bolesa fulfillment blocks a second one. Orders that did not use the Bolesa calculator are left alone. If the selected or default slug is missing or not enabled, an order note is written and no fulfillment is created.

`creationMode` is still unused. `autoCreateAwb` is the switch.

`OrderPlaced` only stores `customFields.bolesaQuote`. Create uses the customer slug, then `defaultServiceSlug`, then a stored quote. A quote written from an `auto` method cannot replace the default. `auto` and `default` are not sent to Partner. A missing slug fails the outbox row instead of picking another service.

## Currency precision

Partner `cc_price` and `cod_price` are major units of `price.currency`. Vendure stores one integer scale for every currency: `entityOptions.moneyStrategy.precision`. `DefaultMoneyStrategy` is 2. The precision is not an ISO-4217 minor-unit table, so a currency code does not by itself select 0, 2, or 3 decimals.

Conversion is `round(major × 10^precision)` and the reverse for `cod_amount`. Precision 0, 2, and 3 are covered by unit tests. A missing Partner currency or a currency that is not the channel currency still omits the Bolesa method. No exchange rate is applied.

Partner HTTP runs after the fulfillment transaction, in `BolesaShipmentService.createAwbForFulfillment`. Idempotency-Key is `bolesa-f{fulfillmentId}-c{channelId}-a{attempt}`. A second event for the same fulfillment does not insert another outbox row. A cancelled fulfillment is blocked until Partner confirms cancel.

Creating an AWB at order placement was rejected: the customer can abandon payment, the order can still be edited, and COD is not a collected payment yet. Stock and the merchant's decision to ship are represented by the fulfillment.

## Known limits that need a business decision

1. Channel currency must be set to EGP (this Egypt Partner) or SAR (a Saudi Partner). No FX rate will be invented.
2. `creationMode` is still unused. Use `autoCreateAwb`.
3. `allowOpen` is sent, but Bosta still needs public image URLs before that carrier will accept an openable shipment.
4. Checkout still quotes prepaid unless `paymentPreference` is already `cod`. Selecting COD after the shipping step must recalculate rates.
5. Catalog prices entered as dollars stay dollars if the channel currency is changed to EGP or SAR. That is a catalog decision, not a shipping conversion.

## Tests

Unit coverage includes the handler-based COD decision (`payment-kind.spec.ts`, using `bolesaCodPaymentHandler` and `dummyPaymentHandler`), precision 0/2/3 (`money.spec.ts`), currency match, and the rule that a stored auto quote does not replace the default service. A Partner HTTP error still returns `undefined` for this method only, so Standard and Express stay available.

On 2026-11-22 the isolated database `vendure-bolesa-test` was created on PostgreSQL `127.0.0.1:5432` and migrated with `synchronize` off. Integration tests passed there with Partner HTTP banned. The local Partner E2E passed against `127.0.0.1:8000` (`test_mode=false`, so this is not official Sandbox): one prepaid Worker AWB cancelled, one COD payment left `Authorized` until reconcile saw `DELIVERED` and settled it once. `autoCreateAwb` stayed false and fulfillment was created manually. Official remote Sandbox is still blocked: `.env.remote-sandbox` does not exist. Production is not approved. Evidence is in `SANDBOX_E2E_EXECUTION_REPORT.md`.
