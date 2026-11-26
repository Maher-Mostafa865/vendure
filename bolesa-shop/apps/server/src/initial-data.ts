import { LanguageCode } from '@vendure/common/lib/generated-types';
import { dummyPaymentHandler, InitialData } from '@vendure/core';

/**
 * Minimal InitialData for local populate (zones, tax, default shipping/payment).
 * Catalog products come from products.csv via populate().
 */
export const initialData: InitialData = {
    defaultLanguage: LanguageCode.en,
    defaultZone: 'Europe',
    roles: [],
    taxRates: [
        { name: 'Standard Tax', percentage: 20 },
        { name: 'Reduced Tax', percentage: 10 },
        { name: 'Zero Tax', percentage: 0 },
    ],
    shippingMethods: [
        { name: 'Standard Shipping', price: 500 },
        { name: 'Express Shipping', price: 1000 },
    ],
    paymentMethods: [
        {
            name: 'Standard Payment',
            handler: {
                code: dummyPaymentHandler.code,
                arguments: [{ name: 'automaticSettle', value: 'false' }],
            },
        },
    ],
    collections: [
        {
            name: 'Electronics',
            filters: [
                {
                    code: 'facet-value-filter',
                    args: { facetValueNames: ['Electronics'], containsAny: false },
                },
            ],
        },
        {
            name: 'Home & Garden',
            filters: [
                {
                    code: 'facet-value-filter',
                    args: { facetValueNames: ['Home & Garden'], containsAny: false },
                },
            ],
        },
    ],
    countries: [
        { name: 'Egypt', code: 'EG', zone: 'Africa' },
        { name: 'United States of America', code: 'US', zone: 'Americas' },
        { name: 'United Kingdom', code: 'GB', zone: 'Europe' },
        { name: 'Germany', code: 'DE', zone: 'Europe' },
    ],
};
