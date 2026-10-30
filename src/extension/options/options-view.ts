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
