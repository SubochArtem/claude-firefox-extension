import { join } from 'node:path';

const BINARY_NAME = 'claude-firefox-host';
export const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

/**
 * @typedef {{ bundle: string, workDir: string, config: string, blob: string, binDir: string, binary: string }} BinaryPaths
 * @typedef {{ file: string, args: string[] }} Step
 * @typedef {'build-sea' | 'postject'} SeaMechanism
 */

/** @param {string} platform */
export function binaryFileName(platform) {
  return platform === 'win32' ? `${BINARY_NAME}.exe` : BINARY_NAME;
}

/**
 * @param {string} root the npm package root (src/)
 * @param {string} platform
 * @returns {BinaryPaths}
 */
export function binaryPaths(root, platform) {
  const workDir = join(root, 'dist', 'sea');
  const binDir = join(root, 'dist', 'bin');
  return {
    bundle: join(root, 'dist', 'host', 'sea.cjs'),
    workDir,
    config: join(workDir, 'sea-config.json'),
    blob: join(workDir, 'sea-prep.blob'),
    binDir,
    binary: join(binDir, binaryFileName(platform)),
  };
}

/**
 * `node --build-sea` (recent Node versions) builds the executable itself; older ones only write
 * the preparation blob (`--experimental-sea-config`), which postject injects into a copy of node.
 * @param {string} nodeHelp output of `node --help`
 * @returns {SeaMechanism}
 */
export function seaMechanism(nodeHelp) {
  return /^\s*--build-sea\b/m.test(nodeHelp) ? 'build-sea' : 'postject';
}

/**
 * @param {BinaryPaths} paths
 * @param {SeaMechanism} mechanism
 */
export function seaConfig(paths, mechanism) {
  return {
    main: paths.bundle,
    output: mechanism === 'build-sea' ? paths.binary : paths.blob,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  };
}

/**
 * Commands that build paths.binary; with postject they run after node has been copied there.
 * @param {BinaryPaths} paths
 * @param {string} platform
 * @param {SeaMechanism} mechanism
 * @param {{ node: string, postjectCli: string }} tools
 * @returns {Step[]}
 */
export function binaryBuildSteps(paths, platform, mechanism, tools) {
  const macos = platform === 'darwin';
  // macOS on Apple silicon refuses to run a binary without a valid signature; ad hoc is enough.
  const sign = macos ? [{ file: 'codesign', args: ['--sign', '-', '--force', paths.binary] }] : [];
  if (mechanism === 'build-sea') return [{ file: tools.node, args: ['--build-sea', paths.config] }, ...sign];
  return [
    { file: tools.node, args: ['--experimental-sea-config', paths.config] },
    // Injection invalidates the signature node was shipped with.
    ...(macos ? [{ file: 'codesign', args: ['--remove-signature', paths.binary] }] : []),
    {
      file: tools.node,
      args: [
        tools.postjectCli,
        paths.binary,
        'NODE_SEA_BLOB',
        paths.blob,
        '--sentinel-fuse',
        SEA_FUSE,
        ...(macos ? ['--macho-segment-name', 'NODE_SEA'] : []),
      ],
    },
    ...sign,
  ];
}
