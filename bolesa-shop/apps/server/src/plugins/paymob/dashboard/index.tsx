import { api, Button, defineDashboardExtension } from '@vendure/dashboard';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';

const connectionQuery = `
  query PaymobConnection {
    paymobConnection {
      id
      mode
      isActive
      marketCountry
      testCredentials {
        baseUrl
        publicKey
        apiKeyLast4
        secretKeyLast4
        hmacSecretLast4
        integrationIdsByCurrency
        iframeId
        configured
      }
      liveCredentials {
        baseUrl
        publicKey
        apiKeyLast4
        secretKeyLast4
        hmacSecretLast4
        integrationIdsByCurrency
        iframeId
        configured
      }
    }
  }
`;

const saveMutation = `
  mutation UpdatePaymobConnection($input: UpdatePaymobConnectionInput!) {
    updatePaymobConnection(input: $input) {
      id
      mode
      isActive
      marketCountry
      testCredentials { configured apiKeyLast4 }
      liveCredentials { configured apiKeyLast4 }
    }
  }
`;

async function adminApi<T = any>(document: string, variables?: Record<string, unknown>): Promise<T> {
    const vars = variables ?? {};
    if (/^\s*mutation\b/.test(document)) {
        return api.mutate(document, vars) as Promise<T>;
    }
    return api.query<T>(document, vars);
}

type CredView = {
    baseUrl: string;
    publicKey: string;
    apiKeyLast4: string;
    secretKeyLast4: string;
    hmacSecretLast4: string;
    integrationIdsByCurrency: Record<string, string>;
    iframeId: string | null;
    configured: boolean;
};

type ConnectionView = {
    id: string | null;
    mode: 'test' | 'live';
    isActive: boolean;
    marketCountry: string;
    testCredentials: CredView;
    liveCredentials: CredView;
};

function PaymobConnectionPage() {
    const qc = useQueryClient();
    const { data, isLoading, error, refetch } = useQuery({
        queryKey: ['paymobConnection'],
        queryFn: async () => {
            const d = await adminApi<{ paymobConnection: ConnectionView }>(connectionQuery);
            return d.paymobConnection;
        },
    });

    if (isLoading) {
        return (
            <PageShell title="Paymob">
                <p className="text-sm text-muted-foreground">Loading Paymob connection…</p>
            </PageShell>
        );
    }
    if (error) {
        return (
            <PageShell title="Paymob">
                <p className="text-destructive text-sm">Failed to load: {(error as Error).message}</p>
                <Button type="button" onClick={() => refetch()}>
                    Retry
                </Button>
            </PageShell>
        );
    }

    return (
        <PageShell
            title="Paymob"
            description="Per-channel Paymob credentials. Toggle test/live; each mode keeps its own keys. Market country drives Bolesa shipping eligibility (EG or SA)."
        >
            <ConnectionForm
                existing={data!}
                onSaved={() => qc.invalidateQueries({ queryKey: ['paymobConnection'] })}
            />
        </PageShell>
    );
}

function ConnectionForm({
    existing,
    onSaved,
}: {
    existing: ConnectionView;
    onSaved: () => void;
}) {
    const [mode, setMode] = useState<'test' | 'live'>(existing.mode || 'test');
    const [isActive, setIsActive] = useState(existing.isActive !== false);
    const [marketCountry, setMarketCountry] = useState(existing.marketCountry || 'EG');
    const [testForm, setTestForm] = useState(() => emptyCredForm(existing.testCredentials));
    const [liveForm, setLiveForm] = useState(() => emptyCredForm(existing.liveCredentials));
    const [message, setMessage] = useState<string | null>(null);

    useEffect(() => {
        setMode(existing.mode || 'test');
        setIsActive(existing.isActive !== false);
        setMarketCountry(existing.marketCountry || 'EG');
        setTestForm(emptyCredForm(existing.testCredentials));
        setLiveForm(emptyCredForm(existing.liveCredentials));
    }, [existing]);

    const save = useMutation({
        mutationFn: async () => {
            const input: Record<string, unknown> = {
                mode,
                isActive,
                marketCountry,
                testCredentials: toCredentialInput(testForm),
                liveCredentials: toCredentialInput(liveForm),
            };
            return adminApi(saveMutation, { input });
        },
        onSuccess: () => {
            setMessage('Saved Paymob connection for this channel.');
            onSaved();
        },
        onError: (e: Error) => setMessage(e.message),
    });

    return (
        <form
            className="space-y-6"
            onSubmit={event => {
                event.preventDefault();
                setMessage(null);
                save.mutate();
            }}
        >
            <div className="grid gap-4 sm:grid-cols-3">
                <label className="space-y-1 text-sm">
                    <span className="font-medium">Market country</span>
                    <select
                        className={fieldClass}
                        value={marketCountry}
                        onChange={e => setMarketCountry(e.target.value)}
                    >
                        <option value="EG">Egypt (EG)</option>
                        <option value="SA">Saudi Arabia (SA)</option>
                    </select>
                </label>
                <label className="space-y-1 text-sm">
                    <span className="font-medium">Active mode</span>
                    <select
                        className={fieldClass}
                        value={mode}
                        onChange={e => setMode(e.target.value as 'test' | 'live')}
                    >
                        <option value="test">Test</option>
                        <option value="live">Live</option>
                    </select>
                </label>
                <label className="flex items-end gap-2 pb-2 text-sm">
                    <input
                        type="checkbox"
                        checked={isActive}
                        onChange={e => setIsActive(e.target.checked)}
                    />
                    <span>Connection active (required for Paymob to appear at checkout)</span>
                </label>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
                <StatusCard
                    label="Test credentials"
                    value={existing.testCredentials.configured ? `···· ${existing.testCredentials.apiKeyLast4}` : 'Not set'}
                    tone={existing.testCredentials.configured ? 'ok' : 'muted'}
                />
                <StatusCard
                    label="Live credentials"
                    value={existing.liveCredentials.configured ? `···· ${existing.liveCredentials.apiKeyLast4}` : 'Not set'}
                    tone={existing.liveCredentials.configured ? 'ok' : 'muted'}
                />
            </div>

            <CredentialEditor title="Test credentials" form={testForm} onChange={setTestForm} />
            <CredentialEditor title="Live credentials" form={liveForm} onChange={setLiveForm} />

            {message && <p className="text-sm text-muted-foreground">{message}</p>}

            <Button type="submit" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save Paymob connection'}
            </Button>
        </form>
    );
}

