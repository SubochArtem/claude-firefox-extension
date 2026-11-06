// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatRemoteValue, MAX_FORMATTED_CHARS } from '../../host/remote-value-format';
import { evaluateInMainWorld, type MainWorldEvalResult } from '../page/main-world-eval';

async function formatted(code: string): Promise<string> {
  const result = await evaluateInMainWorld(code);
  if (result.kind !== 'value') throw new Error(`expected a value, got ${JSON.stringify(result)}`);
  return formatRemoteValue(result.value);
}

async function exception(code: string): Promise<string> {
  const result = await evaluateInMainWorld(code);
  if (result.kind !== 'exception') throw new Error(`expected an exception, got ${JSON.stringify(result)}`);
  return result.text;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  delete (globalThis as Record<string, unknown>).__mainWorldEvalTest;
});

describe('evaluateInMainWorld', () => {
  it('returns the completion value of the last statement', async () => {
    expect(await formatted('const a = 2; a * 21')).toBe('42');
    expect(await formatted('"text"')).toBe('text');
    expect(await formatted('let x = 1')).toBe('undefined');
  });

  it('sees page globals in the global scope', async () => {
    (globalThis as Record<string, unknown>).__mainWorldEvalTest = 'from the page';
    document.title = 'Page title';
    expect(await formatted('__mainWorldEvalTest')).toBe('from the page');
    expect(await formatted('document.title')).toBe('Page title');
  });

  it('runs code with top-level await or return as an async function', async () => {
    // As on the BiDi path, code run as a function body gives its result only through return.
    expect(await formatted('await Promise.resolve(5)')).toBe('undefined');
    expect(await formatted('const value = await Promise.resolve("x");\nreturn value + "y"')).toBe('xy');
    expect(await formatted('return 7 // trailing comment')).toBe('7');
  });

  it('awaits a returned promise', async () => {
    expect(await formatted('Promise.resolve([1, 2])')).toBe('[1, 2]');
  });

  it('reports thrown errors and rejected promises with their message and stack', async () => {
    const text = await exception('function failing() { throw new TypeError("boom"); }\nfailing()');
    expect(text.split('\n')[0]).toBe('TypeError: boom');
    expect(text).toMatch(/\n {4}at /);
    expect((await exception('Promise.reject(new Error("rejected"))')).split('\n')[0]).toBe('Error: rejected');
    expect(await exception('throw "plain"')).toBe('Uncaught "plain"');
    expect(await exception('throw 42')).toBe('Uncaught 42');
  });

  it('reports a syntax error that is not about await or return without retrying', async () => {
    expect((await exception('1 +')).split('\n')[0]).toMatch(/^SyntaxError: /);
  });

  it('reports a refused eval as blocked without running the code', async () => {
    const evalSpy = vi.fn(() => {
      throw new EvalError('call to eval() blocked by CSP');
    });
    vi.stubGlobal('eval', evalSpy);
    const result: MainWorldEvalResult = await evaluateInMainWorld('window.ran = true');
    expect(result).toEqual({ kind: 'blocked', text: expect.stringMatching(/^EvalError: call to eval\(\) blocked by CSP/) });
    expect(evalSpy).toHaveBeenCalledTimes(1);
    expect(evalSpy).toHaveBeenCalledWith('0');
  });

  it('serializes primitives like the BiDi formatter shows them', async () => {
    expect(await formatted('[undefined, null, true, -0, NaN, Infinity, 10n, Symbol("s"), () => 1]')).toBe(
      '[undefined, null, true, -0, NaN, Infinity, 10n, Symbol(), [Function]]',
    );
  });

  it('serializes objects, maps, sets, dates, regexps and errors', async () => {
    expect(await formatted('({ a: 1, "b-c": "x" })')).toBe('{a: 1, "b-c": "x"}');
    expect(await formatted('new Map([["k", 1]])')).toBe('Map(1) {"k" => 1}');
    expect(await formatted('new Set([1, 2])')).toBe('Set(2) {1, 2}');
    expect(await formatted('new Date(0)')).toBe('Date(1970-01-01T00:00:00.000Z)');
    expect(await formatted('/a+b/gi')).toBe('/a+b/gi');
    expect(await formatted('new RangeError("out of range")')).toBe('{name: "RangeError", message: "out of range"}');
    expect(await formatted('[Promise.resolve(1), new WeakMap(), new Uint8Array(2), new ArrayBuffer(1), window]')).toBe(
      '[[Promise], [WeakMap], [TypedArray], [ArrayBuffer], [Window]]',
    );
  });

  it('marks circular and repeated references', async () => {
    expect(await formatted('const o = { name: "loop" }; o.self = o; o')).toBe('<ref *1> {name: "loop", self: [Ref *1]}');
    expect(await formatted('const shared = [1]; [shared, shared]')).toBe('[<ref *1> [1], [Ref *1]]');
  });

  it('cuts objects nested deeper than four levels', async () => {
    expect(await formatted('({ a: { b: { c: { d: { e: 1 } } } } })')).toBe('{a: {b: {c: {d: [Object]}}}}');
  });

  it('describes DOM nodes briefly', async () => {
    document.body.innerHTML = '<a id="home" class="nav" href="/start">Home <b>page</b></a><!--note-->';
    expect(await formatted('document.querySelector("a")')).toBe('<a id="home" class="nav" href="/start">');
    expect(await formatted('document.querySelector("a").firstChild')).toBe('#text "Home"');
    expect(await formatted('document.body.lastChild')).toBe('<!--note-->');
    expect(await formatted('document.querySelectorAll("a, b")')).toBe('NodeList(2) [<a id="home" class="nav" href="/start">, <b>]');
  });

  it('shows a property whose getter throws', async () => {
    expect(await formatted('({ get broken() { throw new Error("nope"); } })')).toBe('{broken: "[getter threw: Error: nope]"}');
  });

  it('redacts sensitive keys and JWT-like strings through the shared formatter', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
    expect(await formatted(`({ password: "hunter2", user: "ann", token: "${jwt}" })`)).toBe(
      '{password: [REDACTED], user: "ann", token: [REDACTED]}',
    );
    expect(await formatted(`["${jwt}"]`)).toBe('[[REDACTED]]');
    expect(await formatted(`"${jwt}"`)).toBe('[REDACTED]');
  });

  it('caps huge strings and long arrays at the formatter limit', async () => {
    const long = await formatted('"x".repeat(200000)');
    expect(long).toBe(`${'x'.repeat(MAX_FORMATTED_CHARS)}\n[Output truncated at ${MAX_FORMATTED_CHARS} characters]`);
    const result = await evaluateInMainWorld('Array.from({ length: 1000000 }, (_, i) => i)');
    if (result.kind !== 'value') throw new Error('expected a value');
    expect((result.value as { value: unknown[] }).value.length).toBeLessThan(20_000);
    expect(formatRemoteValue(result.value)).toMatch(/\[Output truncated at 50000 characters\]$/);
  });
});
