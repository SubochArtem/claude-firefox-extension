import { beforeEach, describe, expect, it } from 'vitest';
import type { PermissionRecord } from '../permissions/permission-model';
import {
  ALLOW_ONCE_MAX_AGE_MS,
  addPermission,
  checkSitePermission,
  clearPermissions,
  loadPermissions,
  PERMISSION_STORAGE_KEY,
  revokePermission,
} from '../permissions/permission-store';
import { mockBrowser } from './browser-mock';

const NOW = 1_700_000_000_000;

let browserMock: ReturnType<typeof mockBrowser>;

function stored(): unknown {
  return browserMock.storage.local.data.get(PERMISSION_STORAGE_KEY);
}

beforeEach(() => {
  browserMock = mockBrowser();
});

describe('permission store', () => {
  it('uses the permissionStorage key', () => {
    expect(PERMISSION_STORAGE_KEY).toBe('permissionStorage');
  });

  it('loads no records from empty storage', async () => {
    expect(await loadPermissions()).toEqual([]);
  });

  it('drops malformed records when loading', async () => {
    const valid: PermissionRecord = {
      id: 'a',
      host: 'example.com',
      wildcard: false,
      decision: 'allow',
      duration: 'always',
      createdAt: NOW,
    };
    browserMock.storage.local.data.set(PERMISSION_STORAGE_KEY, [valid, { id: 'b' }, 'junk']);
    expect(await loadPermissions()).toEqual([valid]);
  });

  it('loads no records when the stored value is not an array', async () => {
    browserMock.storage.local.data.set(PERMISSION_STORAGE_KEY, { not: 'an array' });
    expect(await loadPermissions()).toEqual([]);
  });

  it('adds a normalized record with a fresh id', async () => {
    const added = await addPermission({ host: 'WWW.Example.com', wildcard: true, decision: 'allow', duration: 'always' }, NOW);
    expect(added).toEqual({
      id: expect.any(String),
      host: 'example.com',
      wildcard: true,
      decision: 'allow',
      duration: 'always',
      createdAt: NOW,
    });
    expect(added.id).not.toBe('');
    expect(stored()).toEqual([added]);

    const second = await addPermission({ host: 'other.com', wildcard: false, decision: 'deny', duration: 'always' }, NOW);
    expect(second.id).not.toBe(added.id);
    expect(await loadPermissions()).toEqual([added, second]);
  });

  it('adds an allow-once record with its toolUseId', async () => {
    const added = await addPermission(
      { host: 'example.com', wildcard: false, decision: 'allow', duration: 'once', toolUseId: 'tool-1' },
      NOW,
    );
    expect(added).toMatchObject({ duration: 'once', toolUseId: 'tool-1' });
    expect(stored()).toEqual([added]);
  });

  it.each([
    ['deny once', { host: 'example.com', wildcard: false, decision: 'deny', duration: 'once', toolUseId: 'tool-1' }],
    ['allow once without toolUseId', { host: 'example.com', wildcard: false, decision: 'allow', duration: 'once' }],
    ['always with toolUseId', { host: 'example.com', wildcard: false, decision: 'allow', duration: 'always', toolUseId: 't' }],
    ['an invalid host', { host: 'example.com/path', wildcard: false, decision: 'allow', duration: 'always' }],
    ['a wildcard on a single-label host', { host: 'localhost', wildcard: true, decision: 'allow', duration: 'always' }],
    ['a wildcard on an IPv4 address', { host: '192.168.1.1', wildcard: true, decision: 'deny', duration: 'always' }],
    ['a wildcard on an IPv6 address', { host: '[::1]', wildcard: true, decision: 'allow', duration: 'always' }],
  ] as const)('refuses to store %s', async (_label, input) => {
    await expect(addPermission(input, NOW)).rejects.toThrow();
    expect(stored()).toBeUndefined();
  });

  it('prunes allow-once records older than ten minutes when adding a record', async () => {
    expect(ALLOW_ONCE_MAX_AGE_MS).toBe(10 * 60 * 1000);
    const always = await addPermission({ host: 'a.com', wildcard: false, decision: 'allow', duration: 'always' }, NOW);
    const stale = await addPermission(
      { host: 'b.com', wildcard: false, decision: 'allow', duration: 'once', toolUseId: 't1' },
      NOW,
    );
    const fresh = await addPermission(
      { host: 'c.com', wildcard: false, decision: 'allow', duration: 'once', toolUseId: 't2' },
      NOW + 60_000,
    );
    const later = NOW + ALLOW_ONCE_MAX_AGE_MS;
    const atLimit = await addPermission({ host: 'd.com', wildcard: false, decision: 'deny', duration: 'always' }, later);
    expect(await loadPermissions()).toEqual([always, stale, fresh, atLimit]);

    const added = await addPermission({ host: 'e.com', wildcard: false, decision: 'deny', duration: 'always' }, later + 1);
    expect(await loadPermissions()).toEqual([always, fresh, atLimit, added]);
  });

  it('revokes a record by id', async () => {
    const a = await addPermission({ host: 'a.com', wildcard: false, decision: 'allow', duration: 'always' }, NOW);
    const b = await addPermission({ host: 'b.com', wildcard: false, decision: 'allow', duration: 'always' }, NOW);
    expect(await revokePermission(a.id)).toBe(true);
    expect(await loadPermissions()).toEqual([b]);
    expect(await revokePermission('missing')).toBe(false);
    expect(await loadPermissions()).toEqual([b]);
  });

  it('clears all records', async () => {
    await addPermission({ host: 'a.com', wildcard: false, decision: 'allow', duration: 'always' }, NOW);
    await clearPermissions();
    expect(await loadPermissions()).toEqual([]);
  });

  it('serializes concurrent changes so none is lost', async () => {
    const hosts = ['a.com', 'b.com', 'c.com', 'd.com'];
    await Promise.all(
      hosts.map((host) => addPermission({ host, wildcard: false, decision: 'allow', duration: 'always' }, NOW)),
    );
    expect((await loadPermissions()).map((record) => record.host)).toEqual(hosts);
  });

  it('checks a URL and persists lastUsed for an allow-always record', async () => {
    const added = await addPermission({ host: 'example.com', wildcard: false, decision: 'allow', duration: 'always' }, NOW);
    const outcome = await checkSitePermission('https://example.com/', { now: NOW + 5 });
    expect(outcome).toEqual({ kind: 'allowed', host: 'example.com', recordId: added.id, consumed: false });
    expect(await loadPermissions()).toEqual([{ ...added, lastUsed: NOW + 5 }]);
  });

  it('consumes an allow-once record so the second check needs a prompt', async () => {
    await addPermission({ host: 'example.com', wildcard: false, decision: 'allow', duration: 'once', toolUseId: 't1' }, NOW);
    expect(await checkSitePermission('https://example.com/', { toolUseId: 't1', now: NOW })).toMatchObject({
      kind: 'allowed',
      consumed: true,
    });
    expect(await loadPermissions()).toEqual([]);
    expect(await checkSitePermission('https://example.com/', { toolUseId: 't1', now: NOW })).toEqual({
      kind: 'prompt',
      host: 'example.com',
    });
  });

  it('does not write storage when nothing changed', async () => {
    await addPermission({ host: 'example.com', wildcard: false, decision: 'deny', duration: 'always' }, NOW);
    browserMock.storage.local.set.mockClear();
    expect((await checkSitePermission('https://example.com/', { now: NOW })).kind).toBe('denied');
    expect((await checkSitePermission('https://other.com/', { now: NOW })).kind).toBe('prompt');
    expect((await checkSitePermission('about:blank', { now: NOW })).kind).toBe('unsupported');
    expect(browserMock.storage.local.set).not.toHaveBeenCalled();
  });

  it('keeps working after a failed storage write', async () => {
    browserMock.storage.local.set.mockRejectedValueOnce(new Error('quota'));
    await expect(
      addPermission({ host: 'a.com', wildcard: false, decision: 'allow', duration: 'always' }, NOW),
    ).rejects.toThrow('quota');
    await addPermission({ host: 'b.com', wildcard: false, decision: 'allow', duration: 'always' }, NOW);
    expect((await loadPermissions()).map((record) => record.host)).toEqual(['b.com']);
  });
});
