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
      rollupTypes: true,
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
