import { existsSync } from 'node:fs';
import { cp, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { build } from 'esbuild';

const root = join(import.meta.dirname, '..');
const srcDir = join(root, 'extension');
const outDir = join(root, 'dist/extension');

const entryPoints = ['background.ts'].map((file) => join(srcDir, file));
const manifest = join(srcDir, 'manifest.json');

const missing = [manifest, ...entryPoints].filter((file) => !existsSync(file));
if (missing.length > 0) {
  console.error('Build failed: missing extension sources:');
  for (const file of missing) console.error(`  ${relative(root, file)}`);
  process.exit(1);
}

await rm(outDir, { recursive: true, force: true });

try {
  await build({
    entryPoints,
    outbase: srcDir,
    outdir: outDir,
    bundle: true,
    // Content scripts cannot be ES modules, so every entry point is an IIFE.
    format: 'iife',
    platform: 'browser',
    target: 'firefox158',
    logLevel: 'warning',
  });
} catch {
  process.exit(1);
}

await cp(srcDir, outDir, {
  recursive: true,
  filter: (source) => !source.endsWith('.ts'),
});

console.log(`Built extension into ${relative(root, outDir)}`);
