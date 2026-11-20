/**
 * Separate safety gate for the official remote Bolesa Sandbox.
 *
 * Does NOT replace or weaken {@link assertSafePartnerHost} (local-only).
 * Remote hosts must be listed explicitly via BOLESA_REMOTE_SANDBOX_ALLOWED_HOSTS —
 * never inferred from production domains.
 */

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function parseRemoteSandboxAllowedHosts(
    raw: string | undefined | null = process.env.BOLESA_REMOTE_SANDBOX_ALLOWED_HOSTS,
): Set<string> {
    const hosts = new Set<string>();
    for (const part of String(raw || '').split(',')) {
        const h = part.trim().toLowerCase();
        if (!h) continue;
        if (LOCAL_HOSTS.has(h)) {
            throw new Error(
                `SAFETY ABORT: local host "${h}" cannot be listed in BOLESA_REMOTE_SANDBOX_ALLOWED_HOSTS`,
            );
        }
        hosts.add(h);
    }
    return hosts;
}

export function assertOfficialRemoteSandboxHost(
    apiBaseUrl: string | undefined | null,
    allowedHostsRaw?: string | null,
): URL {
    if (!apiBaseUrl || !String(apiBaseUrl).trim()) {
        throw new Error('SAFETY ABORT: remote Sandbox Partner API base URL is missing');
    }
    let parsed: URL;
    try {
        parsed = new URL(apiBaseUrl);
    } catch {
        throw new Error(`SAFETY ABORT: invalid remote Sandbox Partner API base URL: ${apiBaseUrl}`);
    }
    if (parsed.protocol !== 'https:') {
        throw new Error(
            `SAFETY ABORT: official remote Sandbox must use https (got ${parsed.protocol})`,
        );
    }
    const host = parsed.hostname.toLowerCase();
    if (LOCAL_HOSTS.has(host)) {
        throw new Error(
            'SAFETY ABORT: local Partner host is not the official remote Sandbox — use .env.sandbox / assertSafePartnerHost for local E2E',
        );
    }
    const allowed = parseRemoteSandboxAllowedHosts(
        allowedHostsRaw ?? process.env.BOLESA_REMOTE_SANDBOX_ALLOWED_HOSTS,
    );
    if (allowed.size === 0) {
        throw new Error(
            'SAFETY ABORT: BOLESA_REMOTE_SANDBOX_ALLOWED_HOSTS is empty — set the official Sandbox hostname explicitly',
        );
    }
    if (!allowed.has(host)) {
        throw new Error(
            `SAFETY ABORT: Partner host ${host} is not in the official remote Sandbox allowlist ` +
                `(allowed: ${[...allowed].join(', ')})`,
        );
    }
    return parsed;
}

export function isOfficialRemoteSandboxHost(
    apiBaseUrl: string | undefined | null,
    allowedHostsRaw?: string | null,
): boolean {
    try {
        assertOfficialRemoteSandboxHost(apiBaseUrl, allowedHostsRaw);
        return true;
    } catch {
        return false;
    }
}
