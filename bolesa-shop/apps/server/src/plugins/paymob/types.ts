export interface PaymobPluginOptions {
    /** Public base URL of this Vendure server (no trailing slash). Used for Paymob callbacks. */
    serverBaseUrl: string;
    /** Storefront origin for post-payment redirects (no trailing slash). */
    storefrontBaseUrl: string;
    /** AES secret for encrypting Paymob keys. Prefer env. */
    encryptionSecret: string;
}

export type PaymobMode = 'test' | 'live';

export type MarketCountry = 'EG' | 'SA';

/** Plaintext credential fields accepted from the Admin API (write). */
export interface PaymobCredentialInput {
    baseUrl?: string | null;
    apiKey?: string | null;
    secretKey?: string | null;
    publicKey?: string | null;
    hmacSecret?: string | null;
    integrationIdsByCurrency?: Record<string, string | number | null> | null;
    iframeId?: string | null;
}

/** Stored credential set (secrets encrypted). */
export interface PaymobStoredCredentials {
    baseUrl: string;
    apiKeyEncrypted: string;
    secretKeyEncrypted: string;
    hmacSecretEncrypted: string;
    publicKey: string;
    apiKeyLast4: string;
    secretKeyLast4: string;
    hmacSecretLast4: string;
    integrationIdsByCurrency: Record<string, string>;
    iframeId: string | null;
}

/** Decrypted credentials for outbound Paymob calls. */
export interface PaymobActiveCredentials {
    baseUrl: string;
    apiKey: string;
    secretKey: string;
    hmacSecret: string;
    publicKey: string;
    integrationIdsByCurrency: Record<string, string>;
    iframeId: string | null;
}

/** Masked Admin view of one credential set. */
export interface PaymobCredentialPublicView {
    baseUrl: string;
    publicKey: string;
    apiKeyLast4: string;
    secretKeyLast4: string;
    hmacSecretLast4: string;
    integrationIdsByCurrency: Record<string, string>;
    iframeId: string | null;
    configured: boolean;
}
