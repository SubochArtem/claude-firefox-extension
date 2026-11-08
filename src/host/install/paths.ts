import { posix, win32 } from 'node:path';
import { EXTENSION_ID, NATIVE_HOST_NAME } from '../protocol';

const APP_NAME = 'claude-firefox-extension';
const BINARY_NAME = 'claude-firefox-host';

export type Env = Record<string, string | undefined>;

export interface InstallPaths {
  dir: string;
  /** The installed copy of the single executable, which the manifest names directly. */
  binaryPath: string;
  /** The wrapper that runs a development build with Node. */
  wrapperPath: string;
  manifestPath: string;
}

/** What `install` registers: the running single executable, or a development build run by Node. */
export type HostSource = { kind: 'binary'; executable: string } | { kind: 'node'; nodePath: string; entry: string };

// Windows environment names are case-insensitive, but a plain object passed in is not.
export function envValue(env: Env, name: string): string | undefined {
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() === name && value) return value;
  return undefined;
}

/** On Windows the directory is the host's bridge.json directory (host/bridge-info.ts). */
export function installPaths(platform: NodeJS.Platform, env: Env, home: string): InstallPaths {
  if (platform === 'win32') {
    const localAppData = envValue(env, 'LOCALAPPDATA') ?? win32.join(home, 'AppData', 'Local');
    const dir = win32.join(localAppData, APP_NAME);
    return {
      dir,
      binaryPath: win32.join(dir, `${BINARY_NAME}.exe`),
      wrapperPath: win32.join(dir, 'native-host.bat'),
      manifestPath: win32.join(dir, `${NATIVE_HOST_NAME}.json`),
    };
  }
  let dir: string;
  let manifestDir: string;
  if (platform === 'darwin') {
    dir = posix.join(home, 'Library/Application Support', APP_NAME);
    manifestDir = posix.join(home, 'Library/Application Support/Mozilla/NativeMessagingHosts');
  } else if (platform === 'linux') {
    dir = posix.join(env['XDG_DATA_HOME'] || posix.join(home, '.local/share'), APP_NAME);
    manifestDir = posix.join(home, '.mozilla/native-messaging-hosts');
  } else {
    throw new Error(`Native host installation is not supported on ${platform}.`);
  }
  return {
    dir,
    binaryPath: posix.join(dir, BINARY_NAME),
    wrapperPath: posix.join(dir, 'native-host'),
    manifestPath: posix.join(manifestDir, `${NATIVE_HOST_NAME}.json`),
  };
}

export function launcherPath(paths: InstallPaths, source: HostSource): string {
  return source.kind === 'binary' ? paths.binaryPath : paths.wrapperPath;
}

export function nativeHostManifest(path: string, hostName: string = NATIVE_HOST_NAME) {
  return {
    name: hostName,
    description: 'Claude Firefox Extension native messaging host',
    path,
    type: 'stdio',
    allowed_extensions: [EXTENSION_ID],
  };
}
