// Lists direct + transitive production/dev package licenses from node_modules.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const root = new URL('../node_modules/', import.meta.url).pathname;
const rows = [];
function scan(dir, scope) {
  for (const n of readdirSync(dir)) {
    if (n.startsWith('.')) continue;
    const p = join(dir, n);
    if (n.startsWith('@') && !existsSync(join(p, 'package.json'))) { scan(p, n); continue; }
    const pj = join(p, 'package.json');
    if (!existsSync(pj)) continue;
    const j = JSON.parse(readFileSync(pj, 'utf8'));
    const lic = typeof j.license === 'string' ? j.license : j.license?.type ?? JSON.stringify(j.licenses ?? 'UNKNOWN');
    rows.push([j.name ?? (scope ? `${scope}/${n}` : n), j.version, lic]);
  }
}
scan(root);
const counts = {};
for (const r of rows) counts[r[2]] = (counts[r[2]] ?? 0) + 1;
console.log(process.argv.includes('--all') ? rows.map(r => r.join('\t')).join('\n') : '');
console.log('License summary:', JSON.stringify(counts, null, 1));
