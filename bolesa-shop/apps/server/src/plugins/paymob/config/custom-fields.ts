import { CustomFieldConfig, LanguageCode } from '@vendure/core';

export function getPaymobCustomFields(): { Channel: CustomFieldConfig[] } {
    return {
        Channel: [
            {
                name: 'marketCountry',
                type: 'string',
                public: true,
                nullable: false,
                defaultValue: 'EG',
                options: [{ value: 'EG' }, { value: 'SA' }],
                label: [
                    { languageCode: LanguageCode.en, value: 'Market country' },
                    { languageCode: LanguageCode.ar, value: 'دولة السوق' },
                ],
                description: [
                    {
                        languageCode: LanguageCode.en,
                        value: 'EG or SA. Used by Paymob credentials and Bolesa shipping eligibility.',
                    },
                ],
            },
        ],
    };
}
