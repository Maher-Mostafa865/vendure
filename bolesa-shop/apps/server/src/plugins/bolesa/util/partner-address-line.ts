/**
 * Partner inline addresses require `address_line` min length 10
 * (`ValidatesPartnerInlineAddresses`). Short storefront streets (and the old
 * `"Address"` fallback of length 7) caused `/services/options` 422s, which hid
 * `bolesa_shipping` when flatRateFallbackMinor=0.
 */
export const PARTNER_ADDRESS_LINE_MIN = 10;
export const PARTNER_ADDRESS_LINE_MAX = 200;

export function partnerAddressLine(
    ...parts: Array<unknown>
): string {
    const line = parts
        .map(p => (typeof p === 'string' ? p.trim() : ''))
        .filter(p => p.length > 0)
        .join(', ');
    const base = line.length > 0 ? line : 'Delivery address';
    const padded =
        base.length >= PARTNER_ADDRESS_LINE_MIN
            ? base
            : base.padEnd(PARTNER_ADDRESS_LINE_MIN, '.');
    return padded.slice(0, PARTNER_ADDRESS_LINE_MAX);
}
