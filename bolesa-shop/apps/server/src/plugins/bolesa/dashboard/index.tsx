import { api, Button, defineDashboardExtension } from '@vendure/dashboard';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

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
      shipperAddress
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

const saveConnectionMutation = `
  mutation SaveBolesaConnection($input: UpdateBolesaConnectionInput!) {
    updateBolesaConnection(input: $input) {
      id
      apiBaseUrl
      tokenLast4
      isActive
      shipperAddress
    }
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
    const [celebrate, setCelebrate] = useState<string | null>(null);
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
        onSuccess: result => {
            qc.invalidateQueries({ queryKey: ['bolesaConnection'] });
            if (result?.ok) {
                setCelebrate(result.message || 'The Partner API accepted this connection.');
            }
        },
    });

    if (isLoading) {
        return <PageShell title="Bolesa Connection"><p className="text-sm text-muted-foreground">Loading connection…</p></PageShell>;
    }
    if (error) {
        return (
            <PageShell title="Bolesa Connection">
                <p className="text-destructive text-sm">Failed to load connection: {(error as Error).message}</p>
                <p className="text-muted-foreground text-sm">
                    Stay logged in and select the channel in the dashboard header, then open this page again.
                </p>
                <Button type="button" onClick={() => refetch()}>Retry</Button>
            </PageShell>
        );
    }
    if (!data) {
        return (
            <PageShell
                title="Bolesa Connection"
                description="No connection for the channel selected in the dashboard. Add the Partner API URL, token, and shipper address."
            >
                <ConnectionForm existing={null} />
            </PageShell>
        );
    }
    return (
        <PageShell
            title="Bolesa Connection"
            description="Partner credentials and the shipper address used for this channel."
            actions={
                <Button type="button" variant="secondary" onClick={() => test.mutate()} disabled={test.isPending}>
                    {test.isPending ? 'Testing…' : 'Test connection'}
                </Button>
            }
        >
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <StatusCard label="Status" value={data.isActive ? 'Active' : 'Inactive'} tone={data.isActive ? 'ok' : 'muted'} />
                <StatusCard label="Token" value={`···· ${data.tokenLast4 || '—'}`} />
                <StatusCard
                    label="Cash on delivery"
                    value={data.codEnabled ? `On · ${data.codFeeMode}` : 'Off'}
                />
                <StatusCard label="Last verified" value={formatWhen(data.lastVerifiedAt)} />
            </div>
            {test.data && !test.data.ok && (
                <p className="text-sm text-destructive">Connection failed. {test.data.message}</p>
            )}
            {test.data?.ok && !celebrate && (
                <p className="text-sm">Connection accepted. {test.data.message}</p>
            )}
            {celebrate && <Celebration message={celebrate} onClose={() => setCelebrate(null)} />}
            {data.labelNote && <p className="text-sm text-muted-foreground">{data.labelNote}</p>}
            <div className="grid gap-4 xl:grid-cols-2">
                <ConnectionForm existing={data} />
                <MerchantSettings connection={data} />
            </div>
            <p className="text-xs text-muted-foreground">
                Shipping prices are used only when the Partner currency matches this channel. Egypt uses EGP and
                Saudi Arabia uses SAR. Prepaid is sent as cc. Cash on delivery sends the order total.
            </p>
        </PageShell>
    );
}

function PageShell({
    title,
    description,
    actions,
    children,
}: {
    title: string;
    description?: string;
    actions?: ReactNode;
    children: ReactNode;
}) {
    return (
        <div className="mx-auto max-w-6xl space-y-4 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                    <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
                    {description && <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>}
                </div>
                {actions}
            </div>
            {children}
        </div>
    );
}

function StatusCard({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'muted' }) {
    return (
        <div className="rounded-lg border bg-card px-4 py-3">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className={`mt-1 text-sm font-medium ${tone === 'ok' ? 'text-foreground' : ''}`}>{value}</div>
        </div>
    );
}

function Celebration({ message, onClose }: { message: string; onClose: () => void }) {
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    useEffect(() => {
        const timer = window.setTimeout(() => closeRef.current(), 7000);
        return () => window.clearTimeout(timer);
    }, []);
    const pieces = ['🎉', '🎊', '✨', '🥳', '⭐'];
    return createPortal(
        <div
            className="fixed inset-0 flex items-center justify-center"
            style={{ zIndex: 2147483000 }}
            role="dialog"
            aria-label="Connection accepted"
            onClick={onClose}
        >
            <style>{celebrationCss}</style>
            <div className="absolute inset-0 bg-black/55" />
            {Array.from({ length: 36 }, (_, index) => (
                <span
                    key={index}
                    className="bolesa-confetti pointer-events-none absolute top-0 text-2xl"
                    style={{
                        left: `${(index * 29) % 100}%`,
                        animationDelay: `${(index % 9) * 0.16}s`,
                        animationDuration: `${2.4 + (index % 5) * 0.35}s`,
                    }}
                >
                    {pieces[index % pieces.length]}
                </span>
            ))}
            <div
                className="bolesa-celebrate relative mx-4 max-w-md rounded-2xl border bg-card px-8 py-7 text-center shadow-2xl"
                onClick={event => event.stopPropagation()}
            >
                <div className="text-6xl">🎉</div>
                <h3 className="mt-3 text-2xl font-semibold">Congratulations</h3>
                <p className="mt-2 text-sm text-muted-foreground">Connection accepted. {message}</p>
                <Button type="button" className="mt-5" onClick={onClose}>
                    Continue
                </Button>
            </div>
        </div>,
        document.body,
    );
}

const celebrationCss = `
@keyframes bolesa-fall {
  0% { transform: translateY(-12vh) rotate(0deg); opacity: 0; }
  12% { opacity: 1; }
  100% { transform: translateY(110vh) rotate(280deg); opacity: 0.9; }
}
@keyframes bolesa-pop {
  0% { transform: scale(0.6); opacity: 0; }
  70% { transform: scale(1.06); }
  100% { transform: scale(1); opacity: 1; }
}
.bolesa-confetti { animation-name: bolesa-fall; animation-timing-function: linear; animation-iteration-count: infinite; }
.bolesa-celebrate { animation: bolesa-pop 0.45s ease-out; }
@media (prefers-reduced-motion: reduce) {
  .bolesa-confetti { animation: none; top: 12%; }
  .bolesa-celebrate { animation: none; }
}
`;

function formatWhen(value: string | null | undefined): string {
    if (!value) {
        return 'Not verified';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }
    return date.toLocaleString();
}

const fieldClass = 'h-9 w-full rounded-md border bg-background px-3 text-sm';

type ShipperAddress = {
    name?: string;
    phone?: string;
    country_code?: string;
    resolution_hash?: string;
    address_line?: string;
};

function ConnectionForm({ existing }: { existing: any | null }) {
    const qc = useQueryClient();
    const shipper = (existing?.shipperAddress ?? {}) as ShipperAddress;
    const [apiBaseUrl, setApiBaseUrl] = useState(existing?.apiBaseUrl ?? '');
    const [token, setToken] = useState('');
    const [name, setName] = useState(shipper.name ?? '');
    const [phone, setPhone] = useState(shipper.phone ?? '');
    const [countryCode, setCountryCode] = useState(shipper.country_code ?? 'EG');
    const [resolutionHash, setResolutionHash] = useState(shipper.resolution_hash ?? '');
    const [addressLine, setAddressLine] = useState(shipper.address_line ?? '');
    const [formError, setFormError] = useState('');

    useEffect(() => {
        const next = (existing?.shipperAddress ?? {}) as ShipperAddress;
        setApiBaseUrl(existing?.apiBaseUrl ?? '');
        setName(next.name ?? '');
        setPhone(next.phone ?? '');
        setCountryCode(next.country_code ?? 'EG');
        setResolutionHash(next.resolution_hash ?? '');
        setAddressLine(next.address_line ?? '');
    }, [existing]);

    const save = useMutation({
        mutationFn: async () => {
            const input: Record<string, unknown> = {
                apiBaseUrl: apiBaseUrl.trim(),
                isActive: true,
                shipperAddress: {
                    name: name.trim(),
                    phone: phone.trim(),
                    country_code: countryCode.trim(),
                    resolution_hash: resolutionHash.trim(),
                    address_line: addressLine.trim(),
                },
            };
            if (token.trim()) {
                input.token = token.trim();
            }
            const result = await adminApi<{ updateBolesaConnection: any }>(saveConnectionMutation, { input });
            return result.updateBolesaConnection;
        },
        onSuccess: () => {
            setToken('');
            setFormError('');
            qc.invalidateQueries({ queryKey: ['bolesaConnection'] });
        },
    });

    const missingToken = !existing && !token.trim();

    return (
        <form
            className="space-y-5 rounded-lg border bg-card p-5"
            onSubmit={event => {
                event.preventDefault();
                if (missingToken) {
                    setFormError('Partner API token is required.');
                    return;
                }
                setFormError('');
                save.mutate();
            }}
        >
            <div>
                <h3 className="font-medium">{existing ? 'Connection details' : 'Add connection'}</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                    Saved for the channel selected in the dashboard.
                    {existing ? ' Leave the token blank to keep the current one.' : ''}
                </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
                <Field label="API base URL" className="sm:col-span-2">
                    <input className={fieldClass} value={apiBaseUrl} required placeholder="https://api.example/api/pcl/v1" onChange={event => setApiBaseUrl(event.target.value)} />
                </Field>
                <Field label="Partner API token" className="sm:col-span-2">
                    <input
                        className={fieldClass}
                        type="password"
                        value={token}
                        autoComplete="off"
                        placeholder={existing ? `Current token ends with ${existing.tokenLast4}` : 'Paste the Partner token'}
                        onChange={event => setToken(event.target.value)}
                    />
                </Field>
                <Field label="Shipper name">
                    <input className={fieldClass} value={name} required onChange={event => setName(event.target.value)} />
                </Field>
                <Field label="Shipper phone">
                    <input className={fieldClass} value={phone} required onChange={event => setPhone(event.target.value)} />
                </Field>
                <Field label="Country code">
                    <input className={fieldClass} value={countryCode} required onChange={event => setCountryCode(event.target.value)} />
                </Field>
                <Field label="City resolution hash">
                    <input className={fieldClass} value={resolutionHash} required onChange={event => setResolutionHash(event.target.value)} />
                </Field>
                <Field label="Address" className="sm:col-span-2">
                    <input className={fieldClass} value={addressLine} required onChange={event => setAddressLine(event.target.value)} />
                </Field>
            </div>
            <div className="flex items-center justify-between gap-3">
                <div className="text-sm">
                    {formError && <p className="text-destructive">{formError}</p>}
                    {save.error && <p className="text-destructive">{(save.error as Error).message}</p>}
                    {save.isSuccess && <p>Connection saved.</p>}
                </div>
                <Button type="submit" disabled={save.isPending || missingToken}>
                    {save.isPending ? 'Saving…' : existing ? 'Save connection' : 'Add connection'}
                </Button>
            </div>
        </form>
    );
}

function Field({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
    return (
        <label className={`block space-y-1.5 text-sm ${className ?? ''}`}>
            <span className="text-muted-foreground">{label}</span>
            {children}
        </label>
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
    const allSelected = catalog.length > 0 && catalog.every(row => enabled.includes(row.slug));
    function selectAll() {
        setEnabled(catalog.map(row => row.slug));
    }
    function clearAll() {
        setEnabled([]);
    }
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
            className="space-y-5 rounded-lg border bg-card p-5"
            onSubmit={event => {
                event.preventDefault();
                save.mutate();
            }}
        >
            <div>
                <h3 className="font-medium">Shipment settings</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                    Leave every service unchecked to offer all priced services.
                </p>
            </div>
            <div className="space-y-2">
                <label className="flex items-start gap-3 rounded-md border px-3 py-2 text-sm">
                    <input className="mt-0.5" type="checkbox" checked={allowOpen} onChange={event => setAllowOpen(event.target.checked)} />
                    <span>Allow the customer to open the shipment</span>
                </label>
                {allowOpen && (
                    <p className="text-xs text-destructive">
                        Bosta services need a public product photo. Without it, the shipment is not booked.
                    </p>
                )}
                <label className="flex items-start gap-3 rounded-md border px-3 py-2 text-sm">
                    <input className="mt-0.5" type="checkbox" checked={autoCreateAwb} onChange={event => setAutoCreateAwb(event.target.checked)} />
                    <span>Create the Bolesa fulfillment automatically after payment</span>
                </label>
            </div>
            <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm text-muted-foreground">
                        Services customers can choose
                        {catalog.length > 0 && (
                            <span className="ml-2 text-xs">
                                {enabled.length ? `${enabled.length} of ${catalog.length}` : 'All priced services'}
                            </span>
                        )}
                    </p>
                    {catalog.length > 0 && (
                        <div className="flex gap-2">
                            <Button type="button" variant="secondary" onClick={selectAll} disabled={allSelected}>
                                Select all
                            </Button>
                            <Button type="button" variant="secondary" onClick={clearAll} disabled={enabled.length === 0}>
                                Clear
                            </Button>
                        </div>
                    )}
                </div>
                {services.isLoading && <p className="text-sm text-muted-foreground">Loading services…</p>}
                {services.error && <p className="text-sm text-destructive">{(services.error as Error).message}</p>}
                {!services.isLoading && !catalog.length && (
                    <p className="text-sm text-muted-foreground">No services returned for this account.</p>
                )}
                {catalog.length > 0 && (
                    <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-2">
                        {catalog.map(row => (
                            <label key={row.slug} className="flex items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                                <input type="checkbox" checked={enabled.includes(row.slug)} onChange={() => toggle(row.slug)} />
                                <span className="min-w-0">
                                    <span className="block">{row.name}</span>
                                    <span className="block truncate text-xs text-muted-foreground">{row.slug}</span>
                                </span>
                            </label>
                        ))}
                    </div>
                )}
            </div>
            <Field label="Default service">
                <select className={fieldClass} value={defaultSlug} onChange={event => setDefaultSlug(event.target.value)}>
                    <option value="">None</option>
                    {choices.map(row => (
                        <option key={row.slug} value={row.slug}>{row.name}</option>
                    ))}
                </select>
            </Field>
            {needsDefault && (
                <p className="text-sm text-destructive">
                    Automatic creation needs a default service for customers who do not pick one.
                </p>
            )}
            <div className="flex items-center justify-between gap-3">
                <div className="text-sm">
                    {save.error && <p className="text-destructive">{(save.error as Error).message}</p>}
                    {save.isSuccess && <p>Settings saved.</p>}
                </div>
                <Button type="submit" disabled={save.isPending || needsDefault}>
                    {save.isPending ? 'Saving…' : 'Save settings'}
                </Button>
            </div>
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
