import { Inject, Injectable } from '@nestjs/common';
import { Logger } from '@vendure/core';

import { BOLESA_PLUGIN_OPTIONS, loggerCtx } from '../constants';
import {
    BolesaApiErrorBody,
    BolesaAwb,
    BolesaCityResult,
    BolesaCreateAwbInput,
    BolesaPluginOptions,
    BolesaServiceOption,
} from '../types';

export class BolesaApiError extends Error {
    constructor(
        public readonly code: string,
        message: string,
        public readonly status: number,
        public readonly body?: unknown,
    ) {
        super(message);
        this.name = 'BolesaApiError';
    }

    get isRetryable(): boolean {
        return this.status >= 500 || this.status === 409;
    }

    get isDefiniteFailure(): boolean {
        return this.status >= 400 && this.status < 500 && this.status !== 409;
    }
}

export interface BolesaRequestAuth {
    apiBaseUrl: string;
    token: string;
}

@Injectable()
export class BolesaClient {
    constructor(@Inject(BOLESA_PLUGIN_OPTIONS) private options: BolesaPluginOptions) {}

    async me(auth: BolesaRequestAuth): Promise<unknown> {
        return this.request(auth, 'GET', '/me');
    }

    async searchCities(auth: BolesaRequestAuth, query: string): Promise<BolesaCityResult[]> {
        const data = await this.request<any>(auth, 'POST', '/geo/cities/search', { query });
        const rows = Array.isArray(data) ? data : (data?.cities ?? data?.items ?? []);
        return (rows as any[]).map(row => {
            const name = String(
                row.name ?? row.name_en ?? row.name_ar ?? row.city_name ?? '',
            );
            const ancestors = String(row.ancestors_label_en ?? row.ancestors_label_ar ?? '');
            return {
                name,
                resolutionHash: String(row.resolution_hash ?? row.resolutionHash ?? ''),
                countryCode: row.country_code ?? row.countryCode,
                governorate: row.governorate ?? row.admin1_name ?? ancestors.split(',')[1]?.trim(),
                district: row.district ?? row.admin2_name ?? ancestors.split(',')[0]?.trim(),
            };
        }).filter(c => c.name && c.resolutionHash);
    }

    async serviceOptions(
        auth: BolesaRequestAuth,
        body: Record<string, unknown>,
    ): Promise<BolesaServiceOption[]> {
        const data = await this.request<any>(auth, 'POST', '/services/options', body);
        const services = data?.services ?? [];
        return (services as any[]).map(s => ({
            slug: String(s.slug ?? ''),
            carrierName: s.carrier?.name ?? s.carrier_name ?? s.labels?.en,
            ccPrice: s.cc_price != null ? Number(s.cc_price) : undefined,
            codPrice: s.cod_price != null ? Number(s.cod_price) : undefined,
            codCollectionFee: s.cod_collection_fee != null ? Number(s.cod_collection_fee) : undefined,
            labels: s.labels,
        })).filter(s => s.slug);
    }

    async createAwb(
        auth: BolesaRequestAuth,
        input: BolesaCreateAwbInput,
        idempotencyKey: string,
    ): Promise<{ status: 'created' | 'queued'; awbs: BolesaAwb[]; correlationId?: string }> {
        const body = {
            shipment_type: input.shipmentType,
            shipment_operation: input.shipmentOperation,
            shipment_category: input.shipmentCategory,
            carrier_service_slug: input.carrierServiceSlug,
            payment_type: input.paymentType,
            cod_amount: input.codAmount,
            weight: input.weightKg,
            order_number: input.orderNumber,
            description: input.description,
            meta: input.meta,
            parcels: input.parcels,
            shipper: input.shipper,
            consignees: [input.consignee],
        };
        const raw = await this.requestRaw(auth, 'POST', '/awbs', body, {
            'Idempotency-Key': idempotencyKey,
        });
        if (raw.status === 202) {
            return {
                status: 'queued',
                awbs: [],
                correlationId: raw.data?.data?.correlation_id ?? raw.data?.correlation_id,
            };
        }
        const awbsRaw = raw.data?.data?.awbs ?? raw.data?.awbs ?? [];
        return {
            status: 'created',
            awbs: (awbsRaw as any[]).map(mapAwb),
        };
    }

