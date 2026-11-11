import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const listed = new Set([...readFileSync(join(root, 'sw.js'), 'utf8').matchAll(/'(\.\/[^']*)'/g)].map((m) => m[1]));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const appFiles = ['css', 'js', 'icons', 'fonts']
  .filter((d) => existsSync(join(root, d)))
  .flatMap((d) => walk(join(root, d)))
  .filter((p) => /\.(css|js|svg|png|woff2)$/.test(p))
  .map((p) => './' + relative(root, p).split(sep).join('/'));

test('service worker precaches every app asset', () => {
  const missing = appFiles.filter((f) => !listed.has(f));
  assert.deepEqual(missing, [], `add to ASSETS in sw.js: ${missing.join(', ')}`);
});

test('every precached path exists', () => {
  const absent = [...listed].filter((f) => f !== './' && !existsSync(join(root, f)));
  assert.deepEqual(absent, []);
});
