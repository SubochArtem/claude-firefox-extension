import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HOST_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

function moduleImports(file: string, seen = new Map<string, string[]>()): Map<string, string[]> {
  if (seen.has(file)) return seen;
  const specifiers = [...readFileSync(file, 'utf8').matchAll(SPECIFIER)].map((match) => match[1] ?? '');
  seen.set(file, specifiers);
  for (const specifier of specifiers) {
    if (specifier.startsWith('.')) moduleImports(resolve(dirname(file), `${specifier}.ts`), seen);
  }
  return seen;
}

function isNodeModule(specifier: string): boolean {
  return specifier.startsWith('node:') || builtinModules.includes(specifier.split('/')[0] ?? '');
}

// The extension bundles remote-value-format for the eval fallback, so it must stay free of Node modules.
describe('remote-value-format imports', () => {
  it('imports no Node module, directly or through local modules', () => {
    const imports = moduleImports(resolve(HOST_DIR, 'remote-value-format.ts'));
    expect(imports.size).toBeGreaterThan(1);
    const nodeImports = [...imports].flatMap(([file, specifiers]) => specifiers.filter(isNodeModule).map((specifier) => `${file}: ${specifier}`));
    expect(nodeImports).toEqual([]);
  });

  it('detects Node imports', () => {
    expect(isNodeModule('node:fs')).toBe(true);
    expect(isNodeModule('crypto')).toBe(true);
    expect(isNodeModule('fs/promises')).toBe(true);
    expect(isNodeModule('./protocol')).toBe(false);
  });
});
