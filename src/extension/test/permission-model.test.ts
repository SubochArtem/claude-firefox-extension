import { describe, expect, it } from 'vitest';
import { checkPermission, parsePermissionRecords, type PermissionRecord } from '../permissions/permission-model';

const NOW = 1_700_000_000_000;

function record(overrides: Partial<PermissionRecord>): PermissionRecord {
  return {
    id: 'id-1',
    host: 'example.com',
    wildcard: false,
    decision: 'allow',
    duration: 'always',
    createdAt: NOW - 1000,
    ...overrides,
  };
}

describe('checkPermission', () => {
  it('refuses unsupported URLs before looking at records', () => {
    const records = [record({ host: 'example.com', wildcard: true })];
    const result = checkPermission(records, 'about:config', { now: NOW });
    expect(result.outcome.kind).toBe('unsupported');
    if (result.outcome.kind === 'unsupported') expect(result.outcome.reason).toContain('about:');
    expect(result.records).toBe(records);
  });

  it('asks for a prompt when no record matches', () => {
    const records = [record({ host: 'other.com' })];
    const result = checkPermission(records, 'https://example.com/', { now: NOW });
    expect(result.outcome).toEqual({ kind: 'prompt', host: 'example.com' });
    expect(result.records).toBe(records);
  });

  it('allows a host with an allow-always record and updates lastUsed', () => {
    const records = [record({ id: 'a' })];
    const result = checkPermission(records, 'https://www.example.com/page', { now: NOW });
    expect(result.outcome).toEqual({ kind: 'allowed', host: 'example.com', recordId: 'a', consumed: false });
    expect(result.records).toEqual([record({ id: 'a', lastUsed: NOW })]);
    expect(records[0]?.lastUsed).toBeUndefined();
  });

  it('allows subdomains only through a wildcard record', () => {
    const exact = [record({ id: 'a' })];
    expect(checkPermission(exact, 'https://mail.example.com/', { now: NOW }).outcome.kind).toBe('prompt');
    const wildcard = [record({ id: 'a', wildcard: true })];
    expect(checkPermission(wildcard, 'https://mail.example.com/', { now: NOW }).outcome).toMatchObject({
      kind: 'allowed',
      recordId: 'a',
    });
  });

  it('ignores the port', () => {
    const records = [record({ id: 'a', host: 'localhost' })];
    expect(checkPermission(records, 'http://localhost:3000/', { now: NOW }).outcome.kind).toBe('allowed');
  });

  it('denies a host with an always-deny record', () => {
    const records = [record({ id: 'd', decision: 'deny' })];
    const result = checkPermission(records, 'https://example.com/', { now: NOW });
    expect(result.outcome).toEqual({ kind: 'denied', host: 'example.com', recordId: 'd' });
    expect(result.records).toBe(records);
  });

  it('lets deny win over allow-always and allow-once', () => {
    const records = [
      record({ id: 'a', wildcard: true }),
      record({ id: 'o', duration: 'once', toolUseId: 'tool-1' }),
      record({ id: 'd', host: 'mail.example.com', decision: 'deny' }),
    ];
    const result = checkPermission(records, 'https://mail.example.com/', { now: NOW, toolUseId: 'tool-1' });
    expect(result.outcome).toEqual({ kind: 'denied', host: 'mail.example.com', recordId: 'd' });
    expect(result.records).toBe(records);
  });

  it('applies a wildcard deny to subdomains', () => {
    const records = [record({ id: 'a', host: 'mail.example.com' }), record({ id: 'd', decision: 'deny', wildcard: true })];
    expect(checkPermission(records, 'https://mail.example.com/', { now: NOW }).outcome).toMatchObject({
      kind: 'denied',
      recordId: 'd',
    });
  });

  it('allows and consumes an allow-once record with the same toolUseId and host', () => {
    const always = record({ id: 'a', host: 'other.com' });
    const once = record({ id: 'o', duration: 'once', toolUseId: 'tool-1' });
    const result = checkPermission([always, once], 'https://example.com/', { now: NOW, toolUseId: 'tool-1' });
    expect(result.outcome).toEqual({ kind: 'allowed', host: 'example.com', recordId: 'o', consumed: true });
    expect(result.records).toEqual([always]);
  });

  it('prefers a matching allow-once record over allow-always', () => {
    const records = [record({ id: 'a' }), record({ id: 'o', duration: 'once', toolUseId: 'tool-1' })];
    const result = checkPermission(records, 'https://example.com/', { now: NOW, toolUseId: 'tool-1' });
    expect(result.outcome).toMatchObject({ kind: 'allowed', recordId: 'o', consumed: true });
    expect(result.records).toEqual([record({ id: 'a' })]);
  });

  it('ignores an allow-once record for another toolUseId or host', () => {
    const records = [
      record({ id: 'o1', duration: 'once', toolUseId: 'tool-1' }),
      record({ id: 'o2', host: 'other.com', duration: 'once', toolUseId: 'tool-2' }),
    ];
    expect(checkPermission(records, 'https://example.com/', { now: NOW, toolUseId: 'tool-2' }).outcome.kind).toBe('prompt');
    expect(checkPermission(records, 'https://example.com/', { now: NOW }).outcome.kind).toBe('prompt');
  });

  it('has no time-based expiry', () => {
    const records = [record({ id: 'a', createdAt: 0, lastUsed: 1 })];
    expect(checkPermission(records, 'https://example.com/', { now: NOW }).outcome.kind).toBe('allowed');
  });
});

