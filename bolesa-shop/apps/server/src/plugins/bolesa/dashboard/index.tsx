import { Button, defineDashboardExtension } from '@vendure/dashboard';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/**
 * Phase 1 Dashboard hooks:
 * - Settings page for connection status / test
 * - Order detail block: shipment sync status, errors, retry / cancel
 *
 * Labels: Phase 0 verified label_url returns 403 anonymously. UI shows
 * labelAvailability only — no download button that pretends it works.
 */

const connectionQuery = `
  query BolesaConnection {
    bolesaConnection {
      id
      apiBaseUrl
      tokenLast4
      isActive
      webhookApproved
      lastVerifiedAt
      codEnabled
      codFeeMode
      labelNote
    }
  }
`;

const testMutation = `
  mutation TestBolesaConnection {
    testBolesaConnection { ok message }
  }
`;

const shipmentQuery = `
  query BolesaShipment($fulfillmentId: ID!) {
    bolesaShipment(fulfillmentId: $fulfillmentId) {
      id
      trackingNumber
      statusCode
      syncStatus
      labelAvailability
      lastError
      attempt
      codCollectionStatus
      codRemittanceStatus
    }
  }
`;

const retryMutation = `
  mutation BolesaRetry($fulfillmentId: ID!) {
    bolesaRetryShipment(fulfillmentId: $fulfillmentId) {
      id
      syncStatus
      attempt
      lastError
    }
  }
`;

const cancelMutation = `
  mutation BolesaCancel($fulfillmentId: ID!) {
    bolesaCancelShipment(fulfillmentId: $fulfillmentId) {
      id
      syncStatus
    }
  }
`;

function BolesaConnectionPage() {
    const qc = useQueryClient();
    const { data, isLoading } = useQuery({
        queryKey: ['bolesaConnection'],
        queryFn: async () => {
            const res = await fetch('/admin-api', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ query: connectionQuery }),
            });
            const json = await res.json();
            return json.data?.bolesaConnection;
        },
    });
    const test = useMutation({
        mutationFn: async () => {
            const res = await fetch('/admin-api', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ query: testMutation }),
            });
            return (await res.json()).data?.testBolesaConnection;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: ['bolesaConnection'] }),
    });

    if (isLoading) {
        return <div>Loading Bolesa connection…</div>;
    }
    if (!data) {
        return (
            <div className="p-4">
                <h2 className="text-lg font-medium">Bolesa Connection</h2>
                <p className="text-muted-foreground mt-2">
                    No connection configured for this channel. Use the Admin API mutation
                    updateBolesaConnection to set apiBaseUrl, token, and shipperAddress.
                </p>
            </div>
        );
    }
    return (
        <div className="p-4 space-y-3">
            <h2 className="text-lg font-medium">Bolesa Connection</h2>
            <dl className="grid grid-cols-2 gap-2 text-sm">
                <dt>API</dt>
                <dd>{data.apiBaseUrl}</dd>
                <dt>Token</dt>
                <dd>****{data.tokenLast4}</dd>
                <dt>Active</dt>
                <dd>{data.isActive ? 'yes' : 'no'}</dd>
                <dt>COD</dt>
                <dd>
                    {data.codEnabled ? `enabled (${data.codFeeMode})` : 'disabled'}
                </dd>
                <dt>Last verified</dt>
                <dd>{data.lastVerifiedAt ?? '—'}</dd>
            </dl>
            <p className="text-sm text-muted-foreground">{data.labelNote}</p>
            <Button type="button" onClick={() => test.mutate()} disabled={test.isPending}>
                Test connection
            </Button>
            {test.data && (
                <p className="text-sm">{test.data.ok ? 'OK' : 'Failed'}: {test.data.message}</p>
            )}
        </div>
    );
}

