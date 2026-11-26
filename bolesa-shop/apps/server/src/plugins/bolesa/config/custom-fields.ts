import { CustomFieldConfig, LanguageCode, Permission } from '@vendure/core';

/**
 * Custom fields with Shop-safe visibility.
 * Internal/sensitive fields must NOT be public.
 */
export function getBolesaCustomFields(): {
    ProductVariant: CustomFieldConfig[];
    Address: CustomFieldConfig[];
    Order: CustomFieldConfig[];
    Fulfillment: CustomFieldConfig[];
} {
    return {
        ProductVariant: [
            {
                name: 'weightKg',
                type: 'float',
                public: true,
                nullable: false,
                defaultValue: 1,
                min: 0.01,
                step: 0.01,
                label: [{ languageCode: LanguageCode.en, value: 'Weight (kg)' }],
                description: [
                    {
                        languageCode: LanguageCode.en,
                        value: 'Required on every variant. Shipping rates and Bolesa fulfillment use this weight.',
                    },
                ],
                validate: value => {
                    if (value == null || !Number.isFinite(Number(value)) || Number(value) <= 0) {
                        return 'Weight (kg) is required and must be greater than 0';
                    }
                },
            },
            {
                name: 'lengthCm',
                type: 'float',
                public: true,
                nullable: true,
            },
            {
                name: 'widthCm',
                type: 'float',
                public: true,
                nullable: true,
            },
            {
                name: 'heightCm',
                type: 'float',
                public: true,
                nullable: true,
            },
            {
                name: 'bolesaCategory',
                type: 'string',
                public: true,
                nullable: true,
                options: [
                    { value: 'dry' },
                    { value: 'heavy' },
                    { value: 'cold' },
                ],
                defaultValue: 'dry',
            },
        ],
        Address: [
            {
                name: 'bolesaCityHash',
                type: 'string',
                public: true,
                nullable: true,
                label: [{ languageCode: LanguageCode.en, value: 'Bolesa city resolution hash' }],
            },
            {
                name: 'bolesaCityName',
                type: 'string',
                public: true,
                nullable: true,
            },
            {
                name: 'district',
                type: 'string',
                public: true,
                nullable: true,
            },
        ],
        Order: [
            {
                name: 'paymentPreference',
                type: 'string',
                public: true,
                nullable: true,
                options: [{ value: 'cod' }, { value: 'prepaid' }],
                label: [{ languageCode: LanguageCode.en, value: 'Payment preference (cod|prepaid)' }],
                ui: { dashboard: false },
            },
            {
                name: 'bolesaServiceSlug',
                type: 'string',
                public: false,
                nullable: true,
                label: [
                    {
                        languageCode: LanguageCode.en,
                        value: 'Carrier (checkout priority winner, or admin override for AWB)',
                    },
                ],
                ui: { dashboard: false },
            },
            {
                name: 'bolesaQuote',
                type: 'text',
                public: false,
                nullable: true,
                readonly: true,
                requiresPermission: Permission.ReadOrder,
                label: [
                    {
                        languageCode: LanguageCode.en,
                        value: 'Frozen checkout shipping snapshot (carrier, profit, charged total)',
                    },
                ],
                ui: { dashboard: false },
            },
        ],
        Fulfillment: [
            {
                name: 'bolesaTrackingNumber',
                type: 'string',
                public: false,
                nullable: true,
                requiresPermission: Permission.ReadOrder,
            },
            {
                name: 'bolesaStatus',
                type: 'string',
                public: false,
                nullable: true,
                requiresPermission: Permission.ReadOrder,
            },
            {
                name: 'bolesaSyncStatus',
                type: 'string',
                public: false,
                nullable: true,
                requiresPermission: Permission.ReadOrder,
            },
            {
                name: 'bolesaLabelAvailability',
                type: 'string',
                public: false,
                nullable: true,
                requiresPermission: Permission.ReadOrder,
                label: [
                    {
                        languageCode: LanguageCode.en,
                        value: 'Label availability (unavailable|url_present) — download not implemented until Bolesa label API',
                    },
                ],
            },
            {
                name: 'bolesaShipmentKey',
                type: 'string',
                public: false,
                nullable: true,
                internal: true,
            },
        ],
    };
}
