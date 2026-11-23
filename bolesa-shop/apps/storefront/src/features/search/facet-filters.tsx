'use client';

import { use, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { usePathname, useRouter } from '@/platform/i18n/navigation';
import { ResultOf } from '@/platform/vendure/graphql';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { SlidersHorizontal, ChevronDown } from 'lucide-react';
import {SearchProductsQuery} from '@/features/search/graphql';
import {useTranslations} from 'next-intl';

interface FacetFiltersProps {
    productDataPromise: Promise<{
        data: ResultOf<typeof SearchProductsQuery>;
        token?: string;
    }>;
    optionGroups?: Array<{
        id: string;
        name: string;
        values: Array<{ id: string; name: string; count: number }>;
    }>;
}

function FilterContent({
    facetGroups,
    optionGroups,
    selectedFacets,
    selectedOptions,
    toggleFacet,
    toggleOption,
    clearFilters,
    hasActiveFilters,
}: {
    facetGroups: Record<string, { id: string; name: string; values: Array<{ id: string; name: string; count: number }> }>;
    optionGroups: Array<{ id: string; name: string; values: Array<{ id: string; name: string; count: number }> }>;
    selectedFacets: string[];
    selectedOptions: string[];
    toggleFacet: (facetId: string) => void;
    toggleOption: (optionId: string) => void;
    clearFilters: () => void;
    hasActiveFilters: boolean;
}) {
    const t = useTranslations('Filters');
    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <h2 className="font-semibold text-lg">{t('title')}</h2>
                {hasActiveFilters && (
                    <Button variant="ghost" size="sm" onClick={clearFilters}>
                        {t('clearAll')}
                    </Button>
                )}
            </div>

            {Object.entries(facetGroups).map(([facetName, facet]) => (
                <FilterGroup
                    key={facet.id}
                    idPrefix="facet"
                    name={facetName}
                    values={facet.values}
                    selectedIds={selectedFacets}
                    onToggle={toggleFacet}
                />
            ))}
            {optionGroups.map(group => (
                <FilterGroup
                    key={group.id}
                    idPrefix="option"
                    name={group.name}
                    values={group.values}
                    selectedIds={selectedOptions}
                    onToggle={toggleOption}
                />
            ))}
        </div>
    );
}

function FilterGroup({
    idPrefix,
    name,
    values,
    selectedIds,
    onToggle,
}: {
    idPrefix: string;
    name: string;
    values: Array<{ id: string; name: string; count: number }>;
    selectedIds: string[];
    onToggle: (id: string) => void;
}) {
    return (
        <Collapsible defaultOpen>
            <div className="space-y-2">
                <CollapsibleTrigger className="flex w-full items-center justify-between py-2 text-sm font-medium hover:text-foreground transition-colors">
                    {name}
                    <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform [[data-panel-open]_&]:rotate-180" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                    <div className="space-y-2 pb-2">
                        {values.map(value => {
                            const isChecked = selectedIds.includes(value.id);
                            return (
                                <div key={value.id} className="flex items-center space-x-2">
                                    <Checkbox
                                        id={`${idPrefix}-${value.id}`}
                                        checked={isChecked}
                                        onCheckedChange={() => onToggle(value.id)}
                                    />
                                    <Label
                                        htmlFor={`${idPrefix}-${value.id}`}
                                        className="text-sm font-normal cursor-pointer flex items-center gap-2"
                                    >
                                        {value.name}
                                        <span className="text-xs text-muted-foreground">
                                            ({value.count})
                                        </span>
                                    </Label>
                                </div>
                            );
                        })}
                    </div>
                </CollapsibleContent>
            </div>
        </Collapsible>
    );
}

export function FacetFilters({ productDataPromise, optionGroups = [] }: FacetFiltersProps) {
    const t = useTranslations('Filters');
    const result = use(productDataPromise);
    const searchResult = result.data.search;
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const router = useRouter();
    const [sheetOpen, setSheetOpen] = useState(false);

    // Group facet values by facet
    interface FacetGroup {
        id: string;
        name: string;
        values: Array<{ id: string; name: string; count: number }>;
    }

    const facetGroups = searchResult.facetValues.reduce((acc: Record<string, FacetGroup>, item) => {
        const facetName = item.facetValue.facet.name;
        if (!acc[facetName]) {
            acc[facetName] = {
                id: item.facetValue.facet.id,
                name: facetName,
                values: []
            };
        }
        acc[facetName].values.push({
            id: item.facetValue.id,
            name: item.facetValue.name,
            count: item.count
        });
        return acc;
    }, {});

    const selectedFacets = searchParams.getAll('facets');
    const selectedOptions = searchParams.getAll('options');

    const toggleParam = (key: 'facets' | 'options', id: string) => {
        const params = new URLSearchParams(searchParams);
        const current = params.getAll(key);

        params.delete(key);
        const next = current.includes(id) ? current.filter(value => value !== id) : [...current, id];
        next.forEach(value => params.append(key, value));
        params.delete('page');

        router.push(`${pathname}?${params.toString()}`);
        setSheetOpen(false);
    };

    const clearFilters = () => {
        const params = new URLSearchParams(searchParams);
        params.delete('facets');
        params.delete('options');
        params.delete('page');
        router.push(`${pathname}?${params.toString()}`);
        setSheetOpen(false);
    };

    const hasActiveFilters = selectedFacets.length > 0 || selectedOptions.length > 0;

    if (Object.keys(facetGroups).length === 0 && optionGroups.length === 0) {
        return null;
    }

    const filterContentProps = {
        facetGroups,
        optionGroups,
        selectedFacets,
        selectedOptions,
        toggleFacet: (facetId: string) => toggleParam('facets', facetId),
        toggleOption: (optionId: string) => toggleParam('options', optionId),
        clearFilters,
        hasActiveFilters,
    };

    return (
        <>
            {/* Mobile: Sheet trigger */}
            <div className="lg:hidden">
                <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
                    <SheetTrigger
                        render={
                            <Button variant="outline" className="w-full">
                                <SlidersHorizontal className="mr-2 h-4 w-4" />
                                {t('filtersButton')}
                                {hasActiveFilters && (
                                    <span className="ml-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                                        {selectedFacets.length + selectedOptions.length}
                                    </span>
                                )}
                            </Button>
                        }
                    />
                    <SheetContent side="left" className="overflow-y-auto p-6">
                        <SheetHeader>
                            <SheetTitle>{t('title')}</SheetTitle>
                        </SheetHeader>
                        <div className="mt-4">
                            <FilterContent {...filterContentProps} />
                        </div>
                    </SheetContent>
                </Sheet>
            </div>

            {/* Desktop: Inline filters */}
            <div className="hidden lg:block">
                <FilterContent {...filterContentProps} />
            </div>
        </>
    );
}
