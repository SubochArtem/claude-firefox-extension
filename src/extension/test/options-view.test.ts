import { describe, expect, it } from 'vitest';
import type { PermissionRecord } from '../permissions/permission-model';
import { apiKeyStatus, claudeCodeStatusText, permissionRows } from '../options/options-view';

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

describe('options page API key status', () => {
  it('says the key is not set when it is empty', () => {
    expect(apiKeyStatus('')).toBe('No API key is saved.');
  });

  it('shows only the last 4 characters of a saved key', () => {
    const status = apiKeyStatus('sk-ant-api03-abcdefghijklmnop-WXYZ');
    expect(status).toBe('An API key ending in WXYZ is saved.');
    expect(status).not.toContain('sk-ant');
  });

  it('shows no characters of a short key', () => {
    expect(apiKeyStatus('abcdefghijk')).toBe('An API key is saved.');
  });
});

describe('options page Claude Code status', () => {
  const ready = { found: true, path: '/home/u/.local/bin/claude', version: '2.1.316', versionOk: true, loggedIn: true, authMethod: 'claude.ai', ready: true };

  it('says when the native host is not connected', () => {
    expect(claudeCodeStatusText({ hostConnected: false })).toMatch(/native host is not connected/);
  });

  it('says when the native host did not report a status', () => {
    expect(claudeCodeStatusText({ hostConnected: true })).toMatch(/did not report/);
  });

  it('names the version and path of a ready Claude Code logged in with claude.ai', () => {
    const text = claudeCodeStatusText({ hostConnected: true, status: ready });
    expect(text).toContain('2.1.316');
    expect(text).toContain('/home/u/.local/bin/claude');
    expect(text).toMatch(/logged in with a Claude subscription \(claude\.ai\)/);
  });

  it('passes on why Claude Code was not found', () => {
    const text = claudeCodeStatusText({ hostConnected: true, status: { found: false, ready: false, error: 'Looked in: /usr/bin/claude.' } });
    expect(text).toMatch(/not found/);
    expect(text).toContain('Looked in: /usr/bin/claude.');
  });

  it('says when Claude Code is too old', () => {
    const text = claudeCodeStatusText({ hostConnected: true, status: { found: true, path: '/c', version: '2.1.301', versionOk: false, ready: false } });
    expect(text).toContain('2.1.301');
    expect(text).toContain('2.1.302');
  });

  it('says when Claude Code is not logged in', () => {
    const text = claudeCodeStatusText({ hostConnected: true, status: { ...ready, loggedIn: false, authMethod: 'none', ready: false } });
    expect(text).toMatch(/not logged in/);
    expect(text).toContain('claude auth login');
  });

  it('says when Claude Code is logged in another way than a subscription', () => {
    const text = claudeCodeStatusText({ hostConnected: true, status: { ...ready, authMethod: 'apiKey', ready: false } });
    expect(text).toContain('apiKey');
    expect(text).toMatch(/not a Claude subscription/);
  });

  it('passes on a check that failed', () => {
    const text = claudeCodeStatusText({ hostConnected: true, status: { found: true, path: '/c', ready: false, error: 'Could not run /c --version' } });
    expect(text).toContain('Could not run /c --version');
  });
});