type CredFormState = {
    baseUrl: string;
    publicKey: string;
    apiKey: string;
    secretKey: string;
    hmacSecret: string;
    iframeId: string;
    egp: string;
    usd: string;
    sar: string;
    eur: string;
};

function emptyCredForm(view: CredView | undefined): CredFormState {
    const ids = view?.integrationIdsByCurrency ?? {};
    return {
        baseUrl: view?.baseUrl || 'https://accept.paymob.com',
        publicKey: view?.publicKey || '',
        apiKey: '',
        secretKey: '',
        hmacSecret: '',
        iframeId: view?.iframeId || '',
        egp: ids.EGP || '',
        usd: ids.USD || '',
        sar: ids.SAR || '',
        eur: ids.EUR || '',
    };
}

function toCredentialInput(form: CredFormState) {
    const integrationIdsByCurrency: Record<string, string> = {};
    if (form.egp.trim()) integrationIdsByCurrency.EGP = form.egp.trim();
    if (form.usd.trim()) integrationIdsByCurrency.USD = form.usd.trim();
    if (form.sar.trim()) integrationIdsByCurrency.SAR = form.sar.trim();
    if (form.eur.trim()) integrationIdsByCurrency.EUR = form.eur.trim();

    const input: Record<string, unknown> = {
        baseUrl: form.baseUrl.trim() || undefined,
        publicKey: form.publicKey.trim() || undefined,
        iframeId: form.iframeId.trim() || null,
        integrationIdsByCurrency,
    };
    if (form.apiKey.trim()) input.apiKey = form.apiKey.trim();
    if (form.secretKey.trim()) input.secretKey = form.secretKey.trim();
    if (form.hmacSecret.trim()) input.hmacSecret = form.hmacSecret.trim();
    return input;
}

function CredentialEditor({
    title,
    form,
    onChange,
}: {
    title: string;
    form: CredFormState;
    onChange: (next: CredFormState) => void;
}) {
    const set = (patch: Partial<CredFormState>) => onChange({ ...form, ...patch });
    return (
        <fieldset className="space-y-3 rounded-md border p-4">
            <legend className="px-1 text-sm font-semibold">{title}</legend>
            <p className="text-xs text-muted-foreground">
                Leave secret fields blank to keep the stored value. Paste new keys only when rotating.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Base URL" value={form.baseUrl} onChange={v => set({ baseUrl: v })} />
                <Field label="Public key" value={form.publicKey} onChange={v => set({ publicKey: v })} />
                <Field label="API key" value={form.apiKey} onChange={v => set({ apiKey: v })} password />
                <Field label="Secret key" value={form.secretKey} onChange={v => set({ secretKey: v })} password />
                <Field label="HMAC secret" value={form.hmacSecret} onChange={v => set({ hmacSecret: v })} password />
                <Field label="Iframe ID (optional)" value={form.iframeId} onChange={v => set({ iframeId: v })} />
                <Field label="Integration ID EGP" value={form.egp} onChange={v => set({ egp: v })} />
                <Field label="Integration ID USD" value={form.usd} onChange={v => set({ usd: v })} />
                <Field label="Integration ID SAR" value={form.sar} onChange={v => set({ sar: v })} />
                <Field label="Integration ID EUR" value={form.eur} onChange={v => set({ eur: v })} />
            </div>
        </fieldset>
    );
}

function Field({
    label,
    value,
    onChange,
    password,
}: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    password?: boolean;
}) {
    return (
        <label className="space-y-1 text-sm">
            <span className="font-medium">{label}</span>
            <input
                className={fieldClass}
                type={password ? 'password' : 'text'}
                value={value}
                onChange={e => onChange(e.target.value)}
                autoComplete="off"
            />
        </label>
    );
}

function StatusCard({
    label,
    value,
    tone,
}: {
    label: string;
    value: string;
    tone: 'ok' | 'muted';
}) {
    return (
        <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className={`text-sm font-medium ${tone === 'ok' ? 'text-foreground' : 'text-muted-foreground'}`}>
                {value}
            </p>
        </div>
    );
}

function PageShell({
    title,
    description,
    children,
}: {
    title: string;
    description?: string;
    children: ReactNode;
}) {
    return (
        <div className="mx-auto max-w-6xl space-y-4 p-4">
            <div className="space-y-1">
                <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
                {description && <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>}
            </div>
            {children}
        </div>
    );
}

const fieldClass =
    'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

defineDashboardExtension({
    routes: [
        {
            path: '/paymob-connection',
            loader: () => ({ breadcrumb: 'Paymob' }),
            component: () => <PaymobConnectionPage />,
            navMenuItem: {
                id: 'paymob-connection',
                title: 'Paymob',
                sectionId: 'settings',
            },
            requiresPermission: 'ReadPaymobConnection',
        },
    ],
});
