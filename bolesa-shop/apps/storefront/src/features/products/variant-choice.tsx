import {formatVariantOptions, type VariantOptionChoice} from './variant-options';

export function VariantChoice({
    name,
    productName,
    options,
    className = 'text-sm mt-1',
}: {
    name: string;
    productName: string;
    options: readonly VariantOptionChoice[];
    className?: string;
}) {
    const label = formatVariantOptions(options) || (name !== productName ? name : '');
    if (!label) {
        return null;
    }

    return <p className={`${className} text-muted-foreground`}>{label}</p>;
}
