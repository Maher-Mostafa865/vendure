'use server';

import {mutate, query} from '@/platform/vendure/api';
import {SetOrderShippingAddressMutation, SetOrderBillingAddressMutation, SetOrderShippingMethodMutation, AddPaymentToOrderMutation, TransitionOrderToStateMutation, SetCustomerForOrderMutation, GetEligibleShippingMethodsQuery} from '@/features/checkout/graphql';
import {isBolesaShippingCode} from './bolesa-choices';
import {getActiveCurrencyCode} from '@/features/currency/currency-server';
import {CreateCustomerAddressMutation} from '@/features/account/graphql';
import {revalidatePath, updateTag} from 'next/cache';
import {redirect as nextRedirect} from 'next/navigation';
import {redirect} from '@/platform/i18n/navigation';
import {getLocale} from 'next-intl/server';
import {getAuthToken} from '@/platform/vendure/auth-token';

interface AddressInput {
    fullName: string;
    streetLine1: string;
    streetLine2?: string;
    city: string;
    province: string;
    postalCode: string;
    countryCode: string;
    phoneNumber: string;
    company?: string;
}

/** Local E2E / Partner known EG city hash — ElHay 07 (Nasr City), Cairo. */
const LOCAL_EG_CITY_HASH_FALLBACK = '63f280b28984f4b7630deec7c0286828';

type BolesaCityHit = { name: string; resolutionHash: string };

/**
 * Partner city search is substring-based: "Nasr City" ranks ElNasriya (Alexandria)
 * first. Prefer hits that contain the full query / "(Nasr City)" so Cairo↔Cairo
 * pairings stay pairable for Bosta.
 */
