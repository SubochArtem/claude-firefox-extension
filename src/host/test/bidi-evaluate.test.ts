import { describe, expect, it } from 'vitest';
import { BidiError, BidiUnavailableError } from '../bidi-client';
import { asyncWrapped, runBidiEvaluate, type BidiEvaluateTimeouts } from '../bidi-evaluate';
import { closedPort, HANG, startFakeBidi, type BidiReply, type FakeBidi } from './fake-bidi';
import { waitFor } from './helpers';

const MARKER = { name: '__claudeTabMarker_0123456789abcdef', value: 'a'.repeat(32) };
const URL_A = 'https://a.example/';
const FAST: BidiEvaluateTimeouts = { connect: 2_000, command: 300, evaluate: 300, script: 300 };

function request(code: string) {
  return { marker: MARKER, url: URL_A, code };
}

function success(result: unknown): BidiReply {
  return { result: { type: 'success', result, realm: 'r' } };
}

function exception(text: string, callFrames: unknown[] = []): BidiReply {
  return {
    result: {
      type: 'exception',
      exceptionDetails: { text, lineNumber: 0, columnNumber: 0, exception: { type: 'error' }, stackTrace: { callFrames } },
      realm: 'r',
    },
  };
}

async function firefox(script: FakeBidi['script']): Promise<FakeBidi> {
  const fake = await startFakeBidi();
  fake.contexts.push({ context: 'ctx-b', url: 'https://b.example/' }, { context: 'ctx-a', url: URL_A, marker: MARKER.value });
  fake.script = script;
  return fake;
}

function scriptCalls(fake: FakeBidi): Record<string, unknown>[] {
  return fake.commands
    .filter((command) => command.method === 'script.evaluate' && !String(command.params['expression']).startsWith('window['))
    .map((command) => command.params);
}

