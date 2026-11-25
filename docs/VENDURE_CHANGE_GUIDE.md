# Vendure change guide (this checkout)

Local working guide for the git checkout at the repository root. It is **not** registered in `docs/src/manifest.ts`, and it is **not** part of the generated API reference under `docs/docs/reference/`.

Read this when you need to decide whether a change belongs in the shop, the storefront, or the Vendure framework source.

## Three trees, one checkout

| Tree | Path | What it is | What the running shop uses |
| --- | --- | --- | --- |
| Shop | `bolesa-shop/` | npm workspace (`apps/server`, `apps/storefront`). Not a Lerna package. | This is the application you run. |
| Framework source | `packages/*` | Lerna packages, version `3.8.2` in `lerna.json`. Package manager file: `pnpm-workspace.yaml` lists only `packages/*`. | **Not used by the shop automatically.** |
| Framework docs | `docs/` | Official `@vendure/docs` package. Guides live in `docs/docs/guides/`. Reference under `docs/docs/reference/` is generated. | Not the shop. |

`bolesa-shop/apps/server/package.json` depends on published packages:

- `@vendure/core` `3.8.2`
- `@vendure/dashboard` `3.8.2`
- `@vendure/email-plugin` `3.8.2`
- `@vendure/asset-server-plugin` `3.8.2`
- `@vendure/graphiql-plugin` `3.8.2`
- `@vendure/cli` `3.8.2` (dev)

The installed copy is a normal directory, not a symlink:

`bolesa-shop/node_modules/@vendure/core` version `3.8.2`, `main` is `dist/index.js`.

Editing `packages/core` does nothing to the shop until you build that package and point the shop at the build. The framework's own dev app is `packages/dev-server`. `AGENTS.md` at the repo root describes that app, not `bolesa-shop`.

## 1. How the pieces talk

```text
Browser (storefront :3001)
    |  GraphQL  POST /shop-api
    |  headers  vendure-token, vendure-auth-token
    v
Vendure server  bolesa-shop/apps/server   (default port 3000)
    |  reads/writes PostgreSQL
    |  enqueues rows in job_record
    v
Vendure worker  same config, src/index-worker.ts
    |  runs queues: search index, collection filters, email, Bolesa AWB
    v
Partner HTTP (Bolesa) and the search index (entity SearchIndexItem)

Dashboard UI is served by the same server at /dashboard.
It is built from @vendure/dashboard plus shop extensions in plugins.
```

Verified entry points:

| Process | Start | Code |
| --- | --- | --- |
| Server, worker, and dashboard together | From `bolesa-shop/apps/server`: `npm run dev` (`vendure dev all`) | CLI starts the `server`, `worker`, and `dashboard` targets (`packages/cli/src/commands/dev/dev.ts`) |
| Server only | From `bolesa-shop/`: `npm run dev:server` | `vendure dev server`. Does not start the worker. `apps/server/src/index.ts` calls `runMigrations` then `bootstrap` |
| Worker only | From `bolesa-shop/`: `npm run dev:worker` | `apps/server/src/index-worker.ts` calls `bootstrapWorker` then `startJobQueue` |
| Dashboard dev server only | From `bolesa-shop/apps/server`: `npm run dev:dashboard` | `vendure dev dashboard`. There is no matching script on the `bolesa-shop` root |
| Shop and storefront together | From `bolesa-shop/`: `npm run dev` | Runs the server workspace `dev` script (`vendure dev all`) and `next dev --port 3001` |
| Storefront only | From `bolesa-shop/`: `npm run dev:storefront` | `apps/storefront` script `next dev --port 3001` |

Shop configuration is `bolesa-shop/apps/server/src/vendure-config.ts`.

- Database: Postgres from `DB_*` env vars. `synchronize` is `false`. Migrations are `apps/server/src/migrations/*.ts`.
- Job buffer: `DefaultJobQueuePlugin.init({ useDatabaseForBuffer: true })`.
- Search: `DefaultSearchPlugin.init({ bufferUpdates: false, indexStockStatus: true })`.
- Scheduler: `DefaultSchedulerPlugin.init()`.
- Payments registered in config: `dummyPaymentHandler` only. Bolesa adds its own handler from the plugin.
- Plugins also registered there: `BolesaPlugin`, `StorefrontRevalidationPlugin`, `DashboardPlugin`, `EmailPlugin`, `AssetServerPlugin`, `GraphiqlPlugin`. `NestLensDevPlugin` only when `APP_ENV=dev`.

Storefront HTTP client: `bolesa-shop/apps/storefront/src/platform/vendure/api.ts`.

- Shop URL: `VENDURE_SHOP_API_URL` or `NEXT_PUBLIC_VENDURE_SHOP_API_URL`. The file throws if both are missing.
- Channel header: `vendure-token`. Default token string is `__default_channel__`.
- Auth header name: `vendure-auth-token`.

Access points documented in `bolesa-shop/README.md`:

- Dashboard `http://localhost:3000/dashboard`
- Shop API `http://localhost:3000/shop-api`
- Admin API `http://localhost:3000/admin-api`
- Storefront `http://localhost:3001`

## 2. Where a change belongs

Use this order. Stop at the first match.

