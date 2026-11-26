/**
 * nestlens@0.14 peers Nest <=11, so npm nests Nest 11 under apps/server.
 * Vendure 3.8 uses Nest 12 — duplicate HttpAdapterHost tokens break NestLens DI.
 * Replace nested @nestjs packages with symlinks to the workspace Nest 12 copies.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const nestedDir = path.join(root, 'apps/server/node_modules/@nestjs');
const workspaceNest = path.join(root, 'node_modules/@nestjs');
const pkgs = ['common', 'core', 'platform-express', 'graphql', 'mapped-types', 'apollo'];

if (!fs.existsSync(path.join(workspaceNest, 'core'))) {
    console.warn('[link-nestjs-for-nestlens] workspace @nestjs/core missing; skip');
    process.exit(0);
}

fs.mkdirSync(nestedDir, { recursive: true });

for (const pkg of pkgs) {
    const target = path.join(workspaceNest, pkg);
    const link = path.join(nestedDir, pkg);
    if (!fs.existsSync(target)) {
        continue;
    }
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(path.relative(nestedDir, target), link);
}

console.log('[link-nestjs-for-nestlens] apps/server @nestjs → workspace Nest 12');