function BolesaShipmentBlock({ context }: { context: { entity?: any } }) {
    const fulfillments = context.entity?.fulfillments ?? [];
    const bolesa = fulfillments.filter((f: any) => f.handlerCode === 'bolesa-fulfillment');
    if (!bolesa.length) {
        return <div className="text-sm text-muted-foreground">No Bolesa fulfillments on this order.</div>;
    }
    return (
        <div className="space-y-4">
            {bolesa.map((f: any) => (
                <ShipmentCard key={f.id} fulfillmentId={f.id} trackingCode={f.trackingCode} />
            ))}
        </div>
    );
}

function ShipmentCard({
    fulfillmentId,
    trackingCode,
}: {
    fulfillmentId: string;
    trackingCode?: string;
}) {
    const qc = useQueryClient();
    const { data } = useQuery({
        queryKey: ['bolesaShipment', fulfillmentId],
        queryFn: async () => {
            const res = await fetch('/admin-api', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    query: shipmentQuery,
                    variables: { fulfillmentId },
                }),
            });
            return (await res.json()).data?.bolesaShipment;
        },
    });
    const retry = useMutation({
        mutationFn: async () => {
            const res = await fetch('/admin-api', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    query: retryMutation,
                    variables: { fulfillmentId },
                }),
            });
            return (await res.json()).data?.bolesaRetryShipment;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: ['bolesaShipment', fulfillmentId] }),
    });
    const cancel = useMutation({
        mutationFn: async () => {
            const res = await fetch('/admin-api', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    query: cancelMutation,
                    variables: { fulfillmentId },
                }),
            });
            return (await res.json()).data?.bolesaCancelShipment;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: ['bolesaShipment', fulfillmentId] }),
    });

    return (
        <div className="border border-border rounded-md p-3 text-sm space-y-2">
            <div>
                <strong>Fulfillment</strong> {fulfillmentId}
            </div>
            <div>Tracking: {data?.trackingNumber ?? trackingCode ?? '—'}</div>
            <div>Bolesa status: {data?.statusCode ?? '—'}</div>
            <div>Sync: {data?.syncStatus ?? '—'}</div>
            <div>
                Label: {data?.labelAvailability ?? 'unavailable'}
                {data?.labelAvailability === 'url_present' && (
                    <span className="text-muted-foreground">
                        {' '}
                        (URL present but download unavailable until Bolesa label endpoint)
                    </span>
                )}
            </div>
            <div>
                COD collection: {data?.codCollectionStatus ?? '—'} / remittance:{' '}
                {data?.codRemittanceStatus ?? '—'}
            </div>
            {data?.lastError && <div className="text-destructive">Error: {data.lastError}</div>}
            <div className="flex gap-2">
                {(data?.syncStatus === 'failed' ||
                    data?.syncStatus === 'retry_exhausted' ||
                    data?.syncStatus === 'requested') && (
                    <Button type="button" size="sm" onClick={() => retry.mutate()}>
                        Retry AWB (attempt {(data?.attempt ?? 0) + 1})
                    </Button>
                )}
                {data?.trackingNumber && data?.syncStatus === 'created' && (
                    <Button type="button" size="sm" variant="secondary" onClick={() => cancel.mutate()}>
                        Cancel Bolesa shipment
                    </Button>
                )}
            </div>
        </div>
    );
}

defineDashboardExtension({
    routes: [
        {
            path: '/bolesa-connection',
            loader: () => ({ breadcrumb: 'Bolesa Connection' }),
            component: () => <BolesaConnectionPage />,
            navMenuItem: {
                id: 'bolesa-connection',
                title: 'Bolesa Connection',
                sectionId: 'settings',
            },
            requiresPermission: 'ReadBolesaConnection',
        },
    ],
    pageBlocks: [
        {
            id: 'bolesa-shipment-status',
            title: 'Bolesa Shipping',
            location: {
                pageId: 'order-detail',
                column: 'side',
                position: { blockId: 'fulfillment', order: 'after' },
            },
            component: ({ context }) => <BolesaShipmentBlock context={context} />,
        },
    ],
});
