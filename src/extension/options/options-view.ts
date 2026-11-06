import type { PermissionRecord } from '../permissions/permission-model';

export interface PermissionRow {
  id: string;
  site: string;
  decision: string;
  duration: string;
  created: string;
  lastUsed: string;
}

export function permissionRows(records: PermissionRecord[], formatTime: (ms: number) => string): PermissionRow[] {
  return [...records]
    .sort((a, b) => (a.host === b.host ? a.createdAt - b.createdAt : a.host < b.host ? -1 : 1))
    .map((record) => ({
      id: record.id,
      site: record.wildcard ? `*.${record.host}` : record.host,
      decision: record.decision === 'allow' ? 'Allow' : 'Deny',
      duration: record.duration === 'once' ? 'Once' : 'Always',
      created: formatTime(record.createdAt),
      lastUsed: record.lastUsed === undefined ? 'Never' : formatTime(record.lastUsed),
    }));
}

const MIN_KEY_LENGTH_FOR_SUFFIX = 12;

export function apiKeyStatus(apiKey: string): string {
  if (apiKey === '') return 'No API key is saved.';
  if (apiKey.length < MIN_KEY_LENGTH_FOR_SUFFIX) return 'An API key is saved.';
  return `An API key ending in ${apiKey.slice(-4)} is saved.`;
}
