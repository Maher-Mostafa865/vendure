import { DEFAULT_PAYMOB_BASE_URL } from '../constants';
import {
    PaymobActiveCredentials,
    PaymobCredentialInput,
    PaymobCredentialPublicView,
    PaymobMode,
    PaymobStoredCredentials,
} from '../types';
import { PaymobConnection } from '../entities/paymob-connection.entity';

export function normalizeIntegrationIds(
    input: Record<string, string | number | null> | null | undefined,
): Record<string, string> {
    const out: Record<string, string> = {};
    if (!input || typeof input !== 'object') {
        return out;
    }
    for (const [rawKey, rawValue] of Object.entries(input)) {
        const key = String(rawKey).trim().toUpperCase();
        if (!key) continue;
        if (rawValue == null || rawValue === '') continue;
        out[key] = String(rawValue).trim();
    }
    return out;
}

export function resolveIntegrationId(
    currencyCode: string,
    map: Record<string, string> | null | undefined,
    fallback?: string | null,
): string | null {
    const currency = currencyCode.trim().toUpperCase();
    const fromMap = map?.[currency]?.trim();
    if (fromMap) return fromMap;
    const fb = fallback?.trim();
    return fb || null;
}

export function pickStoredCredentials(
    conn: PaymobConnection,
    mode: PaymobMode = conn.mode,
): PaymobStoredCredentials | null {
    return mode === 'live' ? conn.liveCredentials : conn.testCredentials;
}

export function credentialPublicView(
    stored: PaymobStoredCredentials | null | undefined,
): PaymobCredentialPublicView {
    if (!stored) {
        return {
            baseUrl: DEFAULT_PAYMOB_BASE_URL,
            publicKey: '',
            apiKeyLast4: '',
            secretKeyLast4: '',
            hmacSecretLast4: '',
            integrationIdsByCurrency: {},
            iframeId: null,
            configured: false,
        };
    }
    const configured = Boolean(
        stored.apiKeyEncrypted && stored.secretKeyEncrypted && stored.hmacSecretEncrypted && stored.publicKey,
    );
    return {
        baseUrl: stored.baseUrl || DEFAULT_PAYMOB_BASE_URL,
        publicKey: stored.publicKey || '',
        apiKeyLast4: stored.apiKeyLast4 || '',
        secretKeyLast4: stored.secretKeyLast4 || '',
        hmacSecretLast4: stored.hmacSecretLast4 || '',
        integrationIdsByCurrency: stored.integrationIdsByCurrency ?? {},
        iframeId: stored.iframeId ?? null,
        configured,
    };
}

export function mergeCredentialInput(
    existing: PaymobStoredCredentials | null | undefined,
    input: PaymobCredentialInput | null | undefined,
    encrypt: (plaintext: string) => string,
): PaymobStoredCredentials | null {
    if (!input && !existing) {
        return null;
    }
    const base: PaymobStoredCredentials = existing
        ? { ...existing, integrationIdsByCurrency: { ...existing.integrationIdsByCurrency } }
        : {
              baseUrl: DEFAULT_PAYMOB_BASE_URL,
              apiKeyEncrypted: '',
              secretKeyEncrypted: '',
              hmacSecretEncrypted: '',
              publicKey: '',
              apiKeyLast4: '',
              secretKeyLast4: '',
              hmacSecretLast4: '',
              integrationIdsByCurrency: {},
              iframeId: null,
          };

    if (!input) {
        return base;
    }

    if (input.baseUrl !== undefined && input.baseUrl !== null && String(input.baseUrl).trim()) {
        base.baseUrl = String(input.baseUrl).trim().replace(/\/$/, '');
    }
    if (input.publicKey !== undefined && input.publicKey !== null && String(input.publicKey).trim()) {
        base.publicKey = String(input.publicKey).trim();
    }
    if (input.iframeId !== undefined) {
        const iframe = input.iframeId == null ? null : String(input.iframeId).trim() || null;
        base.iframeId = iframe;
    }
    if (input.integrationIdsByCurrency !== undefined) {
        base.integrationIdsByCurrency = normalizeIntegrationIds(input.integrationIdsByCurrency);
    }
    if (input.apiKey !== undefined && input.apiKey !== null && String(input.apiKey).trim()) {
        const value = String(input.apiKey).trim();
        base.apiKeyEncrypted = encrypt(value);
        base.apiKeyLast4 = value.slice(-4);
    }
    if (input.secretKey !== undefined && input.secretKey !== null && String(input.secretKey).trim()) {
        const value = String(input.secretKey).trim();
        base.secretKeyEncrypted = encrypt(value);
        base.secretKeyLast4 = value.slice(-4);
    }
    if (input.hmacSecret !== undefined && input.hmacSecret !== null && String(input.hmacSecret).trim()) {
        const value = String(input.hmacSecret).trim();
        base.hmacSecretEncrypted = encrypt(value);
        base.hmacSecretLast4 = value.slice(-4);
    }
    return base;
}

export function decryptCredentials(
    stored: PaymobStoredCredentials,
    decrypt: (ciphertext: string) => string,
): PaymobActiveCredentials {
    return {
        baseUrl: (stored.baseUrl || DEFAULT_PAYMOB_BASE_URL).replace(/\/$/, ''),
        apiKey: decrypt(stored.apiKeyEncrypted),
        secretKey: decrypt(stored.secretKeyEncrypted),
        hmacSecret: decrypt(stored.hmacSecretEncrypted),
        publicKey: stored.publicKey,
        integrationIdsByCurrency: stored.integrationIdsByCurrency ?? {},
        iframeId: stored.iframeId ?? null,
    };
}

export function assertCredentialsComplete(creds: PaymobActiveCredentials): void {
    if (!creds.secretKey || !creds.publicKey || !creds.hmacSecret) {
        throw new Error('Paymob credentials are incomplete for the active mode');
    }
}
