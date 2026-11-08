import { NATIVE_HOST_NAME } from '../protocol';
import { mcpAddCommand, remoteDebuggingNote } from './messages';
import { installPaths, launcherPath, type Env, type HostSource, type InstallPaths } from './paths';
import { installPosix, uninstallPosix } from './posix';
import { execFileRunner, installWindows, uninstallWindows, windowsPathWarnings, type Runner } from './windows';

export interface InstallerContext {
  platform: NodeJS.Platform;
  env: Env;
  home: string;
  source: HostSource;
  out: (line: string) => void;
  err: (line: string) => void;
  run?: Runner;
}

function launcherLabel(source: HostSource): string {
  return source.kind === 'binary' ? 'host:    ' : 'wrapper: ';
}

async function install(paths: InstallPaths, context: InstallerContext): Promise<void> {
  const { platform, env, source, out, err } = context;
  if (platform === 'win32') {
    await installWindows({ paths, env, source, run: context.run ?? execFileRunner });
  } else {
    await installPosix({ paths, source });
  }
  out('Installed the native messaging host:');
  if (platform === 'win32') out(`  registry: HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`);
  out(`  manifest: ${paths.manifestPath}`);
  out(`  ${launcherLabel(source)} ${launcherPath(paths, source)}`);
  out('');
  if (platform !== 'win32') {
    out('Snap and Flatpak builds of Firefox are not supported: their sandbox blocks native messaging hosts.');
    out('');
  }
  out('Register the MCP server with Claude Code:');
  out(`  ${mcpAddCommand(platform, source, paths)}`);
  out('');
  for (const line of remoteDebuggingNote(platform)) out(line);
  if (platform === 'win32' && source.kind === 'node') {
    for (const warning of windowsPathWarnings(paths.dir)) err(`\n${warning}`);
  }
}

async function uninstall(paths: InstallPaths, context: InstallerContext): Promise<void> {
  const { platform, env, out, err } = context;
  const left =
    platform === 'win32'
      ? await uninstallWindows({ paths, env, run: context.run ?? execFileRunner })
      : await uninstallPosix({ paths });
  out('Removed the native messaging host:');
  if (platform === 'win32') out(`  registry: HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`);
  out(`  ${paths.manifestPath}`);
  for (const path of [paths.wrapperPath, paths.binaryPath]) if (!left.includes(path)) out(`  ${path}`);
  for (const path of left) {
    err(
      `Could not remove ${path}: a running native host or MCP server (or this uninstaller) is using it. ` +
        'Firefox no longer starts it; delete it after closing Firefox and Claude Code.',
    );
  }
}

export type InstallCommand = 'install' | 'print-paths' | 'uninstall';

/** Runs an install command and returns the process exit code. */
export async function runInstallCommand(command: InstallCommand, context: InstallerContext): Promise<number> {
  try {
    const paths = installPaths(context.platform, context.env, context.home);
    if (command === 'print-paths') {
      context.out(JSON.stringify({ manifest: paths.manifestPath, launcher: launcherPath(paths, context.source) }));
    } else if (command === 'install') {
      await install(paths, context);
    } else {
      await uninstall(paths, context);
    }
    return 0;
  } catch (error) {
    context.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
