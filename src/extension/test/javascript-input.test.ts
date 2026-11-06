import { describe, expect, it } from 'vitest';
import { MAX_CODE_LENGTH, parseJavascriptArgs } from '../tools/javascript-input';

function error(args: unknown): string {
  const result = parseJavascriptArgs(args);
  if (result.ok) throw new Error(`expected an error for ${JSON.stringify(args)}`);
  return result.error;
}

describe('parseJavascriptArgs', () => {
  it('accepts the javascript_exec action with code and keeps the code as is', () => {
    expect(parseJavascriptArgs({ action: 'javascript_exec', text: '  document.title\n' })).toEqual({
      ok: true,
      value: { text: '  document.title\n' },
    });
  });

  it('accepts a tab id', () => {
    expect(parseJavascriptArgs({ action: 'javascript_exec', text: '1', tabId: 3 })).toEqual({ ok: true, value: { text: '1', tabId: 3 } });
    expect(parseJavascriptArgs({ action: 'javascript_exec', text: '1', tabId: undefined })).toEqual({ ok: true, value: { text: '1' } });
  });

  it('requires the action', () => {
    expect(error({ text: '1' })).toBe('Missing required parameter action: "javascript_exec"');
  });

  it.each(['exec', 'javascript', 42, null])('rejects the action %j', (action) => {
    expect(error({ action, text: '1' })).toMatch(/^action must be "javascript_exec", received /);
  });

  it('requires the code', () => {
    expect(error({ action: 'javascript_exec' })).toBe('Missing required parameter text (the JavaScript code to run)');
  });

  it.each([42, null, ['1'], { code: '1' }])('rejects non-string code %j', (text) => {
    expect(error({ action: 'javascript_exec', text })).toMatch(/^text must be a string/);
  });

  it.each(['', '  ', '\n\t'])('rejects the empty code %j', (text) => {
    expect(error({ action: 'javascript_exec', text })).toBe('text must not be empty');
  });

  it('accepts code up to the size cap and rejects longer code', () => {
    expect(MAX_CODE_LENGTH).toBe(100_000);
    expect(parseJavascriptArgs({ action: 'javascript_exec', text: 'x'.repeat(MAX_CODE_LENGTH) }).ok).toBe(true);
    expect(error({ action: 'javascript_exec', text: 'x'.repeat(MAX_CODE_LENGTH + 1) })).toBe(
      `text must be at most ${MAX_CODE_LENGTH} characters, received ${MAX_CODE_LENGTH + 1}`,
    );
  });

  it('rejects an invalid tab id', () => {
    expect(error({ action: 'javascript_exec', text: '1', tabId: 0 })).toMatch(/^tabId must be a positive safe integer/);
  });

  it('rejects unknown parameters', () => {
    expect(error({ action: 'javascript_exec', text: '1', code: '2' })).toBe('Unknown parameter "code"; allowed: action, text, tabId');
  });

  it.each([undefined, null, 'code', [1]])('rejects the arguments %j', (args) => {
    expect(error(args)).toMatch(/^Expected an object with action and text parameters, received /);
  });
});
