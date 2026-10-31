// Bundles Electron main + preload to CJS (electron is external).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
for (const [entry, out] of [['src/main.ts', 'main.cjs'], ['src/preload.ts', 'preload.cjs']]) {
  await build({
    entryPoints: [join(here, entry)], outfile: join(here, 'dist', out), bundle: true, platform: 'node', format: 'cjs',
    target: 'node22', external: ['electron'], sourcemap: true, logLevel: 'info',
  });
}
