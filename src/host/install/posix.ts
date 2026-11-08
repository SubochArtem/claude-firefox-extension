import { rm, rmdir } from 'node:fs/promises';
import { NATIVE_HOST_NAME } from '../protocol';
import { installFiles, nodeFileOps, removeInstalledFile, removeStaleCopies, type FileOps, type Launcher } from './files';
import { shellQuote } from './messages';
import { launcherPath, type HostSource, type InstallPaths } from './paths';

// Firefox started from a desktop session usually lacks the shell's PATH (nvm, asdf, ...), so the
// wrapper pins the Node binary by absolute path.
export function renderShellWrapper(nodePath: string, hostEntry: string): string {
  return `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(hostEntry)} --native-host "$@"\n`;
}

export interface InstallPosixOptions {
  paths: InstallPaths;
  source: HostSource;
  hostName?: string;
  ops?: FileOps;
}

export async function installPosix({ paths, source, hostName = NATIVE_HOST_NAME, ops }: InstallPosixOptions): Promise<void> {
  const launcher: Launcher =
    source.kind === 'binary'
      ? { kind: 'binary', executable: source.executable }
      : { kind: 'script', content: renderShellWrapper(source.nodePath, source.entry) };
  try {
    await installFiles({
      launcher,
      launcherPath: launcherPath(paths, source),
      manifestPath: paths.manifestPath,
      hostName,
      ...(ops ? { ops } : {}),
    });
  } catch (error) {
    throw new Error(`Install failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** Returns the files that are still in use and were left in place (none on Linux and macOS). */
export async function uninstallPosix({ paths, ops = nodeFileOps }: { paths: InstallPaths; ops?: FileOps }): Promise<string[]> {
  await rm(paths.manifestPath, { force: true });
  await rm(paths.wrapperPath, { force: true });
  const left = await removeStaleCopies(paths.binaryPath, ops);
  if (!(await removeInstalledFile(paths.binaryPath, ops))) left.push(paths.binaryPath);
  try {
    await rmdir(paths.dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error;
  }
  return left;
}
