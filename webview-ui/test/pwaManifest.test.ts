/**
 * Pixel Kaisha PWA: the web-app manifest is valid JSON with the Pixel Kaisha
 * name, installable icons (192 + 512 + maskable) whose files exist and match
 * their declared sizes, and index.html points at it with the same title.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PNG } from 'pngjs';
import { test } from 'vitest';

import { shortTitle } from '../src/cloud/cloudSummary.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');

interface Manifest {
  name: string;
  short_name: string;
  start_url: string;
  display: string;
  icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
}

const manifest = JSON.parse(
  readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8'),
) as Manifest;

test('manifest names the app Pixel Kaisha and is installable', () => {
  assert.equal(manifest.name, 'Pixel Kaisha');
  assert.equal(manifest.short_name, 'Pixel Kaisha');
  assert.ok(manifest.short_name.length <= 12, 'short_name fits a launcher label');
  assert.ok(manifest.start_url);
  assert.equal(manifest.display, 'standalone');
});

test('manifest icons exist, are PNGs of the declared size, incl. 192, 512 and maskable', () => {
  const sizes = new Set<string>();
  for (const icon of manifest.icons) {
    assert.ok(!icon.src.startsWith('/'), `icon src must be relative: ${icon.src}`);
    const file = path.join(publicDir, icon.src.split('?')[0]);
    const png = PNG.sync.read(readFileSync(file));
    assert.equal(`${png.width}x${png.height}`, icon.sizes, icon.src);
    assert.equal(icon.type, 'image/png');
    sizes.add(icon.sizes);
  }
  assert.ok(sizes.has('192x192'));
  assert.ok(sizes.has('512x512'));
  assert.ok(manifest.icons.some((i) => i.purpose?.includes('maskable')));
});

test('index.html links the manifest and carries the Pixel Kaisha title', () => {
  const html = readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /<link rel="manifest" href="[^"]*manifest\.webmanifest"/);
  assert.match(html, /<title>Pixel Kaisha<\/title>/);
  assert.match(html, /apple-mobile-web-app-title" content="Pixel Kaisha"/);
});

test('shortTitle trims long cloud task titles for the cover screen', () => {
  assert.equal(shortTitle('Calculadora', 14), 'Calculadora');
  assert.equal(shortTitle('Calculadora simples', 14), 'Calculadora s…');
});
