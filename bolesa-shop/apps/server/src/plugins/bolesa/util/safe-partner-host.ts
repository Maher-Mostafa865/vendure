/**
 * Blocks Partner API calls to hosts that are not explicitly local/sandbox.
 * Production Partner hosts must never be used by E2E or automated harnesses.
 */
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost']);

export function assertSafePartnerHost(apiBaseUrl: string | undefined | null): URL {
    if (!apiBaseUrl || !String(apiBaseUrl).trim()) {
        throw new Error('SAFETY ABORT: Partner API base URL is missing');
    }
    let parsed: URL;
    try {
        parsed = new URL(apiBaseUrl);
    } catch {
        throw new Error(`SAFETY ABORT: invalid Partner API base URL: ${apiBaseUrl}`);
    }
    if (!ALLOWED_HOSTS.has(parsed.hostname)) {
        throw new Error(
            `SAFETY ABORT: Partner host ${parsed.hostname} is not an allowed local/sandbox host ` +
                `(allowed: ${[...ALLOWED_HOSTS].join(', ')})`,
        );
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`SAFETY ABORT: unsupported Partner URL scheme ${parsed.protocol}`);
    }
    return parsed;
}

export function isSafePartnerHost(apiBaseUrl: string | undefined | null): boolean {
    try {
        assertSafePartnerHost(apiBaseUrl);
        return true;
    } catch {
        return false;
    }
}
