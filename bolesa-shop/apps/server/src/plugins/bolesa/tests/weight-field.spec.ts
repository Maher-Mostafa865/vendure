import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getBolesaCustomFields } from '../config/custom-fields';

describe('variant weight custom field', () => {
    const weight = getBolesaCustomFields().ProductVariant.find(field => field.name === 'weightKg');

    it('requires a positive weight on every variant', () => {
        assert.ok(weight);
        assert.equal(weight.type, 'float');
        assert.equal(weight.nullable, false);
        assert.equal(weight.defaultValue, 1);
        assert.equal(weight.min, 0.01);
    });

    it('rejects a missing or non-positive weight', async () => {
        assert.ok(weight && 'validate' in weight && weight.validate);
        const validate = weight.validate!;
        assert.equal(await validate(undefined as any, {} as any, {} as any), 'Weight (kg) is required and must be greater than 0');
        assert.equal(await validate(0, {} as any, {} as any), 'Weight (kg) is required and must be greater than 0');
        assert.equal(await validate(1, {} as any, {} as any), undefined);
    });
});
