/**
 * Vendure stores one integer scale for every currency, `entityOptions.moneyStrategy.precision`
 * (DefaultMoneyStrategy is 2). It is not an ISO-4217 table: JPY is not automatically 0
 * and BHD is not automatically 3 unless the strategy precision says so.
 * Partner amounts are major units of `price.currency`. Scale them by 10^precision only
 * after that currency matches the channel. This module does not convert FX.
 */
export const DEFAULT_MONEY_PRECISION = 2;

export function moneyScale(precision: number = DEFAULT_MONEY_PRECISION): number {
    if (!Number.isInteger(precision) || precision < 0 || precision > 6) {
        throw new Error(`Unsupported money precision ${precision}`);
    }
    return 10 ** precision;
}

export function minorToMajor(minor: number, precision: number = DEFAULT_MONEY_PRECISION): number {
    return Math.round(minor) / moneyScale(precision);
}

export function majorToMinor(major: number, precision: number = DEFAULT_MONEY_PRECISION): number {
    return Math.round(Number(major) * moneyScale(precision));
}

export function formatMajor(major: number): number {
    return Math.round(Number(major) * 100) / 100;
}
