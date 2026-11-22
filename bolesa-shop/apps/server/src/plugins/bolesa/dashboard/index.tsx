import { api, Button, defineDashboardExtension } from '@vendure/dashboard';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

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
      allowOpen
      autoCreateAwb
      defaultServiceSlug
      enabledServiceSlugs
    }
  }
`;

const servicesQuery = `
  query BolesaAccountServices {
    bolesaAccountServices { slug name logoUrl }
  }
`;

const settingsMutation = `
  mutation UpdateBolesaSettings($input: UpdateBolesaConnectionInput!) {
    updateBolesaConnection(input: $input) {
      allowOpen
      autoCreateAwb
      defaultServiceSlug
      enabledServiceSlugs
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
      carrierServiceSlug
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

async function adminApi<T = any>(document: string, variables?: Record<string, unknown>): Promise<T> {
    // Use the dashboard client so the bearer session and channel token are sent.
    // A bare cookie fetch is anonymous when the dashboard session lives in localStorage.
    const vars = variables ?? {};
    if (/^\s*mutation\b/.test(document)) {
        return api.mutate(document, vars) as Promise<T>;
    }
    return api.query<T>(document, vars);
}

function BolesaConnectionPage() {
    const qc = useQueryClient();
    const { data, isLoading, error, refetch } = useQuery({
        queryKey: ['bolesaConnection'],
        queryFn: async () => {
            const d = await adminApi<{ bolesaConnection: any }>(connectionQuery);
            return d.bolesaConnection;
        },
    });
    const test = useMutation({
        mutationFn: async () => {
            const d = await adminApi<{ testBolesaConnection: any }>(testMutation);
            return d.testBolesaConnection;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: ['bolesaConnection'] }),
    });

    if (isLoading) {
        return <div>Loading Bolesa connection…</div>;
    }
    if (error) {
        return (
            <div className="p-4 space-y-2">
                <h2 className="text-lg font-medium">Bolesa Connection</h2>
                <p className="text-destructive text-sm">
                    Failed to load connection: {(error as Error).message}
                </p>
                <p className="text-muted-foreground text-sm">
                    Open this page at <code>/dashboard/bolesa-connection</code> (not{' '}
                    <code>/admin/extensions/…</code>), stay logged in, and ensure the Default
                    channel is selected.
                </p>
                <Button type="button" onClick={() => refetch()}>
                    Retry
                </Button>
            </div>
        );
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
            <MerchantSettings connection={data} />
            <p className="text-sm text-muted-foreground">
                Bolesa prices are charged only when Partner <code>price.currency</code> matches this
                channel currency. Egypt deployments use EGP. Saudi deployments use SAR. There is no
                exchange rate. A mismatch hides bolesa-shipping and leaves the other shipping methods
                in place. Prepaid is sent as <code>cc</code> with no COD collection. COD sends{' '}
                <code>cod_amount</code> as the order total. Automatic creation adds the fulfillment
                after payment is ready; the AWB is still sent by the background job.
            </p>
            <Button type="button" onClick={() => test.mutate()} disabled={test.isPending}>
                Test connection
            </Button>
            {test.data && (
                <p className="text-sm">{test.data.ok ? 'OK' : 'Failed'}: {test.data.message}</p>
            )}
        </div>
    );
}

function MerchantSettings({ connection }: { connection: any }) {
    const qc = useQueryClient();
    const services = useQuery({
        queryKey: ['bolesaAccountServices'],
        queryFn: async () => {
            const d = await adminApi<{ bolesaAccountServices: Array<{ slug: string; name: string }> }>(
                servicesQuery,
            );
            return d.bolesaAccountServices ?? [];
        },
    });
    const [allowOpen, setAllowOpen] = useState(connection.allowOpen === true);
    const [autoCreateAwb, setAutoCreateAwb] = useState(connection.autoCreateAwb === true);
    const [enabled, setEnabled] = useState<string[]>(connection.enabledServiceSlugs ?? []);
    const [defaultSlug, setDefaultSlug] = useState<string>(connection.defaultServiceSlug ?? '');
    useEffect(() => {
        setAllowOpen(connection.allowOpen === true);
        setAutoCreateAwb(connection.autoCreateAwb === true);
        setEnabled(connection.enabledServiceSlugs ?? []);
        setDefaultSlug(connection.defaultServiceSlug ?? '');
    }, [connection]);
    const save = useMutation({
        mutationFn: async () => {
            const d = await adminApi<{ updateBolesaConnection: any }>(settingsMutation, {
                input: {
                    allowOpen,
                    autoCreateAwb,
                    defaultServiceSlug: defaultSlug || null,
                    enabledServiceSlugs: enabled,
                },
            });
            return d.updateBolesaConnection;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: ['bolesaConnection'] }),
    });
    const catalog = services.data ?? [];
    const choices = enabled.length ? catalog.filter(row => enabled.includes(row.slug)) : catalog;
    const needsDefault = autoCreateAwb && !defaultSlug;
    function toggle(slug: string) {
        setEnabled(current => {
            const next = current.includes(slug) ? current.filter(item => item !== slug) : [...current, slug];
            if (defaultSlug && !next.includes(defaultSlug)) {
                setDefaultSlug('');
            }
            return next;
        });
    }
    return (
        <form
            className="space-y-3 border rounded-md p-3"
            onSubmit={event => {
                event.preventDefault();
                save.mutate();
            }}
        >
            <h3 className="text-sm font-medium">Shipment settings</h3>
            <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={allowOpen} onChange={event => setAllowOpen(event.target.checked)} />
                Allow the customer to open the shipment
            </label>
            {allowOpen && (
                <p className="text-sm text-destructive">
                    Bosta services (slug starts with bosta_) need at least one public product photo URL.
                    Without it, AWB creation stops with allow_open_images_required and no shipment is booked.
                    Other carriers that do not allow opening the parcel are rejected by Bolesa with allow_open_unavailable.
                </p>
            )}
            <label className="flex items-center gap-2 text-sm">
                <input
                    type="checkbox"
                    checked={autoCreateAwb}
                    onChange={event => setAutoCreateAwb(event.target.checked)}
                />
                Create the Bolesa fulfillment automatically after payment
            </label>
            <div className="space-y-1">
                <p className="text-sm">Services customers can choose</p>
                {services.isLoading && <p className="text-sm text-muted-foreground">Loading services…</p>}
                {services.error && (
                    <p className="text-sm text-destructive">{(services.error as Error).message}</p>
                )}
                {!services.isLoading && !catalog.length && (
                    <p className="text-sm text-muted-foreground">No services returned for this account.</p>
                )}
                <div className="space-y-1">
                    {catalog.map(row => (
                        <label key={row.slug} className="flex items-center gap-2 text-sm">
                            <input
                                type="checkbox"
                                checked={enabled.includes(row.slug)}
                                onChange={() => toggle(row.slug)}
                            />
                            {row.name} <span className="text-muted-foreground">{row.slug}</span>
                        </label>
                    ))}
                </div>
                <p className="text-xs text-muted-foreground">
                    Leave every box unchecked to offer all priced services. Checking any box limits checkout to those services.
                </p>
            </div>
            <label className="block text-sm space-y-1">
                <span>Default service</span>
                <select
                    className="border rounded px-2 py-1 w-full bg-background"
                    value={defaultSlug}
                    onChange={event => setDefaultSlug(event.target.value)}
                >
                    <option value="">None</option>
                    {choices.map(row => (
                        <option key={row.slug} value={row.slug}>
                            {row.name}
                        </option>
                    ))}
                </select>
            </label>
            {needsDefault && (
                <p className="text-sm text-destructive">
                    Automatic creation needs a default service. It is used when the customer does not pick one, and it is not replaced if it cannot be quoted.
                </p>
            )}
            <Button type="submit" disabled={save.isPending || needsDefault}>
                Save settings
            </Button>
            {save.error && <p className="text-sm text-destructive">{(save.error as Error).message}</p>}
            {save.isSuccess && <p className="text-sm">Saved.</p>}
        </form>
    );
}