describe('parsePermissionRecords', () => {
  const valid = record({ id: 'a', lastUsed: NOW });
  const once = record({ id: 'o', duration: 'once', toolUseId: 'tool-1' });

  it('keeps valid records', () => {
    expect(parsePermissionRecords([valid, once])).toEqual([valid, once]);
  });

  it.each([undefined, null, 'x', 1, {}])('returns no records for non-array data %j', (value) => {
    expect(parsePermissionRecords(value)).toEqual([]);
  });

  it.each([
    ['null', null],
    ['a string', 'record'],
    ['missing id', { ...valid, id: undefined }],
    ['empty id', { ...valid, id: '' }],
    ['non-string host', { ...valid, host: 1 }],
    ['unnormalized host', { ...valid, host: 'www.Example.com' }],
    ['invalid host', { ...valid, host: 'example.com/path' }],
    ['non-boolean wildcard', { ...valid, wildcard: 'yes' }],
    ['wildcard on a single-label host', { ...valid, host: 'localhost', wildcard: true }],
    ['wildcard on a top-level domain', { ...valid, host: 'com', wildcard: true }],
    ['wildcard on an IPv4 address', { ...valid, host: '127.0.0.1', wildcard: true }],
    ['wildcard on an IPv6 address', { ...valid, host: '[::1]', wildcard: true }],
    ['unknown decision', { ...valid, decision: 'maybe' }],
    ['unknown duration', { ...valid, duration: 'forever' }],
    ['deny once', { ...once, decision: 'deny' }],
    ['once without toolUseId', { ...once, toolUseId: undefined }],
    ['once with empty toolUseId', { ...once, toolUseId: '' }],
    ['always with toolUseId', { ...valid, toolUseId: 'tool-1' }],
    ['non-number createdAt', { ...valid, createdAt: '1' }],
    ['non-finite createdAt', { ...valid, createdAt: Number.NaN }],
    ['non-number lastUsed', { ...valid, lastUsed: 'yesterday' }],
  ])('drops a record with %s', (_label, bad) => {
    expect(parsePermissionRecords([valid, bad, once])).toEqual([valid, once]);
  });

  it('keeps exact records on single-label hosts and IP addresses', () => {
    const exact = ['localhost', '127.0.0.1', '[::1]'].map((host, index) => record({ id: `e${index}`, host }));
    expect(parsePermissionRecords(exact)).toEqual(exact);
  });

  it('drops a record whose id repeats an earlier one', () => {
    expect(parsePermissionRecords([valid, { ...once, id: 'a' }])).toEqual([valid]);
  });

  it('copies only known fields', () => {
    expect(parsePermissionRecords([{ ...valid, extra: 1 }])).toEqual([valid]);
  });
});
