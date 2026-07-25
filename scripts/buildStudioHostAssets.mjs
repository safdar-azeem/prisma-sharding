#!/usr/bin/env node
/**
 * Builds the Studio host browser bundle into `dist/studio-host-assets`.
 *
 * Bundling at package build time, rather than when the CLI starts, keeps
 * `prisma-sharding-studio` fast and offline: starting Studio serves static
 * files and never invokes a bundler.
 *
 * React, `@prisma/studio-core` and the shell are bundled together so the
 * published package has no browser-side runtime resolution to do, and so a
 * consuming project's own React version can never conflict with Studio's.
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shellDirectory = path.join(packageRoot, 'src', 'studio-host', 'shell');
const outputDirectory = path.join(packageRoot, 'dist', 'studio-host-assets');

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });

await build({
  bundle: true,
  entryPoints: {
    'studio-shell': path.join(shellDirectory, 'studioShellEntry.tsx'),
  },
  outdir: outputDirectory,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  minify: true,
  sourcemap: false,
  // Studio's own bundle is built for production; matching it here avoids
  // shipping React's development warnings to users of the CLI.
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: {
    '.svg': 'dataurl',
    '.woff': 'file',
    '.woff2': 'file',
    '.png': 'dataurl',
  },
  logLevel: 'info',
});

copyFileSync(
  path.join(shellDirectory, 'studioShellDocument.html'),
  path.join(outputDirectory, 'index.html')
);

console.log(`Studio host assets written to ${path.relative(packageRoot, outputDirectory)}`);
