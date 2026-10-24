import { statSync } from 'node:fs';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';

const APP_NAME = 'claude-firefox-extension';
const SOCKET_FILE_NAME = 'bridge.sock';
const isWindows = process.platform === 'win32';

function isOwnDirectory(path: string, uid: number): boolean {
  try {
    const stats = statSync(path);
    return stats.isDirectory() && stats.uid === uid;
  } catch {
    return false;
  }
}

// Firefox starts the native host with the full session environment, but Claude Code may start the
// MCP server with only a few variables, so the path must not depend on TMPDIR and should survive a
// missing XDG_RUNTIME_DIR.
function socketDir(): string {
  const runtimeDir = process.env['XDG_RUNTIME_DIR'];
  if (runtimeDir) return join(runtimeDir, APP_NAME);
  const { uid } = userInfo();
  const userRuntimeDir = `/run/user/${uid}`;
  if (process.platform === 'linux' && isOwnDirectory(userRuntimeDir, uid)) return join(userRuntimeDir, APP_NAME);
  // Literal /tmp instead of os.tmpdir(): TMPDIR differs between environments, and on macOS it is long
  // enough to push the socket path past the 104-byte sun_path limit.
  return `/tmp/${APP_NAME}-${uid}`;
}

export function bridgeSocketPath(): string {
  // Windows has no socket files: named pipes live in a flat namespace and vanish with their owner.
  // The pipe gets the default ACL, so it is not restricted to the current user; Windows is not
  // supported yet.
  if (isWindows) return `\\\\.\\pipe\\${APP_NAME}-${userInfo().username}`;
  const path = join(socketDir(), SOCKET_FILE_NAME);
  // sun_path is 108 bytes on Linux and 104 on macOS and the BSDs, including the terminating NUL.
  const maxBytes = process.platform === 'linux' ? 107 : 103;
  const bytes = Buffer.byteLength(path);
  if (bytes > maxBytes) {
    throw new Error(
      `Bridge socket path ${path} is ${bytes} bytes, longer than the ${maxBytes}-byte limit for Unix socket paths on this platform. Point XDG_RUNTIME_DIR at a shorter directory.`,
    );
  }
  return path;
}

// The directory may sit in the shared /tmp, where another user could have created it first.
async function assertPrivateDir(dir: string): Promise<void> {
  const stats = await lstat(dir);
  const refuse = (reason: string): never => {
    throw new Error(`Refusing to use bridge socket directory ${dir}: ${reason}`);
  };
  if (stats.isSymbolicLink()) refuse('it is a symbolic link');
  if (!stats.isDirectory()) refuse('it is not a directory');
  if (stats.uid !== userInfo().uid) refuse(`it is owned by uid ${stats.uid}, not by the current user`);
  if ((stats.mode & 0o077) !== 0) {
    refuse(`its mode is ${(stats.mode & 0o777).toString(8)}, group and other must have no access`);
  }
}

export async function prepareBridgeSocketDir(): Promise<void> {
  if (isWindows) return;
  const dir = socketDir();
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await assertPrivateDir(dir);
}

export async function checkBridgeSocketDir(): Promise<void> {
  if (isWindows) return;
  await assertPrivateDir(socketDir());
}

export async function restrictBridgeSocket(path: string): Promise<void> {
  if (isWindows) return;
  await chmod(path, 0o600);
}
