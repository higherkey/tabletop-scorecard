import { cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'dist', 'tabletop-scorecard');
const items = ['index.html', 'sw.js', 'manifest.webmanifest', 'css', 'js', 'icons'];

rmSync(resolve(root, 'dist'), { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const item of items) {
  const src = resolve(root, item);
  if (!existsSync(src)) {
    console.warn(`skip missing: ${item}`);
    continue;
  }
  cpSync(src, resolve(out, item), { recursive: true });
}
console.log(`built ${out}`);
