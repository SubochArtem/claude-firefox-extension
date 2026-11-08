import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  binaryBuildSteps,
  binaryFileName,
  binaryPaths,
  SEA_FUSE,
  seaConfig,
  seaMechanism,
} from '../build-binary-lib.mjs';

const root = join('/', 'repo', 'src');

describe('binaryFileName', () => {
  it('adds .exe on Windows only', () => {
    expect(binaryFileName('win32')).toBe('claude-firefox-host.exe');
    expect(binaryFileName('linux')).toBe('claude-firefox-host');
    expect(binaryFileName('darwin')).toBe('claude-firefox-host');
  });
});

describe('binaryPaths', () => {
  it('reads the CommonJS host bundle and writes the binary to dist/bin', () => {
    expect(binaryPaths(root, 'linux')).toEqual({
      bundle: join(root, 'dist', 'host', 'sea.cjs'),
      workDir: join(root, 'dist', 'sea'),
      config: join(root, 'dist', 'sea', 'sea-config.json'),
      blob: join(root, 'dist', 'sea', 'sea-prep.blob'),
      binDir: join(root, 'dist', 'bin'),
      binary: join(root, 'dist', 'bin', 'claude-firefox-host'),
    });
  });

  it('names the Windows binary with .exe', () => {
    expect(binaryPaths(root, 'win32').binary).toBe(join(root, 'dist', 'bin', 'claude-firefox-host.exe'));
  });
});

describe('seaMechanism', () => {
  it('uses --build-sea when node lists it', () => {
    const help = '  --build-sea=...             Build a Node.js single executable\n  --build-snapshot  Generate';
    expect(seaMechanism(help)).toBe('build-sea');
  });

  it('falls back to postject otherwise', () => {
    expect(seaMechanism('  --build-snapshot            Generate a snapshot blob')).toBe('postject');
    expect(seaMechanism('  --experimental-sea-config=...  Generate a blob')).toBe('postject');
  });
});

describe('seaConfig', () => {
  const paths = binaryPaths(root, 'linux');
  const options = { disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false };

  it('writes the executable with --build-sea', () => {
    expect(seaConfig(paths, 'build-sea')).toEqual({ main: paths.bundle, output: paths.binary, ...options });
  });

  it('writes the preparation blob for postject', () => {
    expect(seaConfig(paths, 'postject')).toEqual({ main: paths.bundle, output: paths.blob, ...options });
  });
});

describe('binaryBuildSteps', () => {
  const paths = binaryPaths(root, 'linux');
  const tools = { node: '/usr/bin/node', postjectCli: '/repo/src/node_modules/postject/dist/cli.js' };
  const blobStep = { file: '/usr/bin/node', args: ['--experimental-sea-config', paths.config] };
  const postjectArgs = [
    tools.postjectCli,
    paths.binary,
    'NODE_SEA_BLOB',
    paths.blob,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ];
  const signStep = { file: 'codesign', args: ['--sign', '-', '--force', paths.binary] };

  it('uses the fuse Node documents for SEA injection', () => {
    expect(SEA_FUSE).toBe('NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2');
  });

  it('runs --build-sea alone on Linux and Windows', () => {
    const buildStep = { file: '/usr/bin/node', args: ['--build-sea', paths.config] };
    expect(binaryBuildSteps(paths, 'linux', 'build-sea', tools)).toEqual([buildStep]);
    expect(binaryBuildSteps(paths, 'win32', 'build-sea', tools)).toEqual([buildStep]);
  });

  it('signs ad hoc after --build-sea on macOS', () => {
    expect(binaryBuildSteps(paths, 'darwin', 'build-sea', tools)).toEqual([
      { file: '/usr/bin/node', args: ['--build-sea', paths.config] },
      signStep,
    ]);
  });

  it('generates the blob and injects it with postject on Linux', () => {
    expect(binaryBuildSteps(paths, 'linux', 'postject', tools)).toEqual([
      blobStep,
      { file: '/usr/bin/node', args: postjectArgs },
    ]);
  });

  it('injects without signing steps on Windows', () => {
    const windowsPaths = binaryPaths(root, 'win32');
    const steps = binaryBuildSteps(windowsPaths, 'win32', 'postject', tools);
    expect(steps.map((step) => step.file)).toEqual(['/usr/bin/node', '/usr/bin/node']);
    expect(steps[1]?.args[1]).toBe(windowsPaths.binary);
  });

  it('removes the signature, injects into the NODE_SEA segment and signs ad hoc on macOS', () => {
    expect(binaryBuildSteps(paths, 'darwin', 'postject', tools)).toEqual([
      blobStep,
      { file: 'codesign', args: ['--remove-signature', paths.binary] },
      { file: '/usr/bin/node', args: [...postjectArgs, '--macho-segment-name', 'NODE_SEA'] },
      signStep,
    ]);
  });
});