const WIZARD_STEPS = [
    { id: 'service', title: 'Shipping service' },
    { id: 'locations', title: 'Addresses' },
    { id: 'carrier', title: 'Carrier' },
    { id: 'shipment', title: 'Shipment info' },
] as const;

function BolesaShipmentBlock({ context }: { context: { entity?: any } }) {
    const order = context.entity;
    const fulfillments = order?.fulfillments ?? [];
    const bolesa = fulfillments.filter(
        (f: any) =>
            f.handlerCode === 'bolesa-fulfillment' ||
            f.method === 'Bolesa' ||
            f.customFields?.bolesaSyncStatus != null,
    );
    if (!bolesa.length) {
        return <div className="text-sm text-muted-foreground">No Bolesa fulfillments on this order.</div>;
    }
    return (
        <div className="space-y-4">
            {bolesa.map((f: any) => (
                <ShipmentCard key={f.id} order={order} fulfillmentId={f.id} trackingCode={f.trackingCode} />
            ))}
        </div>
    );
}

function ShipmentCard({
    order,
    fulfillmentId,
    trackingCode,
}: {
    order: any;
    fulfillmentId: string;
    trackingCode?: string;
}) {
    const qc = useQueryClient();
    const { data } = useQuery({
        queryKey: ['bolesaShipment', fulfillmentId],
        queryFn: async () => {
            const data = await adminApi<{ bolesaShipment: any }>(shipmentQuery, { fulfillmentId });
            return data.bolesaShipment;
        },
    });
    const retry = useMutation({
        mutationFn: async () => {
            const data = await adminApi<{ bolesaRetryShipment: any }>(retryMutation, { fulfillmentId });
            return data.bolesaRetryShipment;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: ['bolesaShipment', fulfillmentId] }),
    });
    const cancel = useMutation({
        mutationFn: async () => {
            const data = await adminApi<{ bolesaCancelShipment: any }>(cancelMutation, { fulfillmentId });
            return data.bolesaCancelShipment;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: ['bolesaShipment', fulfillmentId] }),
    });

    const created = data?.syncStatus === 'created' && Boolean(data?.trackingNumber);
    const failed = data?.syncStatus === 'failed' || data?.syncStatus === 'retry_exhausted';
    const piecesRejected = /number of pieces|carrier_rejected/i.test(String(data?.lastError ?? ''));

    return (
        <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <div className="font-medium">Create AWB</div>
                    <div className="text-muted-foreground">
                        Same steps as the Bolesa wizard. This shipment is {syncLabel(data?.syncStatus)}.
                    </div>
                </div>
                <div className="flex gap-2">
                    {(failed || data?.syncStatus === 'requested') && (
                        <Button type="button" size="sm" onClick={() => retry.mutate()} disabled={retry.isPending}>
                            {failed ? 'Create AWB again' : 'Send to Bolesa'}
                        </Button>
                    )}
                    {created && (
                        <Button type="button" size="sm" variant="secondary" onClick={() => cancel.mutate()}>
                            Cancel Bolesa shipment
                        </Button>
                    )}
                </div>
            </div>
            {failed && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive">
                    Not created in Bolesa. {data?.lastError}
                    {piecesRejected && (
                        <div className="mt-1 text-foreground">
                            Bosta allows 1 piece. The first attempt sent one piece per product. Create AWB
                            again sends a single piece with the combined weight.
                        </div>
                    )}
                </div>
            )}
            {created && (
                <div className="rounded-md border border-border bg-muted/40 p-3">
                    Tracking {data.trackingNumber}. Bolesa status {data.statusCode ?? '—'}.
                </div>
            )}
            <ol className="grid gap-3 md:grid-cols-4">
                {WIZARD_STEPS.map((step, index) => (
                    <li key={step.id} className="rounded-md border border-border p-3">
                        <div className="text-xs text-muted-foreground">Step {index + 1}</div>
                        <div className="font-medium">{step.title}</div>
                        <div className="mt-1 text-muted-foreground">{stepBody(step.id, order, data, trackingCode)}</div>
                    </li>
                ))}
            </ol>
            <div className="text-muted-foreground">
                Label: {data?.labelAvailability ?? 'unavailable'}
                {data?.labelAvailability === 'url_present'
                    ? ' — download is unavailable until the Bolesa label endpoint exists.'
                    : ''}
                {' · '}COD collection {data?.codCollectionStatus ?? '—'} / remittance{' '}
                {data?.codRemittanceStatus ?? '—'}
            </div>
        </div>
    );
}

