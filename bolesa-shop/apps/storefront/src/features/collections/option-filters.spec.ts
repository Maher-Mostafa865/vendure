import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    buildOptionFilterGroups,
    matchingVariantIds,
    selectedOptionIds,
    type VariantOptionRow,
} from './option-filters';

const rows: VariantOptionRow[] = [
    {
        variantId: '97',
        options: [
            { id: '32', name: 'xl', groupId: '13', groupName: 'sizes' },
        ],
    },
    {
        variantId: '100',
        options: [
            { id: '32', name: 'xl', groupId: '13', groupName: 'sizes' },
            { id: '34', name: '16', groupId: '14', groupName: 'RAM' },
        ],
    },
    {
        variantId: '99',
        options: [
            { id: '31', name: 'l', groupId: '13', groupName: 'sizes' },
            { id: '35', name: '8', groupId: '14', groupName: 'RAM' },
        ],
    },
];

describe('collection option filters', () => {
    it('groups variant options and counts the variants that use each one', () => {
        assert.deepEqual(buildOptionFilterGroups(rows), [
            {
                id: '13',
                name: 'sizes',
                values: [
                    { id: '32', name: 'xl', count: 2 },
                    { id: '31', name: 'l', count: 1 },
                ],
            },
            {
                id: '14',
                name: 'RAM',
                values: [
                    { id: '34', name: '16', count: 1 },
                    { id: '35', name: '8', count: 1 },
                ],
            },
        ]);
    });

    it('matches a variant only when it has one selected option from each group', () => {
        assert.deepEqual(matchingVariantIds(rows, ['32', '34']), ['100']);
        assert.deepEqual(matchingVariantIds(rows, ['32']), ['97', '100']);
        assert.deepEqual(matchingVariantIds(rows, []), ['97', '100', '99']);
    });

    it('reads one or many option ids from the page query', () => {
        assert.deepEqual(selectedOptionIds({}), []);
        assert.deepEqual(selectedOptionIds({ options: '32' }), ['32']);
        assert.deepEqual(selectedOptionIds({ options: ['32', '34'] }), ['32', '34']);
    });
});
