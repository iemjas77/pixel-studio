import { defineConfig } from 'vitest/config';
import { aliases } from './vitest.config';
export default defineConfig({
  resolve: { alias: aliases },
  test: { include: ['tests/e2e/**/*.test.ts'], environment: 'node', testTimeout: 120000, hookTimeout: 120000, fileParallelism: false },
});
