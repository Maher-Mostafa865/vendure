import { vendureDashboardPlugin } from '@vendure/dashboard/vite';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { defineConfig } from 'vite';

const lodashEs = resolve(__dirname, '../../node_modules/lodash-es');

export default defineConfig({
    base: '/dashboard',
    build: {
        outDir: join(__dirname, 'dist/dashboard'),
    },
    // recharts does `import get from 'lodash/get'` (ESM default). Plain lodash is
    // CJS and has no default export when Vite serves it via @fs — remap to lodash-es.
    resolve: {
        alias: [
            { find: '@/gql', replacement: resolve(__dirname, './src/gql/graphql.ts') },
            { find: /^lodash$/, replacement: lodashEs },
            { find: /^lodash\/(.*)$/, replacement: `${lodashEs}/$1.js` },
        ],
    },
    optimizeDeps: {
        include: [
            'lodash-es',
            'recharts',
        ],
    },
    plugins: [
        vendureDashboardPlugin({
            // The vendureDashboardPlugin will scan your configuration in order
            // to find any plugins which have dashboard extensions, as well as
            // to introspect the GraphQL schema based on any API extensions
            // and custom fields that are configured.
            vendureConfigPath: pathToFileURL('./src/vendure-config.ts'),
            // Points to the location of your Vendure server.
            // In production, 'auto' lets the dashboard derive the API URL from the
            // server that serves it. In development, we use explicit defaults so that
            // the Vite dev server can reach the Vendure backend.
            api: process.env.NODE_ENV === 'production'
                ? { host: 'auto', port: 'auto' }
                : { host: 'http://localhost', port: 3000 },
            // When you start the Vite server, your Admin API schema will
            // be introspected and the types will be generated in this location.
            // These types can be used in your dashboard extensions to provide
            // type safety when writing queries and mutations.
            gqlOutputPath: './src/gql',
        }),
    ],
});
