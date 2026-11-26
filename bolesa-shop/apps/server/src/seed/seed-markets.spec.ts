import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeEgPhone } from './seed-markets';

describe('normalizeEgPhone', () => {
    it('converts local 0-prefix to +20', () => {
        assert.equal(normalizeEgPhone('01128783650'), '+201128783650');
    });

    it('keeps E.164 unchanged', () => {
        assert.equal(normalizeEgPhone('+201128783650'), '+201128783650');
    });
});