1. **Storefront only** if the data is already in the Shop API and you only need different markup, copy, or URL state. Edit `bolesa-shop/apps/storefront`.
2. **Shop plugin** if you need a new field, a new API field, a new shipping or payment handler, a job, or a dashboard block, and Vendure already has the extension point. Edit `bolesa-shop/apps/server/src/plugins` and register it from `vendure-config.ts`.
3. **Shop config** if you only need to turn an existing Vendure plugin on or change its options. Edit `vendure-config.ts`.
4. **Framework source** only if the behavior is inside `@vendure/core` or another `packages/*` package and no plugin hook can do it. Then follow [section 6](#6-change-vendure-core-safely). A core edit does not reach the shop by itself.

Do not "fix" a shop bug by editing `packages/core` and restarting `npm run dev` in `bolesa-shop`. That process loads `node_modules/@vendure/core`.

`packages/dev-server` is for developing the framework. Restarting it does not restart the shop.

## 3. Modules

Each module lists the shop files first, then the framework files the shop is actually running (the same paths exist in this repo under `packages/`, and the published `dist` is what Node loads).

### Products and ProductVariants

**Responsible for** the catalog: a product, its variants, price, stock, assets, and custom fields such as weight.

**Shop**

- Custom fields added by Bolesa: `bolesa-shop/apps/server/src/plugins/bolesa/config/custom-fields.ts`
  - Variant: `weightKg` (required, default `1`), `lengthCm`, `widthCm`, `heightCm`, `bolesaCategory`
- Weight migration: `apps/server/src/migrations/1795100000000-bolesa-variant-weight.ts`
- Storefront product page: `apps/storefront/src/features/products/routes/page.tsx`
- GraphQL: `apps/storefront/src/features/products/graphql.ts`
- Card: `apps/storefront/src/features/products/components/product-card.tsx`
- Add to cart: `apps/storefront/src/features/products/add-to-cart.ts`
- Variant option UI: `apps/storefront/src/features/products/variant-options.ts`, `variant-choice.tsx`

**Framework (source in this repo)**

- `packages/core/src/service/services/product.service.ts`
- `packages/core/src/service/services/product-variant.service.ts`
- Admin API: `packages/core/src/api/resolvers/admin/product.resolver.ts`
- Shop API: `packages/core/src/api/resolvers/shop/shop-products.resolver.ts`
- Dashboard screens: `packages/dashboard/src/app/routes/_authenticated/_products/`

**Events.** `ProductEvent` and `ProductVariantEvent`. The shop listens in `apps/server/src/plugins/storefront-revalidation/storefront-revalidation.service.ts` and then waits for the search-index job before telling the storefront to drop its cache.

**Async.** A product save does not update the storefront index in the same request. Queue `update-search-index` does that. See [Search](#search-and-search-index).

**Typical change (add a variant field the shop needs)**

1. Add the field in a plugin `configuration` hook, the way `BolesaPlugin` pushes `getBolesaCustomFields()`.
2. Add a migration under `apps/server/src/migrations/`. Do not set `synchronize: true`.
3. If the storefront must show it, add it to the feature GraphQL document, then regenerate storefront types. `apps/storefront/docs/architecture.md` says `src/graphql-env.d.ts` is generated from the Shop API.
4. Restart the shop server so `runMigrations` applies the migration.

**Test**

- Shop unit tests, from `bolesa-shop/apps/server`: `npm run test:bolesa` (only `src/plugins/bolesa/tests/*.spec.ts`, not the `integration/` files).
- There is no general product unit suite in the shop. For a Bolesa weight change, `src/plugins/bolesa/tests/weight-field.spec.ts` is the existing test.
- Typecheck: `npm run typecheck` in `apps/server`.
- Storefront typecheck: `npm run check-types` in `apps/storefront`.
- Storefront `npm run test` runs `tests/**/*.test.mjs` only (architecture, i18n, upgrade). Colocated `*.spec.ts` files, such as `features/products/variant-options.spec.ts`, are not part of that script.

**Belongs in** the shop plugin, plus the storefront feature if the page must display the field. Core only if `ProductVariantService` itself is wrong.

### Collections and collection filters

**Responsible for** which variants appear in a collection such as Electronics. Membership is stored after a job runs. The storefront does not re-run the filter rules itself.

**Shop / storefront**

- Collection page: `apps/storefront/src/features/collections/routes/page.tsx`
- Search input helper: `apps/storefront/src/features/search/search-helpers.ts` (`collectionSlug` is passed through)
- Option-group sidebar built from `collection.productVariants`: `apps/storefront/src/features/collections/option-filters.ts`
- GraphQL: `apps/storefront/src/features/collections/graphql.ts`

**Framework**

- `packages/core/src/service/services/collection.service.ts` creates queue `apply-collection-filters`
- Filter implementations: `packages/core/src/config/catalog/default-collection-filters.ts`
  - `facet-value-filter` (`containsAny`: checked means at least one facet; unchecked means every selected facet)
  - variant name, variant id, and product id filters
- Admin API: `packages/core/src/api/resolvers/admin/collection.resolver.ts`

**Async.** Saving a collection filter enqueues `apply-collection-filters`. Until that job finishes, `collection.productVariants` and the search index can disagree. The storefront collection page then calls `search(collectionSlug)`.

**Typical change**

1. If the rule is "products with facet X", change it in the dashboard collection filters. No code.
2. If the storefront shows the wrong products but the dashboard contents are right, check the search index and `update-search-index`, not the React page.
3. If you need a new kind of rule (for example "weight greater than 2"), that filter type does not exist in `default-collection-filters.ts`. Add a `CollectionFilter` from a shop plugin via `catalogOptions.collectionFilters`, or change core if the built-in filter is wrong.
4. Confirm the worker is running. `npm run dev` from `bolesa-shop` starts `vendure dev all`, which includes the worker. `npm run dev:server` starts the server only, and collection-filter jobs stay pending until a worker is up.

**Test.** Shop API `collection(slug)` versus `search(input: { collectionSlug })`. Compare `productVariants.totalItems` with `search.totalItems` (search groups by product, so the counts differ). Core e2e, only if you changed `packages/core`: from `packages/core`, `npm run e2e`.

**Belongs in** the dashboard data for normal filter edits. Shop plugin for a new filter type. Core only to change the built-in filter code.

### Facets and product options

**Facets** are tags used for collection rules and the storefront facet sidebar (category, brand). **Options** are variant axes (RAM, screen size, HDD). They are different tables.

**Storefront**

- Facet sidebar: `apps/storefront/src/features/search/facet-filters.tsx`. It renders every `search.facetValues` group returned for the current search. It does not read the collection's filter definition.
- Option sidebar on a collection: `option-filters.ts` groups every option on `collection.productVariants` (take `100` in `GetCollectionVariantOptionsQuery`).
- Product page options: `apps/storefront/src/features/products/variant-options.ts` and `variant-choice.tsx`

**Framework**

- `packages/core/src/service/services/facet.service.ts`
- `packages/core/src/service/services/facet-value.service.ts`
- `packages/core/src/service/services/product-option.service.ts`
- `packages/core/src/service/services/product-option-group.service.ts`
- Admin API: `packages/core/src/api/resolvers/admin/facet.resolver.ts`, `product-option.resolver.ts`
- Dashboard facet assignment UI: `packages/dashboard/src/app/routes/_authenticated/_products/components/assign-facet-values-dialog.tsx`

**Typical change**

1. To hide a facet from the sidebar while keeping it on the product, change `facet-filters.tsx`. The API still returns every facet value present on the result set.
2. To stop a variant option group appearing, either remove it from those variants, or filter groups in `option-filters.ts`.
3. To change how facets are stored, that is core (`FacetService`). The shop has no facet plugin.

**Async.** Facet counts on the collection page come from the search index, not from a live join. After you attach a facet, wait for `update-search-index`.

**Belongs in** the storefront for display. Core for storage and the search facet response shape.

### Search and search index

**Responsible for** fast product lists. The storefront catalog grid calls Shop API `search`. It does not list the `product` table.

**Shop**

- Plugin options: `vendure-config.ts` `DefaultSearchPlugin.init({ bufferUpdates: false, indexStockStatus: true })`
- Revalidation waits on that queue: `storefront-revalidation.service.ts` counts `job_record` rows where `queueName = 'update-search-index'` and `state` is `PENDING`, `RUNNING`, or `RETRYING`.

**Framework**

- Queue name `update-search-index`: `packages/core/src/plugin/default-search-plugin/indexer/search-index.service.ts`
- Row type: `packages/core/src/plugin/default-search-plugin/entities/search-index-item.entity.ts` (`SearchIndexItem`)
- Full-text indexes on `productName`, `productVariantName`, and `description`
- The same row stores `price`, `sku`, `facetIds`, `facetValueIds`, `collectionIds`, `collectionSlugs`
- `bufferUpdates: false` in this shop means a catalog change enqueues an index job immediately. The plugin can buffer when that option is `true` (`search-job-buffer.service.ts`). This shop does not.

**Storefront query path**

1. `features/search/search-helpers.ts` `buildSearchInput` sets `take: 12`, `skip` from `page`, `groupByProduct: true`, optional `collectionSlug`, and `facetValueFilters` as `{ and: id }`.
2. `features/search/graphql.ts` `SearchProductsQuery` asks for items and `facetValues`.
3. Collection pages call that helper from `features/collections/routes/page.tsx`. If any option filter is selected, that page then sets `groupByProduct` to `false`, `take` to `100`, and `skip` to `0`.
4. Search page: `features/search/routes/page.tsx`, which renders `search-results.tsx`.

**Typical change**

1. Sort, page size, or which facet ids are sent: `search-helpers.ts`.
2. Which fields the card shows: `features/products/graphql.ts` and `features/products/components/product-card.tsx`.
3. A new indexed column (for example a custom field inside the index): `DefaultSearchPlugin` index config. **Needs verification** of the exact `indexOptions` map in the installed 3.8.2 `dist` if you rely on a field that is not on `SearchIndexItem` in this source tree. The entity fields listed above are in `packages/core` at the same version number. The entity decorator is `@Entity()` with no table name. Shop SQL in this repo names the job table `job_record`. It does not name the search table. Do not assume the physical search table name until you read it from the database.
4. After index-related core changes, rebuild search data from the dashboard reindex action, which enqueues `type: 'reindex'` on `update-search-index`.

**Test.** Shop API `search` against a known collection. Watch the worker log for `update-search-index`. Do not expect the storefront to change in the same second as a product save; revalidation waits for the job.

**Belongs in** the storefront for query shape. Shop config for plugin options. Core for index behavior.

### Channels

**Responsible for** a store: currency, language, default shipping zone, and which catalog is visible. The storefront selects a channel with the `vendure-token` header.

**Shop / storefront**

- Header default: `apps/storefront/src/platform/vendure/api.ts` (`__default_channel__` when `VENDURE_CHANNEL_TOKEN` is unset)
- Currency switch: `apps/storefront/src/features/currency/switch-currency.ts`
- Bolesa data is stored per channel on `BolesaConnection` (`apps/server/src/plugins/bolesa/entities/bolesa-connection.entity.ts`). Services take `RequestContext` and use `ctx.channel`.

**Framework**

- `packages/core/src/service/services/channel.service.ts`

**Typical change**

1. Prices in the wrong currency: channel default currency in the dashboard, not the shipping calculator. Bolesa refuses a Partner price whose currency is not the channel currency (`bolesa-rate.service.ts`).
2. A second store: create a channel in the dashboard, then pass its token as `VENDURE_CHANNEL_TOKEN`. Do not hard-code a second channel in the client unless the header helper is updated.
3. Isolating a plugin bug: write the lookup with `ctx.channelId`. Bolesa shipment keys include the channel id (`bolesa-f{fulfillmentId}-c{channelId}` is built in the shipment service).

**Test.** Same Shop API query with two `vendure-token` values. Integration tests that need a second channel live under `apps/server/src/plugins/bolesa/tests/integration/`.

**Belongs in** dashboard data for a new channel. Storefront env or `api.ts` for which token is sent. Core only if `ChannelService` is wrong.

### Dashboard extensions

**Responsible for** admin screens. The stock screens live in `@vendure/dashboard`. Shop-specific screens are a plugin extension.

**Shop**

- `bolesa-shop/apps/server/src/plugins/bolesa/dashboard/index.tsx`
- `defineDashboardExtension` registers:
  - route `/bolesa-connection` in the settings nav (`sectionId: 'settings'`, permission `ReadBolesaConnection`)
  - page block `bolesa-shipment-status` on `order-detail`, main column, after `fulfillment-details`
- Plugin points at that file: `dashboard: './dashboard/index.tsx'` in `bolesa.plugin.ts`
- Dashboard is served by `DashboardPlugin` in `vendure-config.ts` at route `dashboard`

**Framework**

- Package `packages/dashboard`
- Product screens under `packages/dashboard/src/app/routes/_authenticated/_products/`
- Extension API used by the shop: `defineDashboardExtension` imported from `@vendure/dashboard`

**Typical change**

1. New admin page for a shop plugin: add a route in that plugin's `defineDashboardExtension`. Keep the GraphQL in the plugin's `api/api-extensions.ts`, not in core.
2. Change a stock screen (product list columns for every Vendure project): `packages/dashboard`, then you must rebuild and consume that package. The running dashboard is the published `3.8.2` build until you do.
3. Build the shop dashboard: from `apps/server`, `npm run build:dashboard` (`vendure build dashboard`).

**Test.** Open `http://localhost:3000/dashboard`. Shop server build: `npm run build` in `apps/server`. Framework dashboard tests: `packages/dashboard` (see `packages/dashboard/AGENTS.md` and `packages/dashboard/e2e/README.md`). A dashboard source edit is not covered by `npm run test:bolesa`.

**Belongs in** the shop plugin for Bolesa UI. `packages/dashboard` for framework UI.

### Customers and accounts

**Responsible for** registration, login, profile, addresses, and the customer record on an order.

**Storefront**

- `apps/storefront/src/features/authentication/` (sign-in, register, verify, forgot and reset password)
- `apps/storefront/src/features/account/` (profile, addresses, orders)
- Routes are thin files under `apps/storefront/src/app/[locale]/` and delegate to those features (`apps/storefront/docs/architecture.md`)

**Framework**

- `packages/core/src/service/services/customer.service.ts`
- `packages/core/src/service/services/customer-group.service.ts`
- `packages/core/src/service/services/user.service.ts`
- `packages/core/src/service/services/auth.service.ts`
- Shop API: `packages/core/src/api/resolvers/shop/shop-customer.resolver.ts`
- Admin API: `packages/core/src/api/resolvers/admin/customer.resolver.ts`
- Sessions are cleaned by scheduled task `clean-sessions` (`packages/core/src/scheduler/tasks/clean-sessions-task.ts`), which enqueues the `clean-sessions` job.

**Shop config.** Email links in `vendure-config.ts` point at `http://localhost:3001/verify`, `/reset-password`, and `/account/verify-email`. Auth tokens are bearer and cookie. Cookie secret is `COOKIE_SECRET`.

**Typical change**

1. Form or copy: storefront feature folder. Do not import another feature's `routes/` or `components/` (enforced by the storefront's own architecture rules).
2. A new field on the customer: plugin custom field plus migration, then add it to `features/account/graphql.ts`.
3. Login itself failing for every user: `AuthService` / session config, which is core or `authOptions` in `vendure-config.ts`.

**Test.** Storefront typecheck: `npm run check-types`. `npm run test` covers the files under `apps/storefront/tests/` (architecture, i18n, upgrade), not the account or authentication screens. There is no shop integration test for generic customer signup. Email output in dev is files under `apps/server/static/email/test-emails`, and dev mode exposes `/mailbox` (`EmailPlugin` in `vendure-config.ts`).

**Belongs in** the storefront for UI. Shop plugin for custom fields. Core for auth or customer service bugs.

### Orders and fulfillment

**Responsible for** the active order, checkout, the placed order, and shipments.

**Shop**

- Fulfillment handler `bolesa-fulfillment` does **not** call the Partner: `apps/server/src/plugins/bolesa/config/bolesa-fulfillment-handler.ts`
- After commit, `BolesaShipmentService` listens to `FulfillmentEvent`, `OrderPlacedEvent`, and `OrderStateTransitionEvent` (`bolesa-shipment.service.ts`)
- Order custom fields: `paymentPreference`, `bolesaServiceSlug`, `bolesaQuote` in `custom-fields.ts`
- Fulfillment custom fields: `bolesaTrackingNumber`, `bolesaStatus`, `bolesaSyncStatus`, `bolesaLabelAvailability`, `bolesaShipmentKey`

**Storefront**

- Cart: `apps/storefront/src/features/cart/`
- Checkout: `apps/storefront/src/features/checkout/`
- Delivery step (carrier choice): `features/checkout/routes/steps/delivery-step.tsx`
- Order confirmation: `features/orders/routes/order-confirmation.tsx`
- Account order: `features/account/routes/orders/[code]/order-detail.tsx`

**Framework**

- `packages/core/src/service/services/order.service.ts`
- `packages/core/src/service/services/fulfillment.service.ts`
- Shop API: `packages/core/src/api/resolvers/shop/shop-order.resolver.ts`
- Admin API: `packages/core/src/api/resolvers/admin/order.resolver.ts`, `draft-order.resolver.ts`

**Async.** `onFulfillmentCreated` in `bolesa-shipment.service.ts` runs when a `FulfillmentEvent` has handler code `bolesa-fulfillment`. It writes a `BolesaShipment` row (key `bolesa-f{fulfillmentId}-c{channelId}`) and enqueues `bolesa-create-awb`. The fulfillment handler itself does not call the Partner.

`maybeAutoFulfill` is subscribed to `OrderStateTransitionEvent`, and its body is `return`. It does not create a fulfillment and it does not read `autoCreateAwb`. The flag is stored on `BolesaConnection` and `BolesaConnectionService.assertMerchantServices` rejects `autoCreateAwb: true` when `defaultServiceSlug` is empty. No other shop file reads the flag to create a fulfillment.

**Typical change**

1. Checkout step UI: `features/checkout`.
2. What gets stored on the order when the shopper picks a carrier: shop resolver `apps/server/src/plugins/bolesa/api/bolesa-shop.resolver.ts` and order custom fields.
3. When a fulfillment may be created: `OrderService` / fulfillment handler. Do not put Partner HTTP inside the fulfillment handler. The plugin comment says HTTP stays on the job.

**Test.** From `apps/server`:

- `npm run test:bolesa`
- Integration (needs `apps/server/.env.test` and database `vendure-bolesa-test`): `npm run test:bolesa:integration`
- Local Partner flow (needs `bolesa-shop/.env.sandbox` and `BOLESA_SANDBOX_E2E=1`, which the npm script sets): `npm run test:bolesa:sandbox-e2e`

**Belongs in** the shop plugin for Bolesa order fields and fulfillment behavior. Storefront for the checkout screens. Core for the order state machine.

### Payments

**Responsible for** taking money, or recording that cash will be collected on delivery.

**Shop**

- Dev card stand-in: `dummyPaymentHandler` (`code: 'dummy-payment-handler'`) registered in `vendure-config.ts`. Source: `packages/core/src/config/payment/dummy-payment-method-handler.ts`.
- COD: `bolesa-cod` handler in `apps/server/src/plugins/bolesa/config/bolesa-cod-payment-handler.ts`. It authorizes at checkout and settles when delivery is reconciled.
- Eligibility checker: `bolesa-cod-eligibility` in `bolesa-cod-eligibility-checker.ts`.
- Decision helper used by auto-fulfill: `apps/server/src/plugins/bolesa/util/payment-kind.ts`. A payment is COD only when the payment method's handler code is `bolesa-cod`. Client metadata is not the source of truth.
- Storefront payment step: `apps/storefront/src/features/checkout/routes/steps/payment-step.tsx`

**Framework**

- `packages/core/src/service/services/payment.service.ts` (writes the payment and sets `method` to the payment-method code)
- `packages/core/src/service/services/payment-method.service.ts`
- State machine: `packages/core/src/config/payment/default-payment-process.ts`
- Admin API: `packages/core/src/api/resolvers/admin/payment-method.resolver.ts`
- Shop API: `packages/core/src/api/resolvers/shop/shop-payment-methods.resolver.ts`

**Typical change**

1. A new provider (card gateway): a new `PaymentMethodHandler` in a shop plugin, registered on `paymentOptions.paymentMethodHandlers`. Do not replace `dummyPaymentHandler` until that provider exists. None is registered today besides dummy and Bolesa COD.
2. When COD may ship: `payment-kind.ts` and `maybeAutoFulfill` in `bolesa-shipment.service.ts`.
3. Do not settle COD inside the authorize step. Settlement is the reconcile path after Partner status `DELIVERED`.

**Test.** `apps/server/src/plugins/bolesa/tests/payment-kind.spec.ts` and `rate-and-cod.spec.ts` via `npm run test:bolesa`. Full COD order: `npm run test:bolesa:sandbox-e2e` (creates a local AWB).

**Belongs in** the shop plugin. Core if `PaymentService` overwrites the method or the state machine is wrong.

### Shipping and AWB integration

**Responsible for** checkout rates and the airway bill created after fulfillment.

**Shop plugin** `bolesa-shop/apps/server/src/plugins/bolesa/`

| Piece | File | Code / queue |
| --- | --- | --- |
| Plugin | `bolesa.plugin.ts` | registers handlers, custom fields, API, scheduled task |
| Calculator | `config/bolesa-shipping-calculator.ts` | `bolesa-rate` |
| Eligibility | `config/bolesa-eligibility-checker.ts` | `bolesa-eligibility` |
| Fulfillment | `config/bolesa-fulfillment-handler.ts` | `bolesa-fulfillment` |
| Partner HTTP | `services/bolesa-client.service.ts` | create and cancel use a 60 second timeout |
| Rates | `services/bolesa-rate.service.ts` | cache TTL from plugin options, default `600_000` ms |
| Connection | `services/bolesa-connection.service.ts` | token encrypted, never returned to the client |
| AWB orchestration | `services/bolesa-shipment.service.ts` | queues below |
| Admin API | `api/bolesa-admin.resolver.ts`, `api/api-extensions.ts` | |
| Shop API | `api/bolesa-shop.resolver.ts` | |
| Entities | `entities/bolesa-connection.entity.ts`, `entities/bolesa-shipment.entity.ts` | |
| Reconcile | `services/bolesa-reconcile.task.ts` | task id `bolesa-reconcile-shipments`, every 15 minutes |

Queues created in `BolesaShipmentService`:

- `bolesa-create-awb` (`CREATE_AWB_QUEUE`)
- `bolesa-cancel-awb` (`CANCEL_AWB_QUEUE`)

`APPLY_STATUS_QUEUE` (`bolesa-apply-status`) is declared in `constants.ts`. **No `createQueue` call for it was found.** Do not document it as a running queue.

**Storefront.** `delivery-step.tsx` lists shipping methods whose code is `bolesa-shipping` or starts with `bolesa-shipping-` (`bolesa-choices.ts` `isBolesaShippingCode`). Each row is one Vendure shipping method. The visible label is the translation `standardShipping`, not the Partner carrier name. `bolesaChoicesFromMetadata` reads `metadata.options`, and `selectBolesaService` in `features/checkout/routes/actions.ts` writes order custom field `bolesaServiceSlug`. Neither function is imported by `delivery-step.tsx`.

**Typical change**

1. Price rules, currency check, which services are offered: `bolesa-rate.service.ts`, `util/merchant-services.ts`, `util/service-offer.ts`.
2. AWB body (pieces, weight, COD amount): `util/awb-content.ts` and `bolesa-shipment.service.ts`.
3. Dashboard connection form: `dashboard/index.tsx` and `bolesa-admin.resolver.ts`.
4. Do not call the Partner inside a database transaction. The fulfillment handler comment and the shipment service keep HTTP on the worker.

**Test**

- Unit: `npm run test:bolesa` from `apps/server`
- DB and job queue, no Partner HTTP: `npm run test:bolesa:integration` (database name must be `vendure-bolesa-test`; see `tests/integration/assert-test-db.ts`)
- Local Partner: `npm run test:bolesa:sandbox-e2e`
- Remote official sandbox: `npm run test:bolesa:remote-sandbox-e2e` only with `bolesa-shop/.env.remote-sandbox`. The example file is `bolesa-shop/.env.remote-sandbox.example`.

**Belongs in** the shop plugin and the checkout feature. Core only if shipping eligibility or the fulfillment state machine is wrong (`packages/core/src/service/services/shipping-method.service.ts`).

### Background jobs and scheduled tasks

**Job queues** (rows in `job_record`, consumed by the worker):

| Queue | Defined in |
| --- | --- |
| `update-search-index` | `packages/core/src/plugin/default-search-plugin/indexer/search-index.service.ts` |
| `apply-collection-filters` | `packages/core/src/service/services/collection.service.ts` |
| `send-email` | `packages/email-plugin/src/plugin.ts` |
| `clean-sessions` | started by `packages/core/src/scheduler/tasks/clean-sessions-task.ts` |
| `bolesa-create-awb` | `bolesa-shipment.service.ts` |
| `bolesa-cancel-awb` | `bolesa-shipment.service.ts` |

**Scheduled tasks** (clock, not the queue name):

| Id | Schedule in source | File |
| --- | --- | --- |
| `clean-sessions` | every day at 00:00 | `packages/core/src/scheduler/tasks/clean-sessions-task.ts` |
| `clean-jobs` | every 2 hours | `packages/core/src/plugin/default-job-queue-plugin/clean-jobs-task.ts` |
| `clean-orphaned-settings-store` | every 7 days | `packages/core/src/config/settings-store/clean-orphaned-settings-store-task.ts` |
| `bolesa-reconcile-shipments` | every 15 minutes | `apps/server/src/plugins/bolesa/services/bolesa-reconcile.task.ts` |

`BolesaPlugin` also stores `reconcileSchedule: '*/15 * * * *'` in its options. The task that is registered uses `cron.every(15).minutes()` inside `bolesa-reconcile.task.ts`. **Needs verification** if anything reads `options.reconcileSchedule`. A search of the plugin found the field only on the options type and the `init()` default.

`clean-jobs` keeps the newest rows. `DEFAULT_KEEP_JOBS_COUNT` is `1000` in `packages/core/src/plugin/default-job-queue-plugin/constants.ts`.

**Typical change**

1. New background work: create the queue in the plugin service `onModuleInit` (shop `AGENTS.md` says `onModuleInit` or `onApplicationBootstrap`). Add the job from an event subscription after the transaction commits.
2. New clock work: a `ScheduledTask` added in the plugin `configuration` hook, same pattern as `bolesaReconcileTask`.
3. Confirm the worker process is up. The server process alone does not run the queues (`index-worker.ts` is what calls `startJobQueue`).

**Test.** `npm run test:bolesa:integration` boots a worker against `vendure-bolesa-test` and asserts on `job_record`. Do not point that file at `vendure-dev`.

**Belongs in** the shop plugin for Bolesa work. Core or `packages/email-plugin` for the built-in queues.

## 4. Investigate a bug before editing

Checklist:

1. Name the surface. Storefront page, Shop API, Admin API, dashboard, or worker log.
2. Decide which tree owns it with [section 2](#2-where-a-change-belongs).
3. Reproduce with one GraphQL operation against `http://localhost:3000/shop-api` or `/admin-api` before changing React. Send `vendure-token` if the channel matters.
4. If the screen is a product list or collection, compare:
   - `search` (index)
   - `collection.productVariants` (membership after `apply-collection-filters`)
   - the product in the dashboard (source of truth for catalog fields)
5. If the screen is shipping, read the worker log line `bolesa.shipping.calculate` from `bolesa-shipping-calculator.ts` before changing the storefront.
6. If a job might be stuck, query `job_record` for `queueName` and `state`. Do this on the shop database. Do not run integration tests against `vendure-dev`.
7. Search this repo for the symbol (`ProductService`, queue name, handler code) and open the file under `packages/` **and** the shop plugin. Remember Node is executing `bolesa-shop/node_modules/@vendure/core/dist`, which matches version `3.8.2` but is not the TypeScript file you have open until you rebuild and relink.
8. Write or extend a test that fails first. Shop Bolesa tests are `node --test` via `npm run test:bolesa`. Framework tests are Vitest (`npm test` inside the package).

## 5. Shop and storefront commands

Run these from the directory in the table. They were copied from `package.json` files.

| Goal | Directory | Command |
| --- | --- | --- |
| Shop server, worker, dashboard, and storefront | `bolesa-shop` | `npm run dev` |
| Server process only | `bolesa-shop` | `npm run dev:server` |
| Worker only | `bolesa-shop` | `npm run dev:worker` |
| Storefront only | `bolesa-shop` | `npm run dev:storefront` |
| Server typecheck | `bolesa-shop/apps/server` | `npm run typecheck` |
| Server production build | `bolesa-shop/apps/server` | `npm run build` |
| Bolesa unit tests | `bolesa-shop/apps/server` | `npm run test:bolesa` |
| Bolesa integration tests | `bolesa-shop/apps/server` | `npm run test:bolesa:integration` |
| Apply test-db migrations only | `bolesa-shop/apps/server` | `npm run test:bolesa:migrate` |
| Storefront typecheck | `bolesa-shop/apps/storefront` | `npm run check-types` |
| Storefront unit tests | `bolesa-shop/apps/storefront` | `npm run test` (`tests/**/*.test.mjs` only) |
| Storefront lint | `bolesa-shop/apps/storefront` | `npm run lint` |

`npm run test:bolesa` does not compile `packages/core`. `npm run build` in the shop runs `vendure build all` for the server app, not `lerna run build`.

## 6. Change Vendure core safely

Do this only after section 2 says the shop cannot express the change.

1. Edit the package under `packages/<name>/src`. For core plus `@vendure/common`, the repo script is `bun run watch:core-common` (root `package.json`). `packages/core` build script is `npm run build` in that package (`rimraf dist && tsc ...`).
2. The framework dev server that sees those TypeScript builds is `packages/dev-server`, not the shop. Root `AGENTS.md`: update `packages/dev-server/dev-config.ts` if the dev server must load the change, then restart it.
3. Test the package, not the shop, first:
   - Unit: `npm test` in `packages/core` (Vitest).
   - E2E: `npm run e2e` in `packages/core`.
   - Dashboard e2e notes are in `packages/dashboard/AGENTS.md`.
4. Make the shop load the new `dist`. See the next section. Restart `bolesa-shop` afterwards. `vendure dev` does not watch `packages/core/src`.
5. Do not point shop integration tests at `vendure-dev`. Their guard is `apps/server/src/plugins/bolesa/tests/integration/assert-test-db.ts` (`vendure-bolesa-test` only).

Core e2e databases are SQLite files under `packages/<name>/e2e/__data__/`. Root `AGENTS.md` says to delete `e2e/__data__/*.sqlite` after a schema change, and not to delete the `__data__` directory.

## 7. How the shop can consume a core fix

| Approach | What exists in this repo | Limitation verified here |
| --- | --- | --- |
| Published version | `apps/server/package.json` pins `3.8.2`. Installed copy is `bolesa-shop/node_modules/@vendure/core`. | A commit under `packages/core` is not that install. You would publish a new version and bump the pin. No shop script publishes to npm. |
| Patch | No `patch-package`, `pnpm.patchedDependencies`, or patch directory in `bolesa-shop`. | Not set up. Editing files inside `node_modules/@vendure/core` is overwritten by a later install. A patch tool would be a new choice, not a current workflow. |
| Local link | Root `pnpm-workspace.yaml` does **not** include `bolesa-shop`. `packages/core` `main` is `dist/index.js`. | `npm link` or a `file:` dependency only helps after `npm run build` in the package. You must link every package you changed (`core`, and `common` if core imports it, and `dashboard` if the UI changed). The shop TypeScript build will not compile `packages/core/src` for you. |
| Maintained fork | This checkout already contains both trees. `npm run publish-local` at the repo root runs `scripts/publish-to-verdaccio.sh`. | That script publishes to `http://localhost:4873/` unless `VERDACCIO_URL` is set. It does not install or start Verdaccio. **Needs verification** that a registry is running before you use it. `bolesa-shop` has no `.npmrc` pointing at that registry (`apps/storefront/.npmrc` only sets `min-release-age` and `ignore-scripts`). After a local publish you still change the shop dependency version and reinstall. |

`packages/dev-server` is the supported way to exercise a core change before any of the four. It is not a substitute for updating `bolesa-shop/node_modules`.

## 8. If I want to change X, start here

| I want to change | Start here | Then verify |
| --- | --- | --- |
| Product page layout | `apps/storefront/src/features/products/` | `npm run check-types` in `apps/storefront` |
| A field stored on a variant | `plugins/bolesa/config/custom-fields.ts` and a new migration | Server restart so migrations run; `npm run test:bolesa` if a Bolesa test covers it |
| Which products are in Electronics | Dashboard collection filters, then queue `apply-collection-filters` | `collection.productVariants.totalItems` |
| Facet checkboxes on a collection | `features/search/facet-filters.tsx` | Shop API `search.facetValues` for that slug |
| Option groups on a collection (RAM, HDD, …) | `features/collections/option-filters.ts` | `collection.productVariants` options |
| Search ranking, page size, sort | `features/search/search-helpers.ts` | `search` query |
| Why search is stale | Queue `update-search-index` and the worker | `job_record` for that queue |
| Channel currency or token | Dashboard channel, then `platform/vendure/api.ts` | Request header `vendure-token` |
| Bolesa admin page | `plugins/bolesa/dashboard/index.tsx` | `/dashboard/bolesa-connection` |
| Stock dashboard product screen | `packages/dashboard/src/app/routes/_authenticated/_products/` | Rebuild `@vendure/dashboard` and point the shop at it |
| Checkout steps | `apps/storefront/src/features/checkout/` | Storefront tests |
| Carrier price | `plugins/bolesa/services/bolesa-rate.service.ts` | `npm run test:bolesa` |
| AWB payload | `plugins/bolesa/util/awb-content.ts` and `bolesa-shipment.service.ts` | `npm run test:bolesa`, then sandbox e2e if Partner behavior matters |
| COD vs prepaid timing | `plugins/bolesa/util/payment-kind.ts` | `payment-kind.spec.ts` |
| A new card gateway | New `PaymentMethodHandler` in a shop plugin | Not present today; do not extend `dummy-payment-handler` for production |
| A core service bug | `packages/core/src/service/services/<name>.service.ts` | Package `npm test`, then section 7 before expecting the shop to change |
| Customer login UI | `apps/storefront/src/features/authentication/` | `npm run check-types` in the storefront. `npm run test` does not cover this screen |
| Order state machine | `packages/core/src/service/services/order.service.ts` | Core e2e, then section 7 |

## 9. Template for the next change

Copy this into the PR description or a note next to the change.

```markdown
## Change

- Goal:
- Tree: shop plugin | storefront | vendure package
- Why it is not in the other trees:

## Files

- 

## Runtime

- API: Shop | Admin | none
- Queue or scheduled task touched:
- Index or collection membership affected: yes | no
- Migration: path or none
- Config / env read:

## How to run

- Command:
- Working directory:
- Database (must not be vendure-dev for Bolesa integration):

## Result

- Before:
- After:
- Not verified:
```

## Needs verification

These were not confirmed from a running process while writing this file:

- That `options.reconcileSchedule` is read anywhere. The registered task uses `cron.every(15).minutes()` directly. The option is set in `BolesaPlugin.init` and declared on the options type.
- That a Verdaccio process is listening. The publish script assumes `http://localhost:4873/` unless `VERDACCIO_URL` is set. It does not start the registry.
- The physical PostgreSQL table name for `SearchIndexItem`. The class uses `@Entity()` with no name. Shop SQL that was read uses `job_record` for jobs and does not query the search table by name.
- The exact `indexOptions` available on the installed `dist` beyond the columns on `SearchIndexItem` in `packages/core`.
- Shop Admin login password. `bolesa-shop/README.md` says `superadmin` / `superadmin`. `vendure-config.ts` reads `SUPERADMIN_USERNAME` and `SUPERADMIN_PASSWORD` from the environment. The live values were not opened for this guide.
- Whether `clean-orphaned-settings-store` is present in the running shop process. The task is in the default scheduler task list in `packages/core/src/config/default-config.ts` (`tasks: [cleanSessionsTask, cleanOrphanedSettingsStoreTask]`). `DefaultSchedulerPlugin.init()` is called with no extra tasks in `vendure-config.ts`. The live task list was not queried from the Admin API.
