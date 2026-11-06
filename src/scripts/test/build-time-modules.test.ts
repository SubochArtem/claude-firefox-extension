import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it, onTestFinished } from 'vitest';
import { ANTHROPIC_TOOLS } from '../../shared/anthropic-tools';
import { buildTimeModules } from '../build-time-modules.mjs';

const anthropicTools = join(import.meta.dirname, '../../shared/anthropic-tools.ts');

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cfe-build-time-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function bundle(entry: string, modules: string[]): Promise<string> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    logLevel: 'silent',
    plugins: [buildTimeModules(modules)],
  });
  const text = result.outputFiles[0]?.text;
  if (text === undefined) throw new Error('no output');
  return text;
}

async function importCode(code: string): Promise<Record<string, unknown>> {
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

describe('buildTimeModules', () => {
  it('inlines the Anthropic tool definitions without bundling zod', async () => {
    const dir = await tempDir();
    const entry = join(dir, 'entry.ts');
    await writeFile(entry, `export { ANTHROPIC_TOOLS } from ${JSON.stringify(anthropicTools)};\n`);
    const code = await bundle(entry, [anthropicTools]);
    expect(code).not.toMatch(/zod|toJSONSchema/i);
    expect((await importCode(code)).ANTHROPIC_TOOLS).toEqual(ANTHROPIC_TOOLS);
  });

  it('leaves modules that are not listed alone', async () => {
    const dir = await tempDir();
    const entry = join(dir, 'entry.ts');
    await writeFile(entry, `export { ANTHROPIC_TOOLS } from ${JSON.stringify(anthropicTools)};\n`);
    expect(await bundle(entry, [])).toMatch(/toJSONSchema/);
  });

  it('inlines every export of a listed module', async () => {
    const dir = await tempDir();
    const module = join(dir, 'values.ts');
    await writeFile(module, 'export const list = [1, 2].map((n) => n * 2);\nexport const label: string = "x".repeat(3);\n');
    const entry = join(dir, 'entry.ts');
    await writeFile(entry, 'export { list, label } from "./values";\n');
    const code = await bundle(entry, [module]);
    expect(code).not.toMatch(/repeat|map\(/);
    expect(await importCode(code)).toMatchObject({ list: [2, 4], label: 'xxx' });
  });

  it('matches a module listed through a symlinked directory', async (context) => {
    const dir = await tempDir();
    const real = join(dir, 'real');
    await mkdir(real);
    const linked = join(dir, 'linked');
    try {
      await symlink(real, linked, 'junction');
    } catch {
      context.skip();
    }
    await writeFile(join(real, 'values.ts'), 'export const list = [1, 2].map((n) => n * 2);\n');
    const entry = join(real, 'entry.ts');
    await writeFile(entry, 'export { list } from "./values";\n');
    const code = await bundle(entry, [join(linked, 'values.ts')]);
    expect(code).not.toMatch(/map\(/);
    expect(await importCode(code)).toMatchObject({ list: [2, 4] });
  });

  it('refuses exports that are not plain JSON data', async () => {
    const dir = await tempDir();
    const module = join(dir, 'values.ts');
    await writeFile(module, 'export const run = () => 1;\n');
    const entry = join(dir, 'entry.ts');
    await writeFile(entry, 'export { run } from "./values";\n');
    await expect(bundle(entry, [module])).rejects.toThrow(/run.*not plain JSON data/s);
  });
});
