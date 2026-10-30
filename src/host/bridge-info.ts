import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import { join, win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createNonce, isHex64 } from './handshake';
import { isRecord } from './protocol';
import { bridgeSocketDir } from './socket-path';

const APP_NAME = 'claude-firefox-extension';
const FILE_NAME = 'bridge.json';
const BUSY_RETRY_DELAYS_MS = [10, 20, 30, 40];

export interface BridgeInfo {
  version: 1;
  endpoint: string;
  secret: string;
  pid: number;
}

export interface BridgeInfoDirOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  homedir?: string;
}

// Windows environment names are case-insensitive, but a plain object passed in is not.
function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() === name && value) return value;
  return undefined;
}

export function bridgeInfoDir({ platform = process.platform, env = process.env, homedir }: BridgeInfoDirOptions = {}): string {
  if (platform !== 'win32') return bridgeSocketDir();
  const localAppData = envValue(env, 'LOCALAPPDATA') ?? win32.join(homedir ?? osHomedir(), 'AppData', 'Local');
  return win32.join(localAppData, APP_NAME);
}

export function newBridgeInfo(endpoint: string): BridgeInfo {
  return { version: 1, endpoint, secret: createNonce(), pid: process.pid };
}

function parseBridgeInfo(value: unknown): BridgeInfo | undefined {
  if (!isRecord(value)) return undefined;
  const { version, endpoint, secret, pid } = value;
  if (version !== 1 || typeof endpoint !== 'string' || endpoint === '' || !isHex64(secret)) return undefined;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return { version, endpoint, secret, pid };
}

// On Windows, renaming over or reading a file fails with EPERM or EBUSY while another process (an MCP
// server reading it, an antivirus scanner) briefly holds it open.
async function retryWhileBusy<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryDelay = BUSY_RETRY_DELAYS_MS[attempt];
      if ((code !== 'EPERM' && code !== 'EBUSY') || retryDelay === undefined) throw error;
      await delay(retryDelay);
    }
  }
}

// Written to a new file and renamed into place, so readers never see a partial file, the mode is
// never inherited from an older file, and a symlink planted at the path is replaced, not followed.
export async function writeBridgeInfo(info: BridgeInfo, dir = bridgeInfoDir()): Promise<void> {
  const temp = join(dir, `${FILE_NAME}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  let created = false;
  try {
    await writeFile(temp, JSON.stringify(info), { flag: 'wx', mode: 0o600 });
    created = true;
    await retryWhileBusy(() => rename(temp, join(dir, FILE_NAME)));
  } catch (error) {
    if (created) await rm(temp, { force: true });
    throw error;
  }
}

export async function readBridgeInfo(dir = bridgeInfoDir()): Promise<BridgeInfo> {
  const file = join(dir, FILE_NAME);
  const text = await retryWhileBusy(() => readFile(file, 'utf8'));
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // JSON.parse messages quote the text around the error position, which may be the secret.
    throw new Error(`Invalid bridge info file ${file}: not valid JSON`);
  }
  const info = parseBridgeInfo(value);
  if (!info) {
    throw new Error(`Invalid bridge info file ${file}: expected version 1 with an endpoint, a 64-char hex secret and a pid`);
  }
  return info;
}

// Synchronous so it can run from a process 'exit' listener. A newer host may have replaced the file,
// so it is removed only while it still describes this host.
export function removeBridgeInfoIfOwn(info: BridgeInfo, dir = bridgeInfoDir()): boolean {
  const file = join(dir, FILE_NAME);
  try {
    const current = parseBridgeInfo(JSON.parse(readFileSync(file, 'utf8')));
    if (current?.secret !== info.secret || current.endpoint !== info.endpoint || current.pid !== info.pid) return false;
    rmSync(file);
    return true;
  } catch {
    return false;
  }
}

// Synchronous so it can run from a process 'exit' listener: a host that exits while writeBridgeInfo is
// between creating its temp file and renaming it would otherwise leave a copy of its secret behind.
export function removeBridgeInfoTempFiles(dir = bridgeInfoDir(), pid = process.pid): void {
  const prefix = `${FILE_NAME}.${pid}.`;
  const suffix = '.tmp';
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix) || name.length <= prefix.length + suffix.length) continue;
    try {
      rmSync(join(dir, name), { force: true });
    } catch {
      // Best effort: another process may hold the file open on Windows.
    }
  }
}
