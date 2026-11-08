import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../install-host.mjs', import.meta.url));

// The script resolves dist/host/index.js relative to its own location, so a copy inside a temp
// package directory runs a fake build that prints the arguments it got and exits with a given code.
const FAKE_HOST = 'console.log(JSON.stringify(process.argv.slice(2)));\nprocess.exit(Number(process.env.FAKE_EXIT ?? 0));\n';

let packageDir: string;

async function createPackage(): Promise<void> {
  const base = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'cfe-'));
  onTestFinished(() => rm(base, { recursive: true, force: true }));
  packageDir = join(base, "it's a pkg");
  await mkdir(join(packageDir, 'scripts'), { recursive: true });
  await copyFile(script, join(packageDir, 'scripts/install-host.mjs'));
}

async function writeFakeBuild(): Promise<void> {
  await mkdir(join(packageDir, 'dist/host'), { recursive: true });
  await writeFile(join(packageDir, 'dist/host/index.js'), FAKE_HOST);
}

function runScript(args: string[] = [], env: Record<string, string> = {}) {
  return run(process.execPath, [join(packageDir, 'scripts/install-host.mjs'), ...args], { env: { ...process.env, ...env } });
}

describe('install-host', () => {
  beforeEach(createPackage);

  it.each([
    ['nothing', [], ['install']],
    ['--uninstall', ['--uninstall'], ['uninstall']],
    ['--print-paths', ['--print-paths'], ['install', '--print-paths']],
  ])('runs the built host with %s', async (_name, args, expected) => {
    await writeFakeBuild();
    const { stdout } = await runScript(args);
    expect(JSON.parse(stdout)).toEqual(expected);
  });

  it("exits with the host's exit code", async () => {
    await writeFakeBuild();
    await expect(runScript([], { FAKE_EXIT: '1' })).rejects.toMatchObject({ code: 1 });
  });

  it.each([
    ['install', [], 'Install'],
    ['uninstall', ['--uninstall'], 'Uninstall'],
  ])('fails with a clear error when the host is not built (%s)', async (_name, args, action) => {
    const hostEntry = join(packageDir, 'dist', 'host', 'index.js');
    await expect(runScript(args)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(`${action} failed: ${hostEntry} is missing. Run \`npm run build\` first.`),
    });
  });
});
