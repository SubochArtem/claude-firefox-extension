import { describe, expect, it } from 'vitest';
import { parseFormInputArgs } from '../tools/form-input-input';

function error(args: unknown): string {
  const result = parseFormInputArgs(args);
  if (result.ok) throw new Error(`expected an error for ${JSON.stringify(args)}`);
  return result.error;
}

describe('parseFormInputArgs', () => {
  it.each(['hello', '', true, false, 0, -2.5])('accepts the value %j', (value) => {
    expect(parseFormInputArgs({ ref: 'ref_3', value })).toEqual({ ok: true, value: { ref: 'ref_3', value } });
  });

  it('accepts a tab id', () => {
    expect(parseFormInputArgs({ ref: 'ref_1', value: 'x', tabId: 7 })).toEqual({
      ok: true,
      value: { ref: 'ref_1', value: 'x', tabId: 7 },
    });
    expect(parseFormInputArgs({ ref: 'ref_1', value: 'x', tabId: undefined })).toEqual({
      ok: true,
      value: { ref: 'ref_1', value: 'x' },
    });
  });

  it('requires a ref', () => {
    expect(error({ value: 'x' })).toBe('ref is required: an element reference like ref_12 from read_page or find');
    expect(error(undefined)).toMatch(/^ref is required/);
  });

  it.each([42, null, ['ref_1']])('rejects a non-string ref %j', (ref) => {
    expect(error({ ref, value: 'x' })).toMatch(/^ref must be a string/);
  });

  it.each(['', 'ref_', 'ref_x', '12', ' ref_1', 'ref_1 '])('rejects the malformed ref %j', (ref) => {
    expect(error({ ref, value: 'x' })).toMatch(/^ref must look like ref_12 \(from read_page or find\), received /);
  });

  it('requires a value', () => {
    expect(error({ ref: 'ref_1' })).toBe('value is required: a string, boolean or number');
  });

  it.each([null, ['a'], { a: 1 }, Number.NaN, Number.POSITIVE_INFINITY])('rejects the value %j', (value) => {
    expect(error({ ref: 'ref_1', value })).toMatch(/^value must be a string, boolean or finite number, received /);
  });

  it.each([0, -1, 1.5, '5', null])('rejects tabId %j', (tabId) => {
    expect(error({ ref: 'ref_1', value: 'x', tabId })).toMatch(/tabId/);
  });

  it('rejects unknown parameters', () => {
    expect(error({ ref: 'ref_1', value: 'x', text: 'y' })).toBe('Unknown parameter "text"; allowed: ref, value, tabId');
  });

  it('rejects a non-object', () => {
    expect(error('ref_1')).toMatch(/^Expected an object of parameters/);
  });
});
