import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeHostManifest } from './paths';

export interface FileOps {
  copyFile(source: string, target: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { force: boolean }): Promise<void>;
}

export const nodeFileOps: FileOps = { copyFile: fs.copyFile, rename: fs.rename, rm: fs.rm };

/** The program the manifest names: a copy of the single executable, or a wrapper script. */
export type Launcher = { kind: 'binary'; executable: string } | { kind: 'script'; content: string };

interface Placement {
  rollback(): Promise<void>;
  commit(): Promise<void>;
}

const NOTHING_TO_UNDO: Placement = { rollback: async () => undefined, commit: async () => undefined };
// On Windows a running executable cannot be removed or overwritten (EPERM or EBUSY), and a process that
// just exited may hold its image open for a moment longer.
const IN_USE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const IN_USE_RETRY_DELAYS_MS = [100, 200, 300, 400];

export function isInUse(error: unknown): boolean {
  return IN_USE_CODES.has(String((error as NodeJS.ErrnoException | undefined)?.code));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function randomSuffix(): string {
  return randomBytes(6).toString('hex');
}

const RANDOM_SUFFIX = /^[0-9a-f]{12}$/;

function isStaleCopy(name: string, target: string): boolean {
  const base = basename(target);
  if (name.startsWith(`${base}.old-`)) return RANDOM_SUFFIX.test(name.slice(`${base}.old-`.length));
  if (name.startsWith(`.${base}.`) && name.endsWith('.tmp')) {
    return RANDOM_SUFFIX.test(name.slice(`.${base}.`.length, -'.tmp'.length));
  }
  return false;
}

/**
 * Removes copies left by earlier upgrades: replaced binaries that were still running then and
 * temporary copies of an interrupted install. Returns the ones that are still in use.
 */
export async function removeStaleCopies(target: string, ops: FileOps = nodeFileOps): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(dirname(target));
  } catch {
    return [];
  }
  const left: string[] = [];
  for (const name of names.filter((entry) => isStaleCopy(entry, target))) {
    const path = join(dirname(target), name);
    await ops.rm(path, { force: true }).catch(() => left.push(path));
  }
  return left;
}

// The default file systems of Windows and macOS are case-insensitive.
const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin';

async function samePath(a: string, b: string): Promise<boolean> {
  try {
    const [realA, realB] = [await fs.realpath(a), await fs.realpath(b)];
    return CASE_INSENSITIVE_PATHS ? realA.toLowerCase() === realB.toLowerCase() : realA === realB;
  } catch {
    return false;
  }
}

/**
 * Puts a copy of `source` at `target` through a temporary file in the same directory. An existing
 * target is renamed aside first instead of overwritten: Windows refuses to overwrite or delete a
 * running executable but lets it be renamed, so an upgrade works while Firefox or Claude Code still
 * runs the old host. The aside copy is removed on commit, or by a later install while it still runs.
 */
export async function placeExecutable(source: string, target: string, ops: FileOps = nodeFileOps): Promise<Placement> {
  if (await samePath(source, target)) return NOTHING_TO_UNDO;
  await removeStaleCopies(target, ops);
  const temp = join(dirname(target), `.${basename(target)}.${randomSuffix()}.tmp`);
  const removeTemp = () => ops.rm(temp, { force: true }).catch(() => undefined);
  try {
    await ops.copyFile(source, temp);
    await fs.chmod(temp, 0o755);
  } catch (error) {
    await removeTemp();
    throw error;
  }
  let aside: string | undefined;
  if (existsSync(target)) {
    aside = `${target}.old-${randomSuffix()}`;
    try {
      await ops.rename(target, aside);
    } catch (error) {
      await removeTemp();
      if (!isInUse(error)) throw error;
      throw new Error(
        `${target} is in use and cannot be replaced (${errorMessage(error)}). Close Firefox and Claude Code, then run install again.`,
        { cause: error },
      );
    }
  }
  const putBack = async () => {
    if (aside !== undefined) await ops.rename(aside, target);
  };
  try {
    await ops.rename(temp, target);
  } catch (error) {
    await removeTemp();
    await putBack().catch(() => undefined);
    throw error;
  }
  return {
    async rollback() {
      try {
        await ops.rm(target, { force: true });
      } finally {
        await putBack();
      }
    },
    async commit() {
      if (aside !== undefined) await ops.rm(aside, { force: true }).catch(() => undefined);
    },
  };
}

async function readIfExists(path: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function restoreFile(path: string, content: Buffer | undefined): Promise<void> {
  await (content === undefined ? fs.rm(path, { force: true }) : fs.writeFile(path, content));
}

async function placeScript(path: string, content: string): Promise<Placement> {
  const previous = await readIfExists(path);
  try {
    await fs.writeFile(path, content, { encoding: 'utf8', mode: 0o755 });
    // writeFile applies the mode only to new files, and the umask may strip bits from it.
    await fs.chmod(path, 0o755);
  } catch (error) {
    await restoreFile(path, previous).catch(() => undefined);
    throw error;
  }
  return { rollback: () => restoreFile(path, previous), commit: async () => undefined };
}

export interface InstallFilesOptions {
  launcher: Launcher;
  launcherPath: string;
  manifestPath: string;
  hostName?: string;
  /** Runs after the files are written (the registry on Windows); a failure puts the previous files back. */
  register?: () => Promise<void>;
  ops?: FileOps;
}

/**
 * Writes the launcher and the manifest into existing or new directories. On a reinstall the
 * registration still points at the previous files, so a failed run puts them back instead of
 * leaving that installation broken.
 */
export async function installFiles({
  launcher,
  launcherPath,
  manifestPath,
  hostName,
  register,
  ops = nodeFileOps,
}: InstallFilesOptions): Promise<void> {
  await fs.mkdir(dirname(launcherPath), { recursive: true });
  const placement =
    launcher.kind === 'binary'
      ? await placeExecutable(launcher.executable, launcherPath, ops)
      : await placeScript(launcherPath, launcher.content);
  let previousManifest: Buffer | undefined;
  try {
    previousManifest = await readIfExists(manifestPath);
    try {
      await fs.mkdir(dirname(manifestPath), { recursive: true });
      await fs.writeFile(manifestPath, `${JSON.stringify(nativeHostManifest(launcherPath, hostName), null, 2)}\n`, 'utf8');
      await register?.();
    } catch (error) {
      await restoreFile(manifestPath, previousManifest).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    await placement.rollback().catch(() => undefined);
    throw error;
  }
  await placement.commit();
}

/** Removes a file; returns false when it is a running executable that cannot be removed. */
export async function removeInstalledFile(path: string, ops: FileOps = nodeFileOps): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      await ops.rm(path, { force: true });
      return true;
    } catch (error) {
      if (!isInUse(error)) throw error;
      const retryDelay = IN_USE_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined) return false;
      await delay(retryDelay);
    }
  }
}