describe('runBidiEvaluate', () => {
  it('evaluates the code in the marked context and returns the remote value', async () => {
    const fake = await firefox(() => success({ type: 'string', value: 'Example' }));
    await expect(runBidiEvaluate(request('document.title'), fake.port, FAST)).resolves.toEqual({
      value: { type: 'string', value: 'Example' },
    });
    expect(scriptCalls(fake)).toEqual([
      {
        expression: 'document.title',
        target: { context: 'ctx-a' },
        awaitPromise: true,
        resultOwnership: 'none',
        serializationOptions: { maxObjectDepth: 4, maxDomDepth: 0, includeShadowTree: 'none' },
      },
    ]);
    expect(fake.methods()).toEqual(['session.new', 'browsingContext.getTree', 'script.evaluate', 'script.evaluate', 'session.end']);
    expect(fake.commands.every((command) => command.connection === 1)).toBe(true);
    await waitFor(() => expect(fake.openConnections()).toBe(0));
  });

  it('returns an uncaught exception with its stack', async () => {
    const fake = await firefox(() =>
      exception('Error: boom', [
        { functionName: 'load', url: 'https://a.example/app.js', lineNumber: 9, columnNumber: 4 },
        { functionName: '', url: '', lineNumber: 0, columnNumber: 0 },
      ]),
    );
    await expect(runBidiEvaluate(request('load()'), fake.port, FAST)).resolves.toEqual({
      exception: 'Error: boom\n    at load (https://a.example/app.js:10:5)\n    at <anonymous> (<script>:1:1)',
    });
    expect(scriptCalls(fake)).toHaveLength(1);
    expect(fake.methods().at(-1)).toBe('session.end');
  });

  it('caps a long exception text and stack', async () => {
    const frames = Array.from({ length: 50 }, (_, i) => ({ functionName: `f${i}`, url: 'u', lineNumber: 0, columnNumber: 0 }));
    const fake = await firefox(() => exception(`Error: ${'x'.repeat(20_000)}`, frames));
    const outcome = await runBidiEvaluate(request('f0()'), fake.port, FAST);
    const text = (outcome as { exception: string }).exception;
    expect(text.length).toBeLessThan(11_000);
    expect(text).toMatch(/…$/);
    const fakeStack = await firefox(() => exception('Error: deep', frames));
    const stack = ((await runBidiEvaluate(request('f0()'), fakeStack.port, FAST)) as { exception: string }).exception;
    expect(stack.split('\n')).toHaveLength(1 + 20 + 1);
    expect(stack.split('\n').at(-1)).toBe('    … 30 more frames');
  });

  it.each([
    'SyntaxError: await is only valid in async functions, async generators and modules',
    'SyntaxError: return not in function',
    'SyntaxError: Illegal return statement',
  ])('re-runs the code as an async function after "%s"', async (text) => {
    const code = 'const r = await fetch("/x");\nreturn r.status // done';
    const fake = await firefox((params) =>
      params['expression'] === code ? exception(text) : success({ type: 'number', value: 200 }),
    );
    await expect(runBidiEvaluate(request(code), fake.port, FAST)).resolves.toEqual({ value: { type: 'number', value: 200 } });
    expect(scriptCalls(fake).map((params) => params['expression'])).toEqual([code, asyncWrapped(code)]);
    expect(asyncWrapped(code)).toBe(`(async () => {\n${code}\n})()`);
    expect(scriptCalls(fake)[1]).toMatchObject({ target: { context: 'ctx-a' }, awaitPromise: true, resultOwnership: 'none' });
    expect(fake.methods().filter((method) => method === 'session.new')).toHaveLength(1);
    expect(fake.methods().at(-1)).toBe('session.end');
  });

  it('reports the exception of the async re-run', async () => {
    const fake = await firefox((params) =>
      String(params['expression']).startsWith('(async') ? exception('TypeError: x is undefined') : exception('SyntaxError: return not in function'),
    );
    await expect(runBidiEvaluate(request('return x.y'), fake.port, FAST)).resolves.toEqual({ exception: 'TypeError: x is undefined' });
  });

  it.each([
    'SyntaxError: unexpected token: identifier',
    'ReferenceError: await is not defined',
    'await is only valid in async functions, async generators and modules',
    'Error: SyntaxError: return not in function',
  ])(
    'does not re-run after "%s"',
    async (text) => {
      const fake = await firefox(() => exception(text));
      await expect(runBidiEvaluate(request('a b'), fake.port, FAST)).resolves.toEqual({ exception: text });
      expect(scriptCalls(fake)).toHaveLength(1);
    },
  );

  it('does not re-run a SyntaxError thrown at run time', async () => {
    const frames = [{ functionName: 'f', url: 'https://example.com/a.js', lineNumber: 0, columnNumber: 0 }];
    const fake = await firefox(() => exception('SyntaxError: return not in function', frames));
    const outcome = await runBidiEvaluate(request('f()'), fake.port, FAST);
    expect(outcome).toEqual({ exception: 'SyntaxError: return not in function\n    at f (https://example.com/a.js:1:1)' });
    expect(scriptCalls(fake)).toHaveLength(1);
  });

  it('does not re-run when the exception has no stack trace', async () => {
    const text = 'SyntaxError: return not in function';
    const fake = await firefox(() => ({
      result: { type: 'exception', exceptionDetails: { text, lineNumber: 0, columnNumber: 0, exception: { type: 'error' } }, realm: 'r' },
    }));
    await expect(runBidiEvaluate(request('return 1'), fake.port, FAST)).resolves.toEqual({ exception: text });
    expect(scriptCalls(fake)).toHaveLength(1);
  });

  it('fails with an unavailable error when Firefox is not listening', async () => {
    const port = await closedPort();
    const error = await runBidiEvaluate(request('1'), port, FAST).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BidiUnavailableError);
    expect((error as Error).message).toContain(`--remote-debugging-port=${port}`);
  });

  it('fails with an unavailable error when no context carries the marker', async () => {
    const fake = await firefox(() => success({ type: 'number', value: 1 }));
    fake.contexts.splice(1, 1, { context: 'ctx-a', url: URL_A });
    const error = await runBidiEvaluate(request('1'), fake.port, FAST).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BidiUnavailableError);
    expect(scriptCalls(fake)).toEqual([]);
    expect(fake.methods().at(-1)).toBe('session.end');
  });

  it('times out a script that does not finish and still ends the session', async () => {
    const fake = await firefox(() => HANG);
    const error = await runBidiEvaluate(request('while (true) {}'), fake.port, FAST).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BidiError);
    expect(error).not.toBeInstanceOf(BidiUnavailableError);
    expect((error as Error).message).toBe(
      'The script did not finish within 0.3 s. WebDriver BiDi cannot stop a running script, so it may still be running in the page.',
    );
    expect(fake.methods().at(-1)).toBe('session.end');
    await waitFor(() => expect(fake.openConnections()).toBe(0));
  });

  it('counts the async re-run against the same script deadline', async () => {
    const fake = await firefox(async (params) => {
      if (String(params['expression']).startsWith('(async')) return HANG;
      await new Promise((resolve) => setTimeout(resolve, 200));
      return exception('SyntaxError: return not in function');
    });
    const started = Date.now();
    await expect(runBidiEvaluate(request('return 1'), fake.port, FAST)).rejects.toThrow(/did not finish within 0.3 s/);
    expect(Date.now() - started).toBeLessThan(550);
  });

  it('fails without unavailable on an error response and ends the session', async () => {
    const fake = await firefox(() => ({ error: 'no such frame', message: 'gone' }));
    const error = await runBidiEvaluate(request('1'), fake.port, FAST).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BidiError);
    expect(error).not.toBeInstanceOf(BidiUnavailableError);
    expect((error as Error).message).toBe('Firefox WebDriver BiDi script.evaluate failed: no such frame: gone');
    expect(fake.methods().at(-1)).toBe('session.end');
  });

  it('fails on a malformed evaluate result', async () => {
    const fake = await firefox(() => ({ result: { type: 'odd' } }));
    await expect(runBidiEvaluate(request('1'), fake.port, FAST)).rejects.toThrow('Firefox returned a malformed WebDriver BiDi script.evaluate result');
    expect(fake.methods().at(-1)).toBe('session.end');
  });

  it('stops waiting for the script on abort and ends the session', async () => {
    const fake = await firefox(() => HANG);
    const controller = new AbortController();
    const run = runBidiEvaluate(request('1'), fake.port, { ...FAST, script: 30_000 }, controller.signal);
    await waitFor(() => expect(scriptCalls(fake)).toHaveLength(1));
    controller.abort();
    await expect(run).rejects.toThrow(/stopped/);
    expect(fake.methods().at(-1)).toBe('session.end');
  });
});
