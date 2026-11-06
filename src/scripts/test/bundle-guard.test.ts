import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, type Metafile } from 'esbuild';
import { describe, expect, it, onTestFinished } from 'vitest';
import { buildTimeModules } from '../build-time-modules.mjs';
import { packageInputs } from '../bundle-guard.mjs';

const root = join(import.meta.dirname, '../..');
const anthropicTools = join(root, 'shared/anthropic-tools.ts');

function metafile(...paths: string[]): Metafile {
  return { inputs: Object.fromEntries(paths.map((path) => [path, { bytes: 1, imports: [] }])), outputs: {} };
}

async function bundleInputs(source: string, modules: string[]): Promise<Metafile> {
  const dir = await mkdtemp(join(tmpdir(), 'cfe-bundle-guard-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const entry = join(dir, 'entry.ts');
  await writeFile(entry, source);
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    logLevel: 'silent',
    nodePaths: [join(root, 'node_modules')],
    metafile: true,
    plugins: [buildTimeModules(modules)],
  });
  return result.metafile;
}

describe('packageInputs', () => {
  it('finds inputs from the package with either path separator', () => {
    const inputs = metafile(
      'extension/background.ts',
      'node_modules/zod/v4/classic/schemas.js',
      '..\\node_modules\\zod\\index.js',
      'node_modules/zod-extra/index.js',
      'node_modules/other/node_modules/zod/index.js',
      'shared/zod/index.ts',
    );
    expect(packageInputs(inputs, 'zod')).toEqual([
      'node_modules/zod/v4/classic/schemas.js',
      '..\\node_modules\\zod\\index.js',
      'node_modules/other/node_modules/zod/index.js',
    ]);
  });

  it('finds zod in a real bundle that imports it', async () => {
    const inputs = await bundleInputs('import * as z from "zod/v4";\nexport const schema = z.string();\n', []);
    expect(packageInputs(inputs, 'zod').length).toBeGreaterThan(0);
  });

  it('finds no zod when the tool definitions are inlined at build time', async () => {
    const source = `export { ANTHROPIC_TOOLS } from ${JSON.stringify(anthropicTools)};\n`;
    expect(packageInputs(await bundleInputs(source, [anthropicTools]), 'zod')).toEqual([]);
    expect(packageInputs(await bundleInputs(source, []), 'zod').length).toBeGreaterThan(0);
  });
});
