/**
 * Vendure stores money as integer minor units (piasters for EGP).
 * Bolesa Partner API uses 2-decimal EGP floats.
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
