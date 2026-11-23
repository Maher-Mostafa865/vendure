export type VariantOptionRow = {
    variantId: string;
    options: Array<{ id: string; name: string; groupId: string; groupName: string }>;
};

export type OptionFilterGroup = {
    id: string;
    name: string;
    values: Array<{ id: string; name: string; count: number }>;
};

export function selectedOptionIds(searchParams: {
    [key: string]: string | string[] | undefined;
}): string[] {
    const value = searchParams.options;
    if (!value) {
        return [];
    }
    return (Array.isArray(value) ? value : [value]).filter(Boolean);
}

export function buildOptionFilterGroups(rows: VariantOptionRow[]): OptionFilterGroup[] {
    const groups = new Map<string, OptionFilterGroup>();
    for (const row of rows) {
        for (const option of row.options) {
            let group = groups.get(option.groupId);
            if (!group) {
                group = { id: option.groupId, name: option.groupName, values: [] };
                groups.set(option.groupId, group);
            }
            let value = group.values.find(entry => entry.id === option.id);
            if (!value) {
                value = { id: option.id, name: option.name, count: 0 };
                group.values.push(value);
            }
            value.count += 1;
        }
    }
    return [...groups.values()];
}

export function matchingVariantIds(rows: VariantOptionRow[], selectedIds: string[]): string[] {
    if (selectedIds.length === 0) {
        return rows.map(row => row.variantId);
    }

    const optionGroup = new Map<string, string>();
    for (const row of rows) {
        for (const option of row.options) {
            optionGroup.set(option.id, option.groupId);
        }
    }

    const selectedByGroup = new Map<string, Set<string>>();
    for (const id of selectedIds) {
        const groupId = optionGroup.get(id);
        if (!groupId) {
            continue;
        }
        const selected = selectedByGroup.get(groupId) ?? new Set<string>();
        selected.add(id);
        selectedByGroup.set(groupId, selected);
    }
    if (selectedByGroup.size === 0) {
        return rows.map(row => row.variantId);
    }

    return rows
        .filter(row => {
            const chosen = new Map(row.options.map(option => [option.groupId, option.id]));
            for (const [groupId, ids] of selectedByGroup) {
                const optionId = chosen.get(groupId);
                if (!optionId || !ids.has(optionId)) {
                    return false;
                }
            }
            return true;
        })
        .map(row => row.variantId);
}
