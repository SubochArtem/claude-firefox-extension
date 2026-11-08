import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { binaryPaths } from './build-binary-lib.mjs';
import {
  binaryAssetName,
  CHECKSUM_FILE,
  checkReleaseAssets,
  checksumFile,
  extensionAssetName,
  releaseNotes,
  releaseVersion,
  targetFor,
} from './release-lib.mjs';

const USAGE = `Usage: node scripts/release.mjs <command>

  check-tag <tag>                  print the version of a vX.Y.Z tag that matches package.json and the manifest
  stage-binary <target> <dir>      copy dist/bin's binary to <dir> under its release name; <target> must be this machine's
  extension-asset                  print the file name of the extension package
  checksums <dir>                  check that <dir> holds exactly the release assets and write ${CHECKSUM_FILE} there
  notes <version> <owner/repo>     print the release notes`;

const root = join(import.meta.dirname, '..');

/** @param {string} path */
async function readVersion(path) {
  const { version } = JSON.parse(await readFile(join(root, path), 'utf8'));
  if (typeof version !== 'string') throw new Error(`${path} has no version`);
  return version;
}

/** @param {string} path */
async function sha256(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** @param {string[]} args */
async function main(args) {
  const [command, ...rest] = args;
  if (command === 'check-tag' && rest.length === 1) {
    const versions = {
      packageVersion: await readVersion('package.json'),
      manifestVersion: await readVersion('extension/manifest.json'),
    };
    console.log(releaseVersion(/** @type {string} */ (rest[0]), versions));
  } else if (command === 'stage-binary' && rest.length === 2) {
    const [target, dir] = /** @type {[string, string]} */ (rest);
    const here = targetFor(process.platform, process.arch);
    if (here !== target) {
      throw new Error(`This machine builds ${here ?? `${process.platform}-${process.arch}`}, not ${target}`);
    }
    const destination = join(dir, binaryAssetName(target));
    await mkdir(dir, { recursive: true });
    await copyFile(binaryPaths(root, process.platform).binary, destination);
    console.log(destination);
  } else if (command === 'extension-asset' && rest.length === 0) {
    console.log(extensionAssetName(await readVersion('extension/manifest.json')));
  } else if (command === 'checksums' && rest.length === 1) {
    const dir = /** @type {string} */ (rest[0]);
    const files = (await readdir(dir)).filter((name) => name !== CHECKSUM_FILE);
    checkReleaseAssets(files, await readVersion('package.json'));
    const entries = [];
    for (const name of files) entries.push({ name, sha256: await sha256(join(dir, name)) });
    const content = checksumFile(entries);
    await writeFile(join(dir, CHECKSUM_FILE), content);
    process.stdout.write(content);
  } else if (command === 'notes' && rest.length === 2) {
    const [version, repository] = /** @type {[string, string]} */ (rest);
    process.stdout.write(releaseNotes(version, repository));
  } else {
    console.error(USAGE);
    process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`Release step failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
