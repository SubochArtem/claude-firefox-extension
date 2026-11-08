/**
 * @typedef {{ id: string, platform: string, arch: string, os: string }} Target
 */

export const CHECKSUM_FILE = 'SHA256SUMS';
const BINARY_PREFIX = 'claude-firefox-host';
const EXTENSION_PREFIX = 'claude-firefox-extension';
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

/** @type {readonly Target[]} */
export const TARGETS = [
  { id: 'linux-x64', platform: 'linux', arch: 'x64', os: 'Linux x64' },
  { id: 'linux-arm64', platform: 'linux', arch: 'arm64', os: 'Linux arm64' },
  { id: 'macos-arm64', platform: 'darwin', arch: 'arm64', os: 'macOS Apple silicon' },
  { id: 'macos-x64', platform: 'darwin', arch: 'x64', os: 'macOS Intel' },
  { id: 'windows-x64', platform: 'win32', arch: 'x64', os: 'Windows x64' },
];

/**
 * @param {string} platform a Node `process.platform`
 * @param {string} arch a Node `process.arch`
 * @returns {string | undefined}
 */
export function targetFor(platform, arch) {
  return TARGETS.find((target) => target.platform === platform && target.arch === arch)?.id;
}

/** @param {string} targetId */
export function binaryAssetName(targetId) {
  const target = TARGETS.find((candidate) => candidate.id === targetId);
  if (target === undefined) throw new Error(`Unknown release target ${targetId}`);
  return `${BINARY_PREFIX}-${target.id}${target.platform === 'win32' ? '.exe' : ''}`;
}

/** @param {string} version */
export function extensionAssetName(version) {
  return `${EXTENSION_PREFIX}-${version}.xpi`;
}

/** @param {string} version */
export function releaseAssetNames(version) {
  return [...TARGETS.map((target) => binaryAssetName(target.id)), extensionAssetName(version)].sort();
}

/**
 * The release version of a tag, which must be vX.Y.Z with the version of package.json and of the
 * extension manifest (web-ext names and Firefox reports the package by the manifest version).
 * @param {string} tag
 * @param {{ packageVersion: string, manifestVersion: string }} versions
 */
export function releaseVersion(tag, versions) {
  const version = tag.startsWith('v') ? tag.slice(1) : '';
  if (!VERSION.test(version)) throw new Error(`Tag ${JSON.stringify(tag)} is not of the form vX.Y.Z`);
  if (versions.packageVersion !== version) {
    throw new Error(`Tag ${tag} does not match the version ${versions.packageVersion} in src/package.json`);
  }
  if (versions.manifestVersion !== version) {
    throw new Error(`Tag ${tag} does not match the version ${versions.manifestVersion} in src/extension/manifest.json`);
  }
  return version;
}

/**
 * @param {readonly string[]} files names of the files to publish
 * @param {string} version
 */
export function checkReleaseAssets(files, version) {
  const expected = releaseAssetNames(version);
  const missing = expected.filter((name) => !files.includes(name));
  const unexpected = files.filter((name) => !expected.includes(name)).sort();
  if (missing.length === 0 && unexpected.length === 0) return;
  const parts = [];
  if (missing.length > 0) parts.push(`missing ${missing.join(', ')}`);
  if (unexpected.length > 0) parts.push(`unexpected ${unexpected.join(', ')}`);
  throw new Error(`Release assets do not match: ${parts.join('; ')}`);
}

/**
 * The SHA256SUMS content in the format `sha256sum -c` and `shasum -a 256 -c` read.
 * @param {readonly { name: string, sha256: string }[]} entries
 */
export function checksumFile(entries) {
  for (const { name, sha256 } of entries) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Invalid release asset name ${JSON.stringify(name)}`);
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Invalid SHA-256 digest for ${name}`);
  }
  return [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name, sha256 }) => `${sha256}  ${name}\n`)
    .join('');
}

/**
 * @param {string} version
 * @param {string} repository `owner/name` on GitHub
 */
export function releaseNotes(version, repository) {
  if (!VERSION.test(version)) throw new Error(`Version ${JSON.stringify(version)} is not of the form X.Y.Z`);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`Invalid repository ${JSON.stringify(repository)}`);
  }
  const extension = extensionAssetName(version);
  return [
    `Install guide: https://github.com/${repository}/blob/v${version}/docs/install.md`,
    '',
    '## Native host',
    '',
    'Download the binary for your system, then run it with `install`:',
    '',
    ...TARGETS.map((target) => `- ${target.os}: \`${binaryAssetName(target.id)}\``),
    '',
    'The binaries are not code-signed: macOS Gatekeeper and Windows SmartScreen warn on the first start ' +
      '(the install guide shows how to allow them). Verify downloads against `SHA256SUMS`.',
    '',
    '## Extension',
    '',
    `\`${extension}\` is not signed by Mozilla yet, so release Firefox cannot install it permanently ` +
      'until it is signed on addons.mozilla.org (`feature/amo-signing`). Until then either load it temporarily (about:debugging, This Firefox, ' +
      'Load Temporary Add-on; it is removed when Firefox closes), or use Firefox Developer Edition or Nightly with ' +
      '`xpinstall.signatures.required` set to `false` in about:config and install it from the file in about:addons.',
    '',
  ].join('\n');
}
