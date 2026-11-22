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

Payment preference is the order field `paymentPreference`: empty or `prepaid` means CC; `cod` means COD. The calculator runs at `eligibleShippingMethods`, which is **before** payment in the current checkout. Changing the preference later requires another eligibility call so the quote is rebuilt. The cache key includes the preference.

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

`allow_open` is not sent. Partner treats that as false. Turning it on for Bosta requires public product image URLs (`allow_open_images_required`). That is not enabled.

## AWB lifecycle — decision

**Automatic means: after a Bolesa fulfillment row is committed, the plugin writes an outbox row and enqueues `bolesa-create-awb`. The worker calls Partner outside the database transaction. The merchant does not click a second "send" for the happy path. Admin retry remains for `failed` and `retry_exhausted`.**

The connection column `creationMode` (`manual` | `onPaymentSettled` | `onPlaced`, default `manual`) is stored and exposed on the Admin API. **No code reads it to create an AWB.** It is not a working switch.

AWBs are not created when the order is placed. `OrderPlaced` only stores `customFields.bolesaQuote`. `quotePersisted=false` in the calculator log is expected: the calculator does not write the quote. A missing quote does not block the AWB. Create uses the order's `bolesaServiceSlug`, then the shipping-method slug, then `auto`. Partner prices the AWB again from the create body. Vendure does not send a quote hash.

Partner HTTP runs after the fulfillment transaction, in `BolesaShipmentService.createAwbForFulfillment`. Idempotency-Key is `bolesa-f{fulfillmentId}-c{channelId}-a{attempt}`. A second event for the same fulfillment does not insert another outbox row. A cancelled fulfillment is blocked until Partner confirms cancel.

Creating an AWB at order placement was rejected: the customer can abandon payment, the order can still be edited, and COD is not a collected payment yet. Stock and the merchant's decision to ship are represented by the fulfillment.

## Known limits that need a business decision

1. Channel currency must be set to EGP (this Egypt Partner) or SAR (a Saudi Partner). No FX rate will be invented.
2. `creationMode` is not implemented. Say if `onPaymentSettled` should create the fulfillment itself.
3. `allow_open` stays off until product image URLs are part of the order.
4. Checkout still quotes prepaid unless `paymentPreference` is already `cod`. Selecting COD after the shipping step must recalculate rates.
5. Catalog prices entered as dollars stay dollars if the channel currency is changed to EGP or SAR. That is a catalog decision, not a shipping conversion.

## Tests

Unit coverage added in `shipping-quote.spec.ts`, `rate-and-cod.spec.ts`, and `bolesa-client.spec.ts`: matching currency, SAR against an EGP channel, missing currency, zero price, null price, minor-unit rounding (existing `money.spec.ts`), and cache-key currency. A Partner HTTP error still returns `undefined` for this method only.

Remote sandbox was not run. See `SANDBOX_E2E_EXECUTION_REPORT.md`.
