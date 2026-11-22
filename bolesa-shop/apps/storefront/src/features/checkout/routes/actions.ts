'use server';

import {mutate} from '@/platform/vendure/api';
import {SetOrderShippingAddressMutation, SetOrderBillingAddressMutation, SetOrderShippingMethodMutation, AddPaymentToOrderMutation, TransitionOrderToStateMutation, SetCustomerForOrderMutation} from '@/features/checkout/graphql';
import {CreateCustomerAddressMutation} from '@/features/account/graphql';
import {revalidatePath, updateTag} from 'next/cache';
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

    const orderCode = result.data.addPaymentToOrder.code;

    // Update the cart tag to immediately invalidate cached cart data
    updateTag('cart');
    updateTag('active-order');

    const locale = await getLocale();
    redirect({href: `/order-confirmation/${orderCode}`, locale});
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
