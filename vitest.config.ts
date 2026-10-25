import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const sharedEntry = fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@pm-studio/shared': sharedEntry,
    },
  },
  test: {
    include: ['packages/*/tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/**/*.d.ts', 'packages/*/src/**/index.ts'],
    },
  },
});
