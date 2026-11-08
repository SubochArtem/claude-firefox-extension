import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { CHECKSUM_FILE, releaseAssetNames, targetFor } from '../release-lib.mjs';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../release.mjs', import.meta.url));
const packageJson = fileURLToPath(new URL('../../package.json', import.meta.url));

let dir: string;

async function packageVersion(): Promise<string> {
  return (JSON.parse(await readFile(packageJson, 'utf8')) as { version: string }).version;
}

function runScript(args: string[]) {
  return run(process.execPath, [script, ...args]);
}

async function failure(args: string[]): Promise<{ code: unknown; stderr: string }> {
  try {
    await runScript(args);
  } catch (error) {
    const { code, stderr } = error as { code: unknown; stderr: string };
    return { code, stderr };
  }
  throw new Error(`release.mjs ${args.join(' ')} succeeded`);
}

const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cfe-release-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
});

describe('release.mjs check-tag', () => {
  it('prints the version of the tag matching package.json and the extension manifest', async () => {
    const version = await packageVersion();
    const { stdout } = await runScript(['check-tag', `v${version}`]);
    expect(stdout).toBe(`${version}\n`);
  });

  it('fails for a tag of another version', async () => {
    const { code, stderr } = await failure(['check-tag', 'v999.0.0']);
    expect(code).toBe(1);
    expect(stderr).toContain('Tag v999.0.0 does not match the version');
  });
});

describe('release.mjs stage-binary', () => {
  it('refuses a target that is not this machine', async () => {
    const other = targetFor(process.platform, process.arch) === 'linux-x64' ? 'windows-x64' : 'linux-x64';
    const { code, stderr } = await failure(['stage-binary', other, dir]);
    expect(code).toBe(1);
    expect(stderr).toMatch(new RegExp(`This machine builds \\S+, not ${other}`));
  });

  it('names the missing target when the target argument is empty', async () => {
    const { code, stderr } = await failure(['stage-binary', '', dir]);
    expect(code).toBe(1);
    expect(stderr).toContain('stage-binary: the target argument is empty; expected one of linux-x64,');
  });

  it('names the missing directory when the directory argument is empty', async () => {
    const { code, stderr } = await failure(['stage-binary', 'linux-x64', '']);
    expect(code).toBe(1);
    expect(stderr).toContain('stage-binary: the directory argument is empty');
  });

  it('rejects an unknown target before comparing it with this machine', async () => {
    const { code, stderr } = await failure(['stage-binary', 'plan9-mips', dir]);
    expect(code).toBe(1);
    expect(stderr).toContain('stage-binary: unknown target "plan9-mips"; expected one of linux-x64,');
  });
});

describe('release.mjs checksums', () => {
  async function writeAssets(): Promise<Map<string, string>> {
    const contents = new Map<string, string>();
    for (const name of releaseAssetNames(await packageVersion())) {
      const content = `content of ${name}\n`;
      contents.set(name, content);
      await writeFile(join(dir, name), content);
    }
    return contents;
  }

  function expectedSums(contents: Map<string, string>): string {
    return [...contents.keys()]
      .sort()
      .map((name) => `${sha256(contents.get(name) ?? '')}  ${name}\n`)
      .join('');
  }

  it('hashes the release assets and writes SHA256SUMS', async () => {
    const contents = await writeAssets();
    const { stdout } = await runScript(['checksums', dir]);
    expect(stdout).toBe(expectedSums(contents));
    expect(await readFile(join(dir, CHECKSUM_FILE), 'utf8')).toBe(expectedSums(contents));
  });

  it('leaves an existing SHA256SUMS out of the assets on a re-run', async () => {
    const contents = await writeAssets();
    await writeFile(join(dir, CHECKSUM_FILE), 'stale\n');
    await runScript(['checksums', dir]);
    expect(await readFile(join(dir, CHECKSUM_FILE), 'utf8')).toBe(expectedSums(contents));
  });

  it('fails when an asset is missing', async () => {
    const contents = await writeAssets();
    const [first] = contents.keys();
    await rm(join(dir, first ?? ''));
    const { code, stderr } = await failure(['checksums', dir]);
    expect(code).toBe(1);
    expect(stderr).toContain(`Release assets do not match: missing ${first}`);
  });
});
