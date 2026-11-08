import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { binaryBuildSteps, binaryPaths, seaConfig, seaMechanism } from './build-binary-lib.mjs';

const root = join(import.meta.dirname, '..');
const paths = binaryPaths(root, process.platform);

if (!existsSync(paths.bundle)) {
  console.error(`Binary build failed: ${relative(root, paths.bundle)} is missing; run npm run build first`);
  process.exit(1);
}

const postjectCli = join(
  createRequire(import.meta.url).resolve('postject/package.json'),
  '..',
  'dist',
  'cli.js',
);

await rm(paths.workDir, { recursive: true, force: true });
await rm(paths.binDir, { recursive: true, force: true });
await mkdir(paths.workDir, { recursive: true });
await mkdir(paths.binDir, { recursive: true });
const mechanism = seaMechanism(execFileSync(process.execPath, ['--help'], { encoding: 'utf8' }));
await writeFile(paths.config, `${JSON.stringify(seaConfig(paths, mechanism), null, 2)}\n`);
if (mechanism === 'postject') {
  // The blob only runs in the Node binary of the same version that generated it.
  await copyFile(process.execPath, paths.binary);
  await chmod(paths.binary, 0o755);
}

try {
  for (const step of binaryBuildSteps(paths, process.platform, mechanism, { node: process.execPath, postjectCli })) {
    execFileSync(step.file, step.args, { stdio: 'inherit' });
  }
} catch (error) {
  console.error(`Binary build failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const { size } = await stat(paths.binary);
console.log(
  `Built ${relative(root, paths.binary)} (${(size / 1024 / 1024).toFixed(1)} MB, Node ${process.version}, ${mechanism})`,
);
