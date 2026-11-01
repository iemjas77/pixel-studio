import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export const aliases = {
  '@ps/raster': r('./packages/raster-ref/src/index.ts'),
  '@ps/document': r('./packages/document/src/index.ts'),
  '@ps/commands': r('./packages/commands/src/index.ts'),
  '@ps/codecs': r('./packages/codecs/src/index.ts'),
  '@ps/automation': r('./packages/automation/src/index.ts'),
};
export default defineConfig({
  resolve: { alias: aliases },
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node', testTimeout: 30000 },
});
