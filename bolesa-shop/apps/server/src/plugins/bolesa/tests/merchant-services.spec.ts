import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { merchantServiceSlugs, openShipmentImageError, resolveAwbServiceSlug } from '../util/merchant-services';

describe('merchant service selection', () => {
    it('keeps the customer choice and does not substitute a disabled slug', () => {
        const chosen = resolveAwbServiceSlug({
            customerSlug: 'bosta',
            defaultSlug: 'aramex',
            enabledSlugs: ['aramex'],
        });
        assert.deepEqual(chosen, {
            error: 'Selected service bosta is not enabled for this channel.',
        });
    });

    it('does not let a stored quote replace the merchant default', () => {
        const chosen = resolveAwbServiceSlug({
            customerSlug: '',
            quoteSlug: 'jt',
            defaultSlug: 'aramex',
            enabledSlugs: ['aramex', 'jt'],
        });
        assert.deepEqual(chosen, { slug: 'aramex' });
    });

    it('uses the customer slug for the AWB even when the quote names another service', () => {
        const chosen = resolveAwbServiceSlug({
            customerSlug: 'speedaf',
            quoteSlug: 'jt',
            defaultSlug: 'aramex',
            enabledSlugs: [],
        });
        assert.deepEqual(chosen, { slug: 'speedaf' });
    });

    it('requires a public photo before an openable Bosta shipment is sent', () => {
        assert.match(
            openShipmentImageError(true, 'bosta_egy_dom_dry_std_dlv') ?? '',
            /allow_open_images_required/,
        );
        assert.equal(openShipmentImageError(false, 'bosta_egy_dom_dry_std_dlv'), undefined);
        assert.equal(openShipmentImageError(true, 'aramex_egy_dom_dry_stddlv_stdwt'), undefined);
    });

    it('uses the default only when the customer did not choose', () => {
        const chosen = resolveAwbServiceSlug({
            customerSlug: '',
            defaultSlug: 'aramex',
            enabledSlugs: ['aramex', 'speedaf'],
        });
        assert.deepEqual(chosen, { slug: 'aramex' });
    });

    it('does not invent a slug when automatic creation has no usable default', () => {
        const chosen = resolveAwbServiceSlug({
            customerSlug: null,
            defaultSlug: 'auto',
            quoteSlug: 'default',
            enabledSlugs: [],
        });
        assert.equal('error' in chosen, true);
    });

    it('normalizes the enabled list', () => {
        assert.deepEqual(merchantServiceSlugs([' aramex ', '', 'aramex', 1]), ['aramex']);
    });
});
