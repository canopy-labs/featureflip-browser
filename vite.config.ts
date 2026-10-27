import { defineConfig } from 'vite';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import dts from 'vite-plugin-dts';

// `npm version` (publish-npm.yml) bumps package.json only, so package.json is
// the single source of the SDK's version. Inlining it here keeps the
// X-Featureflip-SDK header from drifting the way a literal would (#2141).
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as { version: string };

export default defineConfig({
  define: {
    __SDK_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    dts({
      // bundleTypes rolls the declarations up with api-extractor. unplugin-dts
      // hands it the workspace's `typescript` as its compiler, but that is TS7,
      // which ships no lib .d.ts files, so no global resolves ("Unable to follow
      // symbol for Promise"). Unsetting the folder makes api-extractor fall back
      // to the TypeScript it bundles.
      bundleTypes: { invokeOptions: { typescriptCompilerFolder: undefined } },
      outDir: 'dist',
      exclude: ['src/**/__tests__/**', 'src/**/__bench__/**'],
    }),
  ],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es', 'cjs'],
      fileName: (format) => {
        const ext = format === 'es' ? 'js' : 'cjs';
        return `index.${ext}`;
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
  },
});