function syncLabel(status: string | undefined): string {
    if (status === 'created') return 'created in Bolesa';
    if (status === 'failed' || status === 'retry_exhausted') return 'not in Bolesa';
    if (status === 'awaiting_bolesa') return 'waiting for Bolesa';
    if (status === 'requested') return 'waiting to be sent';
    return status ?? 'not sent yet';
}

function stepBody(step: (typeof WIZARD_STEPS)[number]['id'], order: any, shipment: any, trackingCode?: string): string {
    const address = order?.shippingAddress ?? {};
    const preference = order?.customFields?.paymentPreference === 'cod' ? 'Cash on delivery' : 'Prepaid';
    const slug = shipment?.carrierServiceSlug || order?.customFields?.bolesaServiceSlug || 'Not selected';
    if (step === 'service') {
        return 'Domestic · Dry · Ship';
    }
    if (step === 'locations') {
        const who = [address.fullName, address.city, address.countryCode].filter(Boolean).join(', ');
        return who ? `Warehouse → ${who}` : 'Consignee address is missing';
    }
    if (step === 'carrier') {
        return slug;
    }
    const lines = Array.isArray(order?.lines) ? order.lines : [];
    const weight = lines.reduce((sum: number, line: any) => {
        const each = Number(line?.productVariant?.customFields?.weightKg ?? 1);
        return sum + (Number.isFinite(each) && each > 0 ? each : 1) * (line?.quantity ?? 1);
    }, 0);
    const tracking = shipment?.trackingNumber || trackingCode;
    return `${preference} · ${weight || '—'} kg · 1 piece${tracking ? ` · ${tracking}` : ''}`;
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
                column: 'main',
                position: { blockId: 'fulfillment-details', order: 'after' },
            },
            component: ({ context }) => <BolesaShipmentBlock context={context} />,
        },
    ],
});
