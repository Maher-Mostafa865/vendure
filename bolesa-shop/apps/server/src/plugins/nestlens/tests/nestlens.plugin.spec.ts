import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { NestLensDevPlugin } from '../nestlens.plugin';

describe('NestLens dev plugin', () => {
    it('mounts the dashboard controller at /nestlens', () => {
        const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, NestLensDevPlugin) as unknown[];
        const nestLens = imports.find(
            (item): item is { controllers: Array<new (...args: never[]) => unknown> } =>
                typeof item === 'object' && item !== null && 'controllers' in item,
        );

        assert.ok(nestLens, 'NestLensModule.forRoot() is imported');
        const dashboard = nestLens.controllers.find(controller => controller.name === 'DashboardController');
        assert.ok(dashboard, 'DashboardController is registered');
        assert.equal(Reflect.getMetadata(PATH_METADATA, dashboard), 'nestlens');
    });
});
