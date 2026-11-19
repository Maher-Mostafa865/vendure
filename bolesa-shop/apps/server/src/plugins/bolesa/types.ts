import { ID } from '@vendure/core';

export interface BolesaPluginOptions {
    /**
     * Default Partner API base URL (no trailing slash). Overridable per connection.
     * Example: https://api.example.com/api/pcl/v1
     */
    apiBaseUrl: string;
    /** AES secret for DefaultEncryptionStrategy / token encryption. Prefer env. */
    encryptionSecret: string;
    /** Cache TTL for rate lookups in ms. Default 10 minutes. */
    rateCacheTtlMs?: number;
    /** Default country for geo/shipping (ISO 2). */
    defaultCountryCode?: string;
    /** How often reconciliation runs (cron). Default every 15 minutes. */
    reconcileSchedule?: string;
}

export type BolesaShipmentSyncStatus =
    | 'requested'
    | 'awaiting_bolesa'
    | 'created'
    | 'failed'
    | 'cancel_requested'
    | 'canceled'
    | 'abandoned';

export type CodCollectionStatus = 'pending' | 'collected' | 'not_collected';
export type CodRemittanceStatus = 'unknown' | 'remitted' | 'reversed';
export type PaymentPreference = 'cod' | 'prepaid';

export interface PersistedBolesaQuote {
    serviceSlug: string;
    carrierName?: string;
    priceMinor: number;
    currencyCode: string;
    codFeeMinor?: number;
    paymentPreference: PaymentPreference;
    capturedAt: string;
}

export interface BolesaCityResult {
    name: string;
    resolutionHash: string;
    countryCode?: string;
    governorate?: string;
    district?: string;
}

export interface BolesaServiceOption {
    slug: string;
    carrierName?: string;
    ccPrice?: number;
    codPrice?: number;
    codCollectionFee?: number;
    labels?: Record<string, string>;
}

export interface BolesaCreateAwbInput {
    orderNumber: string;
    carrierServiceSlug: string;
    shipmentType: 'domestic' | 'international';
    shipmentOperation: 'ship' | 'return' | 'exchange';
    shipmentCategory: 'dry' | 'heavy' | 'cold';
    paymentType: 'cc' | 'cod';
    codAmount?: number;
    weightKg: number;
    shipper: BolesaInlineAddress;
    consignee: BolesaInlineAddress;
    description?: string;
    meta: Record<string, string | number | boolean>;
    parcels?: Array<{ actual_weight?: number; weight?: number }>;
}

export interface BolesaInlineAddress {
    name: string;
    phone: string;
    country_code: string;
    resolution_hash: string;
    address_line: string;
    email?: string;
    company_name?: string;
    zip_code?: string;
}

export interface BolesaAwb {
    trackingNumber: string;
    awbReference?: string;
    orderNumber?: string;
    statusCode?: string;
    paymentType?: string;
    codAmount?: number;
    carrierServiceSlug?: string;
    labelUrl?: string | null;
    isDelivered?: boolean;
    isCanceled?: boolean;
    issuingFees?: unknown;
    meta?: Record<string, unknown>;
}

export interface BolesaApiErrorBody {
    success: false;
    code?: string;
    message?: string;
    errors?: unknown;
}

export interface CreateAwbJobData {
    fulfillmentId: ID;
    channelId: ID;
    attempt: number;
}

export interface CancelAwbJobData {
    fulfillmentId: ID;
    channelId: ID;
    trackingNumber: string;
}

export interface ApplyStatusJobData {
    channelId: ID;
    trackingNumber: string;
    observedAt?: string;
}
