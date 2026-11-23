export type VariantOptionChoice = {
    name: string;
    group: {
        name: string;
    };
};

export function formatVariantOptions(options: readonly VariantOptionChoice[]): string {
    return options
        .map((option) => {
            const group = option.group.name.trim();
            const value = option.name.trim();
            if (!group || !value) {
                return '';
            }
            return `${group}: ${value}`;
        })
        .filter((label) => label.length > 0)
        .join(' · ');
}
