import {getCurrencyCookie} from './currency';
import {getActiveChannel} from '@/platform/vendure/channel';

/**
 * Get the active currency code for the current request.
 * Reads from cookie when it is still valid for the channel; otherwise channel default.
 *
 * Safe inside 'use cache: private' (cookies are part of the per-user cache key).
 * NOT safe inside public 'use cache' — pass currency as a parameter instead.
 */
export async function getActiveCurrencyCode(): Promise<string> {
    const channel = await getActiveChannel();
    const available = channel.availableCurrencyCodes as string[];
    const cookieValue = await getCurrencyCookie();

    // Ignore a stale cookie (e.g. USD left from before the Egypt channel became EGP-only).
    if (cookieValue && available.includes(cookieValue)) {
        return cookieValue;
    }

    return channel.defaultCurrencyCode;
}
