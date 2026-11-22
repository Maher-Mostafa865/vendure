# Phase 0 spike notes: ApiKey after createChannel

## Source-verified behavior (Vendure 3.8.2)

1. `ApiKeyService.create` assigns the key to the **current RequestContext channel** only:

```ts
// packages/core/src/service/services/api-key.service.ts ~210
await this.channelService.assignToCurrentChannel(e, ctx);
```

2. Lookup is channel-scoped:

```ts
// packages/core/src/service/services/api-key.service.ts ~451-457
where: {
  lookupId,
  deletedAt: IsNull(),
  channels: { id: ctx.channelId },
}
```

3. Auth resolves the channel from the `vendure-token` header first, then looks up the API key in that channel.

## Predicted outcomes (to confirm with runtime spike when server is available)

| Scenario | Expected |
|----------|----------|
| Create ApiKey while `vendure-token` = default channel; call Admin API with same default token + `vendure-api-key` | Success |
| Create ApiKey on default channel; call Admin API with **new** channel token + same `vendure-api-key` | **Fail auth** (key not linked to new channel) |
| After createChannel, switch context to new channel token and createApiKey there | Success for that channel only |

## Implication for provisioning (plan Revision 2)

`provisionBolesaStore` must be a **single Vendure mutation** invoked with a SuperAdmin ApiKey on the **default channel**. It must not rely on the control-plane ApiKey working against the newly created channel's token.

## Runtime status

**Not executed in this Phase 0 session:** bolesa-shop server is not running (ports 3000/3001 closed) and no sandbox Admin session was available. Source evidence above is sufficient for the architecture decision; a live GraphQL smoke test remains recommended before Phase 1 merge of the provisioning plugin.
