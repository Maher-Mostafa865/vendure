import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Link } from '@/platform/i18n/navigation';
import { query } from '@/platform/vendure/api';
import { readFragment } from '@/platform/vendure/graphql';
import {SearchProductsQuery} from '@/features/search/graphql';
import {GetCollectionProductsQuery, GetCollectionVariantOptionsQuery} from '@/features/collections/graphql';
import {ProductCardFragment} from '@/features/products/graphql';
import {
    buildOptionFilterGroups,
    matchingVariantIds,
    selectedOptionIds,
    type VariantOptionRow,
} from '@/features/collections/option-filters';
import {ProductGrid} from '@/features/products/product-grid';
import {FacetFilters} from '@/features/search/facet-filters';
import {ProductGridSkeleton} from '@/features/products/product-grid-skeleton';
import { buildSearchInput, getCurrentPage } from '@/features/search/search-helpers';
import { cacheLife, cacheTag } from 'next/cache';
import {
    Breadcrumb,
    BreadcrumbList,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { routing } from '@/platform/i18n/routing';
import {
    SITE_NAME,
    truncateDescription,
    buildCanonicalUrl,
    buildOgImages,
} from '@/config/metadata';
import {toOgLocale} from '@/platform/i18n/locale-utils';
import {getActiveCurrencyCode} from '@/features/currency/currency-server';
import {getRouteLocale} from '@/platform/i18n/server';
import {getTranslations} from 'next-intl/server';

async function getCollectionProducts(slug: string, searchParams: { [key: string]: string | string[] | undefined }, currencyCode: string) {
    'use cache';
    cacheLife('hours');

    const locale = await getRouteLocale();
    cacheTag(`collection-${slug}-${locale}-${currencyCode}`);
    cacheTag('collection');

    const input = buildSearchInput({
        searchParams,
        collectionSlug: slug,
    });
    if (selectedOptionIds(searchParams).length > 0) {
        input.groupByProduct = false;
        input.take = 100;
        input.skip = 0;
    }

    return query(SearchProductsQuery, {
        input,
    }, {languageCode: locale, currencyCode});
}

async function getCollectionVariantOptions(slug: string, currencyCode: string) {
    'use cache';
    cacheLife('hours');

    const locale = await getRouteLocale();
    cacheTag(`collection-${slug}-${locale}-${currencyCode}`);

    const result = await query(GetCollectionVariantOptionsQuery, { slug }, {languageCode: locale, currencyCode});
    const items = result.data.collection?.productVariants.items ?? [];
    return items.map((item): VariantOptionRow => ({
        variantId: item.id,
        options: item.options.map(option => ({
            id: option.id,
            name: option.name,
            groupId: option.group.id,
            groupName: option.group.name,
        })),
    }));
}

async function getCollectionMetadata(slug: string) {
    'use cache';
    cacheLife('hours');

    const locale = await getRouteLocale();
    cacheTag(`collection-meta-${slug}-${locale}`);

    return query(GetCollectionProductsQuery, {
        slug,
        input: { take: 0, collectionSlug: slug, groupByProduct: true },
    }, {languageCode: locale});
}

export async function generateMetadata({
    params,
}: PageProps<'/[locale]/collection/[slug]'>): Promise<Metadata> {
    const { slug } = await params;
    const locale = await getRouteLocale();
    const result = await getCollectionMetadata(slug);
    const collection = result.data.collection;

    const t = await getTranslations({locale, namespace: 'Collection'});

    if (!collection) {
        return {
            title: t('collectionNotFound'),
        };
    }

    const description =
        truncateDescription(collection.description) ||
        t('browseCollectionAt', {name: collection.name, siteName: SITE_NAME});
    const ogLocale = toOgLocale(locale);
    const collectionPath = `/collection/${collection.slug}`;

    return {
        title: collection.name,
        description,
        alternates: {
            canonical: buildCanonicalUrl(`/${locale}${collectionPath}`),
            languages: Object.fromEntries(
                routing.locales.map((l) => [l, buildCanonicalUrl(`/${l}${collectionPath}`)])
            ),
        },
        openGraph: {
            title: collection.name,
            description,
            type: 'website',
            locale: ogLocale,
            url: buildCanonicalUrl(`/${locale}${collectionPath}`),
            images: buildOgImages(collection.featuredAsset?.preview, collection.name),
        },
        twitter: {
            card: 'summary_large_image',
            title: collection.name,
            description,
            images: collection.featuredAsset?.preview
                ? [collection.featuredAsset.preview]
                : undefined,
        },
    };
}

export default async function CollectionPage({params, searchParams}: PageProps<'/[locale]/collection/[slug]'>) {
    const { slug } = await params;
    const searchParamsResolved = await searchParams;
    const locale = await getRouteLocale();
    const currencyCode = await getActiveCurrencyCode();
    const t = await getTranslations({locale, namespace: 'Collection'});
    const page = getCurrentPage(searchParamsResolved);

    const optionRows = await getCollectionVariantOptions(slug, currencyCode);
    const optionGroups = buildOptionFilterGroups(optionRows);
    const activeOptions = selectedOptionIds(searchParamsResolved);
    const productDataPromise = getCollectionProducts(slug, searchParamsResolved, currencyCode).then(result => {
        if (activeOptions.length === 0) {
            return result;
        }
        const allowed = new Set(matchingVariantIds(optionRows, activeOptions));
        const items = result.data.search.items.filter(item =>
            allowed.has(readFragment(ProductCardFragment, item).productVariantId),
        );
        return {
            ...result,
            data: {
                ...result.data,
                search: {
                    ...result.data.search,
                    items,
                    totalItems: items.length,
                },
            },
        };
    });
    const collectionResult = await getCollectionMetadata(slug);
    const collectionName = collectionResult.data.collection?.name ?? slug;

    return (
        <div className="container mx-auto px-4 py-8 mt-16">
            {/* Breadcrumbs */}
            <Breadcrumb className="mb-6">
                <BreadcrumbList>
                    <BreadcrumbItem>
                        <BreadcrumbLink render={<Link href="/" />}>{t('home')}</BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                        <BreadcrumbPage>{collectionName}</BreadcrumbPage>
                    </BreadcrumbItem>
                </BreadcrumbList>
            </Breadcrumb>

            {/* Collection Header */}
            <div className="mb-8">
                <h1 className="text-3xl font-bold tracking-tight">{collectionName}</h1>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
                {/* Filters Sidebar */}
                <aside className="lg:col-span-1">
                    <Suspense fallback={<div className="h-64 animate-pulse bg-muted rounded-lg" />}>
                        <FacetFilters productDataPromise={productDataPromise} optionGroups={optionGroups} />
                    </Suspense>
                </aside>

                {/* Product Grid */}
                <div className="lg:col-span-3">
                    <Suspense fallback={<ProductGridSkeleton />}>
                        <ProductGrid
                            productDataPromise={productDataPromise}
                            currentPage={page}
                            take={12}
                            showVariantNames={activeOptions.length > 0}
                        />
                    </Suspense>
                </div>
            </div>
        </div>
    );
}
