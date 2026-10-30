import {
  checkPermission,
  type CheckOptions,
  type PermissionDecision,
  type PermissionDuration,
  type PermissionOutcome,
  type PermissionRecord,
  parsePermissionRecords,
  validatePermissionRecord,
} from './permission-model';
import { normalizeHost } from './site';

export const PERMISSION_STORAGE_KEY = 'permissionStorage';
// An allow-once record is normally consumed by its own tool call within seconds; older ones were never used.
export const ALLOW_ONCE_MAX_AGE_MS = 10 * 60 * 1000;

export interface NewPermission {
  host: string;
  wildcard: boolean;
  decision: PermissionDecision;
  duration: PermissionDuration;
  toolUseId?: string;
}

let queue: Promise<unknown> = Promise.resolve();

// Every read-modify-write runs in order, so concurrent checks and grants do not overwrite each other.
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task);
  queue = result.catch(() => {});
  return result;
}

async function read(): Promise<PermissionRecord[]> {
  const items = await browser.storage.local.get(PERMISSION_STORAGE_KEY);
  return parsePermissionRecords(items[PERMISSION_STORAGE_KEY]);
}

async function write(records: PermissionRecord[]): Promise<void> {
  await browser.storage.local.set({ [PERMISSION_STORAGE_KEY]: records });
}

export function loadPermissions(): Promise<PermissionRecord[]> {
  return serialized(read);
}

export function addPermission(input: NewPermission, now = Date.now()): Promise<PermissionRecord> {
  return serialized(async () => {
    const host = normalizeHost(input.host);
    if (host === undefined) throw new Error(`Invalid permission host: ${JSON.stringify(input.host)}`);
    const candidate: Record<string, unknown> = { ...input, id: crypto.randomUUID(), host, createdAt: now };
    const validated = validatePermissionRecord(candidate);
    if (!validated.ok) throw new Error(validated.error);
    const records = (await read()).filter(
      (record) => record.duration !== 'once' || now - record.createdAt <= ALLOW_ONCE_MAX_AGE_MS,
    );
    await write([...records, validated.record]);
    return validated.record;
  });
}

export function revokePermission(id: string): Promise<boolean> {
  return serialized(async () => {
    const records = await read();
    const remaining = records.filter((record) => record.id !== id);
    if (remaining.length === records.length) return false;
    await write(remaining);
    return true;
  });
}

export function clearPermissions(): Promise<void> {
  return serialized(() => browser.storage.local.remove(PERMISSION_STORAGE_KEY));
}

export function checkSitePermission(url: string, options: Partial<CheckOptions> = {}): Promise<PermissionOutcome> {
  return serialized(async () => {
    const records = await read();
    const check = checkPermission(records, url, { toolUseId: options.toolUseId, now: options.now ?? Date.now() });
    if (check.records !== records) await write(check.records);
    return check.outcome;
  });
}
