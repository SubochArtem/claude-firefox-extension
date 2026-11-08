import { describe, expect, it } from 'vitest';
import {
  binaryAssetName,
  CHECKSUM_FILE,
  checksumFile,
  checkReleaseAssets,
  extensionAssetName,
  releaseAssetNames,
  releaseNotes,
  releaseVersion,
  TARGETS,
  targetFor,
} from '../release-lib.mjs';

const sha = (digit: string) => digit.repeat(64);

describe('TARGETS', () => {
  it('covers Linux, macOS and Windows on their release architectures', () => {
    expect(TARGETS.map((target) => target.id)).toEqual([
      'linux-x64',
      'linux-arm64',
      'macos-arm64',
      'macos-x64',
      'windows-x64',
    ]);
  });
});

describe('targetFor', () => {
  it('maps a Node platform and architecture to a release target', () => {
    expect(targetFor('linux', 'x64')).toBe('linux-x64');
    expect(targetFor('linux', 'arm64')).toBe('linux-arm64');
    expect(targetFor('darwin', 'arm64')).toBe('macos-arm64');
    expect(targetFor('darwin', 'x64')).toBe('macos-x64');
    expect(targetFor('win32', 'x64')).toBe('windows-x64');
  });

  it('returns undefined for combinations without a release binary', () => {
    expect(targetFor('win32', 'arm64')).toBeUndefined();
    expect(targetFor('freebsd', 'x64')).toBeUndefined();
    expect(targetFor('linux', 'ia32')).toBeUndefined();
  });
});

describe('binaryAssetName', () => {
  it('names binaries by OS and architecture, with .exe on Windows only', () => {
    expect(binaryAssetName('linux-x64')).toBe('claude-firefox-host-linux-x64');
    expect(binaryAssetName('linux-arm64')).toBe('claude-firefox-host-linux-arm64');
    expect(binaryAssetName('macos-arm64')).toBe('claude-firefox-host-macos-arm64');
    expect(binaryAssetName('macos-x64')).toBe('claude-firefox-host-macos-x64');
    expect(binaryAssetName('windows-x64')).toBe('claude-firefox-host-windows-x64.exe');
  });

  it('refuses an unknown target', () => {
    expect(() => binaryAssetName('windows-arm64')).toThrow('Unknown release target windows-arm64');
  });
});

describe('extensionAssetName', () => {
  it('names the extension package with the version', () => {
    expect(extensionAssetName('1.2.3')).toBe('claude-firefox-extension-1.2.3.xpi');
  });
});

describe('releaseAssetNames', () => {
  it('lists every binary and the extension package, sorted', () => {
    expect(releaseAssetNames('0.1.0')).toEqual([
      'claude-firefox-extension-0.1.0.xpi',
      'claude-firefox-host-linux-arm64',
      'claude-firefox-host-linux-x64',
      'claude-firefox-host-macos-arm64',
      'claude-firefox-host-macos-x64',
      'claude-firefox-host-windows-x64.exe',
    ]);
  });
});

describe('releaseVersion', () => {
  const versions = { packageVersion: '0.2.0', manifestVersion: '0.2.0' };

  it('returns the version when the tag matches package.json and the extension manifest', () => {
    expect(releaseVersion('v0.2.0', versions)).toBe('0.2.0');
  });

  it('refuses a tag that is not vX.Y.Z', () => {
    for (const tag of ['0.2.0', 'v0.2', 'v0.2.0-beta.1', 'v0.2.0 ', 'release-0.2.0', 'v01.2.0']) {
      expect(() => releaseVersion(tag, versions)).toThrow(`Tag ${JSON.stringify(tag)} is not of the form vX.Y.Z`);
    }
  });

  it('refuses a tag that differs from package.json', () => {
    expect(() => releaseVersion('v0.3.0', versions)).toThrow(
      'Tag v0.3.0 does not match the version 0.2.0 in src/package.json',
    );
  });

  it('refuses a manifest version that differs from package.json', () => {
    expect(() => releaseVersion('v0.2.0', { packageVersion: '0.2.0', manifestVersion: '0.1.0' })).toThrow(
      'Tag v0.2.0 does not match the version 0.1.0 in src/extension/manifest.json',
    );
  });
});

describe('checkReleaseAssets', () => {
  it('accepts exactly the expected assets in any order', () => {
    expect(() => checkReleaseAssets([...releaseAssetNames('0.1.0')].reverse(), '0.1.0')).not.toThrow();
  });

  it('reports missing and unexpected files', () => {
    const files = releaseAssetNames('0.1.0').filter((name) => name !== 'claude-firefox-host-macos-x64');
    expect(() => checkReleaseAssets([...files, 'notes.txt'], '0.1.0')).toThrow(
      'Release assets do not match: missing claude-firefox-host-macos-x64; unexpected notes.txt',
    );
  });

  it('refuses an extension package of another version', () => {
    const files = releaseAssetNames('0.1.0').map((name) => name.replace('0.1.0', '0.0.9'));
    expect(() => checkReleaseAssets(files, '0.1.0')).toThrow(
      'missing claude-firefox-extension-0.1.0.xpi; unexpected claude-firefox-extension-0.0.9.xpi',
    );
  });
});

describe('checksumFile', () => {
  it('writes sha256sum lines sorted by file name', () => {
    expect(CHECKSUM_FILE).toBe('SHA256SUMS');
    expect(
      checksumFile([
        { name: 'claude-firefox-host-windows-x64.exe', sha256: sha('b') },
        { name: 'claude-firefox-extension-0.1.0.xpi', sha256: sha('a') },
      ]),
    ).toBe(`${sha('a')}  claude-firefox-extension-0.1.0.xpi\n${sha('b')}  claude-firefox-host-windows-x64.exe\n`);
  });

  it('refuses digests that are not lowercase SHA-256 hex', () => {
    expect(() => checksumFile([{ name: 'a', sha256: 'A'.repeat(64) }])).toThrow('Invalid SHA-256 digest for a');
    expect(() => checksumFile([{ name: 'a', sha256: sha('a').slice(1) }])).toThrow('Invalid SHA-256 digest for a');
  });

  it('refuses names that would break the line format', () => {
    for (const name of ['', 'dir/file', 'dir\\file', 'a\nb', 'a b']) {
      expect(() => checksumFile([{ name, sha256: sha('a') }])).toThrow(
        `Invalid release asset name ${JSON.stringify(name)}`,
      );
    }
  });
});

describe('releaseNotes', () => {
  const notes = releaseNotes('0.1.0', 'owner/repo');

  it('links the install guide of the tagged version and the checksum file', () => {
    expect(notes).toContain('https://github.com/owner/repo/blob/v0.1.0/docs/install.md');
    expect(notes).toContain('SHA256SUMS');
  });

  it('refuses a repository that is not owner/name', () => {
    for (const repository of ['', 'owner', 'owner/repo/extra', 'owner/re po']) {
      expect(() => releaseNotes('0.1.0', repository)).toThrow(`Invalid repository ${JSON.stringify(repository)}`);
    }
  });

  it('lists every binary', () => {
    for (const target of TARGETS) expect(notes).toContain(binaryAssetName(target.id));
  });

  it('says the extension package is unsigned and how to load it until signing lands', () => {
    expect(notes).toContain('claude-firefox-extension-0.1.0.xpi');
    expect(notes).toMatch(/not signed/);
    expect(notes).toContain('feature/amo-signing');
    expect(notes).toContain('Load Temporary Add-on');
    expect(notes).toContain('xpinstall.signatures.required');
  });

  it('says the binaries are not code-signed', () => {
    expect(notes).toMatch(/not code-signed/);
  });
});
