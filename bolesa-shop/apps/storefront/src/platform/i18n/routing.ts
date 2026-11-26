import {defineRouting} from 'next-intl/routing';

export const routing = defineRouting({
    locales: ['en', 'de', 'ar'],
    defaultLocale: 'en',
});

export type Locale = (typeof routing.locales)[number];

export const localeNames: Record<Locale, string> = {
    en: 'English',
    de: 'Deutsch',
    ar: 'العربية',
};

export const rtlLocales: ReadonlySet<Locale> = new Set(['ar']);

export function isRtlLocale(locale: string): boolean {
    return rtlLocales.has(locale as Locale);
}