function pickBestBolesaCityHit(query: string, hits: BolesaCityHit[]): BolesaCityHit | undefined {
    if (!hits.length) {
        return undefined;
    }
    const q = query.trim().toLowerCase();
    const scored = hits.map(hit => {
        const name = hit.name.toLowerCase();
        let score = 0;
        if (name === q) {
            score += 100;
        }
        if (name.includes(`(${q})`) || name.endsWith(` ${q}`) || name.includes(`${q},`)) {
            score += 60;
        }
        if (q.includes('nasr') && name.includes('nasr city')) {
            score += 50;
        }
        if (name.startsWith(q)) {
            score += 20;
        }
        if (name.includes(q)) {
            score += 10;
        }
        // False friends: ElNasriya / ElNasr when the shopper typed Nasr City.
        if (
            q.includes('nasr city') &&
            (name.includes('nasriya') || name === 'elnasr' || name.startsWith('elnasr ')) &&
            !name.includes('nasr city')
        ) {
            score -= 80;
        }
        return { hit, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.score > 0 ? scored[0].hit : hits[0];
}

async function shopRawQuery<T>(
    query: string,
    variables?: Record<string, unknown>,
): Promise<T> {
    const apiUrl =
        process.env.VENDURE_SHOP_API_URL || process.env.NEXT_PUBLIC_VENDURE_SHOP_API_URL;
    if (!apiUrl) {
        throw new Error('VENDURE_SHOP_API_URL is not set');
    }
    const channelToken =
        process.env.VENDURE_CHANNEL_TOKEN ||
        process.env.NEXT_PUBLIC_VENDURE_CHANNEL_TOKEN ||
        '__default_channel__';
    const channelHeader =
        process.env.VENDURE_CHANNEL_TOKEN_HEADER || 'vendure-token';
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        [channelHeader]: channelToken,
    };
    const auth = await getAuthToken();
    if (auth) {
        headers.Authorization = `Bearer ${auth}`;
    }
    const res = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
        throw new Error(`Shop API HTTP ${res.status}`);
    }
    const json = await res.json();
    if (json.errors?.length) {
        throw new Error(json.errors.map((e: { message: string }) => e.message).join('; '));
    }
    return json.data as T;
}

/**
 * Resolve Bolesa city resolution_hash so bolesa_shipping becomes eligible.
 * Phase 1: Egypt only (matcher in Bolesa eligibility checker).
 */
async function resolveBolesaCityCustomFields(
    address: AddressInput,
): Promise<{ bolesaCityHash: string; bolesaCityName: string } | undefined> {
    if (address.countryCode.toUpperCase() !== 'EG') {
        return undefined;
    }
    const query = (address.city || address.province || '').trim();
    if (query.length < 2) {
        return {
            bolesaCityHash: LOCAL_EG_CITY_HASH_FALLBACK,
            bolesaCityName: address.city || 'Nasr City',
        };
    }
    try {
        const data = await shopRawQuery<{ bolesaSearchCities: BolesaCityHit[] }>(
            `query BolesaSearchCities($query: String!) {
                bolesaSearchCities(query: $query) {
                    name
                    resolutionHash
                }
            }`,
            { query },
        );
        const hit = pickBestBolesaCityHit(query, data.bolesaSearchCities ?? []);
        if (hit?.resolutionHash) {
            return {
                bolesaCityHash: hit.resolutionHash,
                bolesaCityName: hit.name || address.city,
            };
        }
    } catch (err) {
        console.warn('bolesaSearchCities failed; using local EG fallback hash', err);
    }
    return {
        bolesaCityHash: LOCAL_EG_CITY_HASH_FALLBACK,
        bolesaCityName: address.city || 'Nasr City',
    };
}

export async function setShippingAddress(
    shippingAddress: AddressInput,
    useSameForBilling: boolean
) {
    const bolesaFields = await resolveBolesaCityCustomFields(shippingAddress);
    const input = {
        ...shippingAddress,
        ...(bolesaFields ? { customFields: bolesaFields } : {}),
    };

    const shippingResult = await mutate(
        SetOrderShippingAddressMutation,
        {input},
        {useAuthToken: true}
    );

    if (shippingResult.data.setOrderShippingAddress.__typename !== 'Order') {
        throw new Error('Failed to set shipping address');
    }

    if (useSameForBilling) {
        await mutate(
            SetOrderBillingAddressMutation,
            {input},
            {useAuthToken: true}
        );
    }

    const locale = await getLocale();
    revalidatePath(`/${locale}/checkout`);
}

export type BolesaCheckoutPolicy = {
    codEnabled: boolean;
    codMinimumMinor: number;
    codPaymentMethodCodes: string[];
};

const DEFAULT_CHECKOUT_POLICY: BolesaCheckoutPolicy = {
    codEnabled: true,
    codMinimumMinor: 100_000,
    codPaymentMethodCodes: ['cashOndelivery-bolesa-egy', 'bolesa-cod'],
};

/** Shop-standard COD (not Bolesa). Still sets order paymentPreference=cod at checkout. */
const STANDARD_COD_METHOD_CODES = new Set(['standard-cod']);

function isCodPaymentMethodCode(methodCode: string, policy: BolesaCheckoutPolicy): boolean {
    return policy.codPaymentMethodCodes.includes(methodCode) || STANDARD_COD_METHOD_CODES.has(methodCode);
}

export async function getBolesaCheckoutPolicy(): Promise<BolesaCheckoutPolicy> {
    try {
        const data = await shopRawQuery<{
            bolesaCheckoutPolicy: BolesaCheckoutPolicy;
        }>(
            `query BolesaCheckoutPolicy {
                bolesaCheckoutPolicy {
                    codEnabled
                    codMinimumMinor
                    codPaymentMethodCodes
                }
            }`,
        );
        const policy = data.bolesaCheckoutPolicy;
        if (!policy || typeof policy.codMinimumMinor !== 'number' || !Array.isArray(policy.codPaymentMethodCodes)) {
            return DEFAULT_CHECKOUT_POLICY;
        }
        return policy;
    } catch (err) {
        console.warn('bolesaCheckoutPolicy failed; using the default cash on delivery minimum', err);
        return DEFAULT_CHECKOUT_POLICY;
    }
}

export async function selectPaymentPreference(methodCode: string) {
    const policy = await getBolesaCheckoutPolicy();
    const preference = isCodPaymentMethodCode(methodCode, policy) ? 'cod' : 'prepaid';
    const data = await shopRawQuery<{
        setOrderCustomFields: { __typename: string; errorCode?: string; message?: string };
    }>(
        `mutation SelectPaymentPreference($input: UpdateOrderInput!) {
            setOrderCustomFields(input: $input) {
                __typename
                ... on Order { id }
                ... on ErrorResult { errorCode message }
            }
        }`,
        { input: { customFields: { paymentPreference: preference } } },
    );
    if (data.setOrderCustomFields.__typename !== 'Order') {
        throw new Error(data.setOrderCustomFields.message || 'Failed to save the payment method');
    }
    // Card and cash on delivery have different Partner prices. Re-quote now,
    // after the preference is saved, so the order does not keep the previous price.
    await applyQuotedShipping();
    const locale = await getLocale();
    revalidatePath(`/${locale}/checkout`);
}

async function applyQuotedShipping() {
    const currencyCode = await getActiveCurrencyCode();
    const methods = await query(
        GetEligibleShippingMethodsQuery,
        {},
        {useAuthToken: true, currencyCode, fetch: {cache: 'no-store'}},
    );
    const method = (methods.data.eligibleShippingMethods ?? []).find((entry) =>
        isBolesaShippingCode(entry.code),
    );
    const result = await mutate(
        SetOrderShippingMethodMutation,
        {shippingMethodId: method ? [method.id] : []},
        {useAuthToken: true},
    );
    if (result.data.setOrderShippingMethod.__typename !== 'Order') {
        throw new Error('Failed to update the shipping price');
    }
}

export async function selectBolesaService(slug: string | null) {
    const data = await shopRawQuery<{
        setOrderCustomFields: { __typename: string; errorCode?: string; message?: string };
    }>(
        `mutation SelectBolesaService($input: UpdateOrderInput!) {
            setOrderCustomFields(input: $input) {
                __typename
                ... on Order { id }
                ... on ErrorResult { errorCode message }
            }
        }`,
        { input: { customFields: { bolesaServiceSlug: slug } } },
    );
    if (data.setOrderCustomFields.__typename !== 'Order') {
        throw new Error(data.setOrderCustomFields.message || 'Failed to save the shipping company');
    }
}

export async function setShippingMethod(shippingMethodId: string) {
    const result = await mutate(
        SetOrderShippingMethodMutation,
        {shippingMethodId: [shippingMethodId]},
        {useAuthToken: true}
    );

    if (result.data.setOrderShippingMethod.__typename !== 'Order') {
        throw new Error('Failed to set shipping method');
    }

    const locale = await getLocale();
    revalidatePath(`/${locale}/checkout`);
}

export async function createCustomerAddress(address: AddressInput) {
    const bolesaFields = await resolveBolesaCityCustomFields(address);
    const input = {
        ...address,
        ...(bolesaFields ? { customFields: bolesaFields } : {}),
    };
    const result = await mutate(
        CreateCustomerAddressMutation,
        {input},
        {useAuthToken: true}
    );

    if (!result.data.createCustomerAddress) {
        throw new Error('Failed to create customer address');
    }

    const locale = await getLocale();
    revalidatePath(`/${locale}/checkout`);
    return result.data.createCustomerAddress;
}

export async function transitionToArrangingPayment() {
    const result = await mutate(
        TransitionOrderToStateMutation,
        {state: 'ArrangingPayment'},
        {useAuthToken: true}
    );

    if (result.data.transitionOrderToState?.__typename === 'OrderStateTransitionError') {
        const errorResult = result.data.transitionOrderToState;
        throw new Error(
            `Failed to transition order state: ${errorResult.errorCode} - ${errorResult.message}`
        );
    }

    const locale = await getLocale();
    revalidatePath(`/${locale}/checkout`);
}

export async function placeOrder(paymentMethodCode: string) {
    // First, transition the order to ArrangingPayment state
    await transitionToArrangingPayment();

    // Prepare metadata based on payment method
    const metadata: Record<string, unknown> = {};

    // For standard payment, include the required fields
    if (paymentMethodCode === 'standard-payment') {
        metadata.shouldDecline = false;
        metadata.shouldError = false;
        metadata.shouldErrorOnSettle = false;
    }

    // Add payment to the order
    const result = await mutate(
        AddPaymentToOrderMutation,
        {
            input: {
                method: paymentMethodCode,
                metadata,
            },
        },
        {useAuthToken: true}
    );

    if (result.data.addPaymentToOrder.__typename !== 'Order') {
        const errorResult = result.data.addPaymentToOrder;
        throw new Error(
            `Failed to place order: ${errorResult.errorCode} - ${errorResult.message}`
        );
    }

    const order = result.data.addPaymentToOrder;
    const orderCode = order.code;
    const payments = order.payments ?? [];
    const latestPayment = [...payments].sort((a, b) => Number(b.id) - Number(a.id))[0];
    const redirectUrl = readPublicRedirectUrl(latestPayment?.metadata);

    // Update the cart tag to immediately invalidate cached cart data
    updateTag('cart');
    updateTag('active-order');

    if (redirectUrl) {
        // External Paymob hosted checkout — absolute URL, leave the app.
        nextRedirect(redirectUrl);
    }

    const locale = await getLocale();
    redirect({href: `/order-confirmation/${orderCode}`, locale});
}

function readPublicRedirectUrl(metadata: unknown): string | null {
    if (!metadata || typeof metadata !== 'object') {
        return null;
    }
    const publicMeta = (metadata as { public?: unknown }).public;
    if (!publicMeta || typeof publicMeta !== 'object') {
        return null;
    }
    const url = (publicMeta as { redirectUrl?: unknown }).redirectUrl;
    return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

interface GuestCustomerInput {
    emailAddress: string;
    firstName: string;
    lastName: string;
    phoneNumber?: string;
}

export type SetCustomerForOrderResult =
    | { success: true }
    | { success: false; errorCode: 'EMAIL_CONFLICT'; message: string }
    | { success: false; errorCode: 'GUEST_CHECKOUT_DISABLED'; message: string }
    | { success: false; errorCode: 'NO_ACTIVE_ORDER'; message: string }
    | { success: false; errorCode: 'UNKNOWN'; message: string };

export async function setCustomerForOrder(
    input: GuestCustomerInput
): Promise<SetCustomerForOrderResult> {
    const result = await mutate(
        SetCustomerForOrderMutation,
        { input },
        { useAuthToken: true }
    );

    const response = result.data.setCustomerForOrder;

    switch (response.__typename) {
        case 'Order': {
            const locale = await getLocale();
            revalidatePath(`/${locale}/checkout`);
            return { success: true };
        }
        case 'AlreadyLoggedInError':
            return { success: true };
        case 'EmailAddressConflictError':
            return { success: false, errorCode: 'EMAIL_CONFLICT', message: response.message };
        case 'GuestCheckoutError':
            return { success: false, errorCode: 'GUEST_CHECKOUT_DISABLED', message: response.message };
        case 'NoActiveOrderError':
            return { success: false, errorCode: 'NO_ACTIVE_ORDER', message: response.message };
        default:
            return { success: false, errorCode: 'UNKNOWN', message: 'Unknown error' };
    }
}
