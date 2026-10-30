import { describe, expect, it } from 'vitest';
import type { PermissionRecord } from '../permissions/permission-model';
import { permissionRows } from '../options/options-view';

const time = (ms: number) => `t${ms}`;

function record(overrides: Partial<PermissionRecord>): PermissionRecord {
  return { id: 'id', host: 'example.com', wildcard: false, decision: 'allow', duration: 'always', createdAt: 1, ...overrides };
}

describe('options page permission rows', () => {
  it('has no rows without records', () => {
    expect(permissionRows([], time)).toEqual([]);
  });

  it('describes each record in words', () => {
    const rows = permissionRows(
      [
        record({ id: 'a', host: 'example.com', wildcard: true, decision: 'deny', createdAt: 5, lastUsed: 9 }),
        record({ id: 'b', host: 'other.example', duration: 'once', toolUseId: 'tool-1', createdAt: 7 }),
      ],
      time,
    );
    expect(rows).toEqual([
      { id: 'a', site: '*.example.com', decision: 'Deny', duration: 'Always', created: 't5', lastUsed: 't9' },
      { id: 'b', site: 'other.example', decision: 'Allow', duration: 'Once', created: 't7', lastUsed: 'Never' },
    ]);
  });

  it('sorts by host, then by creation time', () => {
    const rows = permissionRows(
      [
        record({ id: 'c', host: 'b.example', createdAt: 1 }),
        record({ id: 'b', host: 'a.example', createdAt: 9 }),
        record({ id: 'a', host: 'a.example', wildcard: true, createdAt: 3 }),
      ],
      time,
    );
    expect(rows.map((row) => row.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps hosts as plain strings for textContent', () => {
    const [row] = permissionRows([record({ host: 'xn--80ak6aa92e.com' })], time);
    expect(row?.site).toBe('xn--80ak6aa92e.com');
  });
});
