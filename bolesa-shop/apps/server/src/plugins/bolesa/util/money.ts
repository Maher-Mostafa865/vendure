/**
 * Vendure stores money as integer minor units of the channel currency.
 * Partner `cc_price` / `cod_price` are 2-decimal major units of `price.currency`
 * (EGP on an Egypt deployment, SAR on a Saudi deployment).
 * Multiply by 100 only after those currencies are the same. This module does not convert FX.
 */
export function minorToMajor(minor: number): number {
    return Math.round(minor) / 100;
}

export function majorToMinor(major: number): number {
    return Math.round(Number(major) * 100);
}

export function formatMajor(major: number): number {
    return Math.round(Number(major) * 100) / 100;
}