    async getAwb(auth: BolesaRequestAuth, trackingNumber: string): Promise<BolesaAwb | null> {
        try {
            const data = await this.request<any>(auth, 'GET', `/awbs/${encodeURIComponent(trackingNumber)}`);
            const awb = data?.awb ?? data;
            return awb ? mapAwb(awb) : null;
        } catch (e) {
            if (e instanceof BolesaApiError && e.status === 404) {
                return null;
            }
            throw e;
        }
    }

    async findAwbsByMeta(
        auth: BolesaRequestAuth,
        metaKey: string,
        metaValue: string,
    ): Promise<BolesaAwb[]> {
        const qs = new URLSearchParams({ [`meta[${metaKey}]`]: metaValue });
        const data = await this.request<any>(auth, 'GET', `/awbs?${qs.toString()}`);
        // Partner may return the page as a bare array under `data`, or `{ items|awbs }`.
        const items = Array.isArray(data)
            ? data
            : (data?.items ?? data?.awbs ?? data?.data ?? []);
        return (Array.isArray(items) ? items : []).map(mapAwb).filter(a => a.trackingNumber);
    }

    async cancelAwb(
        auth: BolesaRequestAuth,
        trackingNumber: string,
        idempotencyKey: string,
    ): Promise<{ status: string; refund?: { amount: number; currency: string } | null }> {
        const data = await this.request<any>(
            auth,
            'POST',
            `/awbs/${encodeURIComponent(trackingNumber)}/cancel`,
            {},
            { 'Idempotency-Key': idempotencyKey },
        );
        return {
            status: data?.status ?? 'canceled',
            refund: data?.refund ?? null,
        };
    }

    async getTracking(auth: BolesaRequestAuth, trackingNumber: string, refresh = false): Promise<unknown> {
        const q = refresh ? '?refresh=true' : '';
        return this.request(auth, 'GET', `/awbs/${encodeURIComponent(trackingNumber)}/tracking${q}`);
    }

    private async request<T>(
        auth: BolesaRequestAuth,
        method: string,
        path: string,
        body?: unknown,
        extraHeaders?: Record<string, string>,
    ): Promise<T> {
        const raw = await this.requestRaw(auth, method, path, body, extraHeaders);
        return (raw.data?.data ?? raw.data) as T;
    }

    private async requestRaw(
        auth: BolesaRequestAuth,
        method: string,
        path: string,
        body?: unknown,
        extraHeaders?: Record<string, string>,
    ): Promise<{ status: number; data: any; headers: Headers }> {
        const base = (auth.apiBaseUrl || this.options.apiBaseUrl).replace(/\/$/, '');
        const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
        const headers: Record<string, string> = {
            Accept: 'application/json',
            'XP-Api-Token': auth.token,
            ...(extraHeaders ?? {}),
        };
        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        let response: Response;
        try {
            response = await fetch(url, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal,
            });
        } catch (e: any) {
            clearTimeout(timeout);
            Logger.error(`Bolesa request failed: ${method} ${path}: ${e?.message}`, loggerCtx);
            throw new BolesaApiError('network_error', e?.message ?? 'Network error', 503);
        }
        clearTimeout(timeout);

        let data: any = null;
        const text = await response.text();
        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            data = { raw: text };
        }

        if (!response.ok || data?.success === false) {
            const err = data as BolesaApiErrorBody;
            const code = err?.code ?? `http_${response.status}`;
            const message = err?.message ?? `Bolesa API error ${response.status}`;
            Logger.warn(`Bolesa ${method} ${path} -> ${response.status} ${code}`, loggerCtx);
            throw new BolesaApiError(code, message, response.status, data);
        }

        return { status: response.status, data, headers: response.headers };
    }
}

function mapAwb(row: any): BolesaAwb {
    return {
        trackingNumber: String(row.tracking_number ?? row.trackingNumber ?? ''),
        awbReference: row.awb_reference ?? row.awbReference,
        orderNumber: row.order_number ?? row.orderNumber,
        statusCode: row.status_code ?? row.statusCode,
        paymentType: row.payment_type ?? row.paymentType,
        codAmount: row.cod_amount != null ? Number(row.cod_amount) : undefined,
        carrierServiceSlug: row.carrier_service_slug ?? row.carrierServiceSlug,
        labelUrl: row.label_url ?? row.labelUrl ?? null,
        isDelivered: row.is_delivered ?? row.isDelivered,
        isCanceled: row.is_canceled ?? row.isCanceled,
        issuingFees: row.issuing_fees ?? row.issuingFees,
        meta: row.meta,
    };
}
