import { existsSync, readdirSync, statSync } from 'node:fs';
import { cp, readFile, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { build } from 'esbuild';
import { buildTimeModules } from './build-time-modules.mjs';
import { packageInputs } from './bundle-guard.mjs';

const root = join(import.meta.dirname, '..');
const srcDir = join(root, 'extension');
const outDir = join(root, 'dist/extension');
const hostSrcDir = join(root, 'host');
const hostOutDir = join(root, 'dist/host');
// Tool definitions reach the extension as JSON, without zod.
const extensionBuildTimeModules = [join(root, 'shared/anthropic-tools.ts')];

const entryPoints = [
  'background.ts',
  'permissions/prompt.ts',
  'options/options.ts',
  'sidebar/sidebar.ts',
  'page/read-page.ts',
  'page/page-text.ts',
  'page/console-capture.ts',
].map((file) => join(srcDir, file));
const manifest = join(srcDir, 'manifest.json');
const hostEntryPoint = join(hostSrcDir, 'index.ts');

const missing = [manifest, ...entryPoints, hostEntryPoint].filter((file) => !existsSync(file));
if (missing.length > 0) {
  console.error('Build failed: missing sources:');
  for (const file of missing) console.error(`  ${relative(root, file)}`);
  process.exit(1);
}

const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const nodeMajor = /\d+/.exec(packageJson.engines.node)?.[0];
if (!nodeMajor) {
  console.error(`Build failed: cannot read a Node version from engines.node "${packageJson.engines.node}"`);
  process.exit(1);
}

await rm(outDir, { recursive: true, force: true });
await rm(hostOutDir, { recursive: true, force: true });

try {
  const extensionBuild = await build({
    entryPoints,
    outbase: srcDir,
    outdir: outDir,
    bundle: true,
    // Content scripts cannot be ES modules, so every entry point is an IIFE.
    format: 'iife',
    platform: 'browser',
    target: 'firefox158',
    logLevel: 'warning',
    plugins: [buildTimeModules(extensionBuildTimeModules)],
    metafile: true,
  });
  const zodInputs = packageInputs(extensionBuild.metafile, 'zod');
  if (zodInputs.length > 0) {
    console.error('Build failed: the extension bundle includes zod, which must stay in the host:');
    for (const input of zodInputs.slice(0, 5)) console.error(`  ${input}`);
    process.exit(1);
  }
  /** @type {import('esbuild').BuildOptions} */
  const hostOptions = {
    entryPoints: [hostEntryPoint],
    bundle: true,
    platform: 'node',
    target: `node${nodeMajor}`,
    logLevel: 'warning',
  };
  await build({ ...hostOptions, outfile: join(hostOutDir, 'index.js'), format: 'esm' });
  // A Node single executable runs only a CommonJS main script (npm run build:binary).
  await build({ ...hostOptions, outfile: join(hostOutDir, 'sea.cjs'), format: 'cjs' });
} catch {
  process.exit(1);
}

/** @param {string} path */
const isAsset = (path) => !path.endsWith('.ts') && !path.endsWith('tsconfig.json');

/** @param {string} dir */
const containsAsset = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true }).some((entry) => entry.isFile() && isAsset(entry.name));

// cp() would otherwise create directories such as tools/ that hold only TypeScript sources.
await cp(srcDir, outDir, {
  recursive: true,
  filter: (source) => (statSync(source).isDirectory() ? containsAsset(source) : isAsset(source)),
});

console.log(`Built extension into ${relative(root, outDir)} and host into ${relative(root, hostOutDir)}`);
