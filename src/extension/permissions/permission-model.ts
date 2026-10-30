import { isRecord } from '../tools/navigation-input';
import { canHaveWildcard, hostMatches, normalizeHost, siteForUrl } from './site';

export type PermissionDecision = 'allow' | 'deny';
export type PermissionDuration = 'once' | 'always';

// One record covers every action type on its host (and its subdomains when wildcard is set).
export interface PermissionRecord {
  id: string;
  host: string;
  wildcard: boolean;
  decision: PermissionDecision;
  duration: PermissionDuration;
  toolUseId?: string;
  createdAt: number;
  lastUsed?: number;
}

export type PermissionOutcome =
  | { kind: 'unsupported'; reason: string }
  | { kind: 'denied'; host: string; recordId: string }
  | { kind: 'allowed'; host: string; recordId: string; consumed: boolean }
  | { kind: 'prompt'; host: string };

export interface PermissionCheck {
  outcome: PermissionOutcome;
  // The same array when nothing changed, otherwise a new one to persist.
  records: PermissionRecord[];
}

export interface CheckOptions {
  toolUseId?: string;
  now: number;
}

export function checkPermission(records: PermissionRecord[], url: string, options: CheckOptions): PermissionCheck {
  const site = siteForUrl(url);
  if (!site.ok) return { outcome: { kind: 'unsupported', reason: site.reason }, records };
  const { host } = site;
  const matching = records.filter((record) => hostMatches(record, host));

  const deny = matching.find((record) => record.decision === 'deny');
  if (deny !== undefined) return { outcome: { kind: 'denied', host, recordId: deny.id }, records };

  const once =
    options.toolUseId === undefined
      ? undefined
      : matching.find((record) => record.duration === 'once' && record.toolUseId === options.toolUseId);
  if (once !== undefined) {
    return {
      outcome: { kind: 'allowed', host, recordId: once.id, consumed: true },
      records: records.filter((record) => record !== once),
    };
  }

  const always = matching.find((record) => record.duration === 'always');
  if (always !== undefined) {
    return {
      outcome: { kind: 'allowed', host, recordId: always.id, consumed: false },
      records: records.map((record) => (record === always ? { ...record, lastUsed: options.now } : record)),
    };
  }

  return { outcome: { kind: 'prompt', host }, records };
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

// Returns the record as stored, or a reason why it may not be stored.
export function validatePermissionRecord(value: unknown): { ok: true; record: PermissionRecord } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: 'Permission record must be an object' };
  const { id, host, wildcard, decision, duration, toolUseId, createdAt, lastUsed } = value;
  if (!isNonEmptyString(id)) return { ok: false, error: 'Permission record needs a non-empty id' };
  if (typeof host !== 'string' || normalizeHost(host) !== host) {
    return { ok: false, error: 'Permission record needs a normalized host' };
  }
  if (typeof wildcard !== 'boolean') return { ok: false, error: 'Permission record wildcard must be a boolean' };
  if (wildcard && !canHaveWildcard(host)) {
    return { ok: false, error: 'A wildcard needs a host with a dot that is not an IP address' };
  }
  if (decision !== 'allow' && decision !== 'deny') return { ok: false, error: 'Unknown permission decision' };
  if (duration !== 'once' && duration !== 'always') return { ok: false, error: 'Unknown permission duration' };
  if (decision === 'deny' && duration === 'once') return { ok: false, error: 'A deny-once decision is never stored' };
  if (duration === 'once' && !isNonEmptyString(toolUseId)) {
    return { ok: false, error: 'An allow-once record needs a toolUseId' };
  }
  if (duration === 'always' && toolUseId !== undefined) {
    return { ok: false, error: 'An always record must not have a toolUseId' };
  }
  if (!isTimestamp(createdAt)) return { ok: false, error: 'Permission record createdAt must be a finite number' };
  if (lastUsed !== undefined && !isTimestamp(lastUsed)) {
    return { ok: false, error: 'Permission record lastUsed must be a finite number' };
  }

  const record: PermissionRecord = { id, host, wildcard, decision, duration, createdAt };
  if (duration === 'once') record.toolUseId = toolUseId as string;
  if (lastUsed !== undefined) record.lastUsed = lastUsed;
  return { ok: true, record };
}

export function parsePermissionRecords(value: unknown): PermissionRecord[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const records: PermissionRecord[] = [];
  for (const item of value) {
    const result = validatePermissionRecord(item);
    if (!result.ok || ids.has(result.record.id)) continue;
    ids.add(result.record.id);
    records.push(result.record);
  }
  return records;
}
