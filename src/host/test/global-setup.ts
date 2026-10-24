import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    hostEntry: string;
  }
}

// Bundles the host into a temp dir instead of running scripts/build.mjs: that script replaces dist/,
// which the installed native messaging wrapper runs.
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const outDir = await mkdtemp(process.platform === 'win32' ? join(tmpdir(), 'cfe-host-') : '/tmp/cfe-host-');
  const hostEntry = join(outDir, 'index.js');
  await build({
    entryPoints: [fileURLToPath(new URL('../index.ts', import.meta.url))],
    outfile: hostEntry,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: `node${process.versions.node.split('.')[0]}`,
    logLevel: 'warning',
  });
  project.provide('hostEntry', hostEntry);
  return () => rm(outDir, { recursive: true, force: true });
}
