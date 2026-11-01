import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  root: r('.'),
  base: './',
  plugins: [react()],
  resolve: { alias: {
    '@ps/raster': r('../../packages/raster-ref/src/index.ts'),
    '@ps/document': r('../../packages/document/src/index.ts'),
    '@ps/commands': r('../../packages/commands/src/index.ts'),
    '@ps/codecs': r('../../packages/codecs/src/index.ts'),
    '@ps/automation': r('../../packages/automation/src/index.ts'),
  } },
  build: { outDir: r('./dist'), emptyOutDir: true, sourcemap: true, target: 'chrome130' },
});
