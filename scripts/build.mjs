#!/usr/bin/env node
// Bundles the noVNC adapter page into a single ESM file served by the daemon.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(root, 'web/dist'), { recursive: true });

await build({
  entryPoints: [path.join(root, 'web/console.js')],
  outfile: path.join(root, 'web/dist/console.bundle.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

console.log('built web/dist/console.bundle.js');
