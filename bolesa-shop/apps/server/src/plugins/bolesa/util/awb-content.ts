/**
 * Create-AWB wizard "simple" shipment: one piece, combined weight.
 * Bosta and the other Egypt domestic services allow max_parcels_count = 1.
 * One parcel per order line becomes number_of_pieces > 1 and the carrier rejects it.
 */
export interface AwbLineInput {
    name?: string;
    quantity: number;
    weightKg?: number | null;
}

export interface AwbShipmentContent {
    weightKg: number;
    numberOfPieces: 1;
    description: string;
    parcels: Array<{ actual_weight: number }>;
}

export function buildAwbShipmentContent(lines: AwbLineInput[], orderCode: string): AwbShipmentContent {
    const parts: string[] = [];
    let weight = 0;
    for (const line of lines) {
        const qty = Math.max(1, Math.trunc(Number(line.quantity) || 1));
        const each = Number(line.weightKg);
        const lineWeight = (Number.isFinite(each) && each > 0 ? each : 1) * qty;
        weight += lineWeight;
        const name = line.name?.trim() || 'Item';
        parts.push(`${name} x${qty}`);
    }
    const weightKg = Math.max(0.01, Math.round(weight * 1000) / 1000);
    const listed = parts.length ? parts.join(', ') : `Order ${orderCode}`;
    return {
        weightKg,
        numberOfPieces: 1,
        description: listed.slice(0, 200),
        parcels: [{ actual_weight: weightKg }],
    };
}
