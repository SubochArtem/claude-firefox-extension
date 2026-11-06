// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_ENTRY_CHARS } from '../page/console-capture-api';
import { describeConsoleValue, formatConsoleArgs } from '../page/console-args';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('formatConsoleArgs', () => {
  it('joins arguments with spaces, strings without quotes', () => {
    expect(formatConsoleArgs(['Loaded', 3, 'items', true, null, undefined])).toBe('Loaded 3 items true null undefined');
    expect(formatConsoleArgs([])).toBe('');
  });

  it('shows nested strings quoted and objects compactly', () => {
    expect(formatConsoleArgs(['state', { user: 'ann', items: [1, 'two'], nested: { deep: { deeper: 1 } } }])).toBe(
      'state {user: "ann", items: [1, "two"], nested: {deep: {…}}}',
    );
  });

  it('applies format specifiers of the first string', () => {
    expect(formatConsoleArgs(['%s has %d items (%i) at %f%%', 'cart', 3.7, '42px', '1.5'])).toBe('cart has 3 items (42) at 1.5%');
    expect(formatConsoleArgs(['%o and %O', { a: 1 }, [2]])).toBe('{a: 1} and [2]');
    expect(formatConsoleArgs(['%cStyled%c text', 'color: red', 'color: blue', 'extra'])).toBe('Styled text extra');
    expect(formatConsoleArgs(['%s and %s', 'one'])).toBe('one and %s');
    expect(formatConsoleArgs([1, '%s', 2])).toBe('1 %s 2');
  });

  it('describes errors with their stack', () => {
    const error = new TypeError('bad input');
    error.stack = 'check@https://example.com/app.js:10:5\nrun@https://example.com/app.js:20:3\n';
    expect(formatConsoleArgs(['Failed:', error])).toBe(
      'Failed: TypeError: bad input\n    at check@https://example.com/app.js:10:5\n    at run@https://example.com/app.js:20:3',
    );
  });

  it('describes nested errors without their stack', () => {
    const error = new Error('inner');
    expect(formatConsoleArgs([{ cause: error }])).toBe('{cause: Error: inner}');
  });

  it('describes functions, symbols, bigints, dates, regexps, maps and sets', () => {
    function handler() {}
    expect(formatConsoleArgs([handler, () => 1, Symbol('s'), 10n, new Date(0), /a+/g])).toBe(
      '[Function handler] [Function] Symbol(s) 10n 1970-01-01T00:00:00.000Z /a+/g',
    );
    expect(formatConsoleArgs([new Map([['k', 1]]), new Set(['x'])])).toBe('Map(1) {"k" => 1} Set(1) {"x"}');
    expect(formatConsoleArgs([new Date(Number.NaN)])).toBe('Invalid Date');
  });

  it('describes DOM nodes briefly', () => {
    document.body.innerHTML = '<button id="go" class="primary big" name="submit">Go</button>';
    const button = document.querySelector('button');
    expect(formatConsoleArgs(['clicked', button])).toBe('clicked <button id="go" class="primary big" name="submit">');
    expect(formatConsoleArgs([button?.firstChild])).toBe('#text "Go"');
    expect(formatConsoleArgs([document])).toBe('#document');
  });

  it('marks circular references', () => {
    const value: Record<string, unknown> = { name: 'loop' };
    value.self = value;
    expect(formatConsoleArgs([value])).toBe('{name: "loop", self: [Circular]}');
  });

  it('shortens long arrays and objects', () => {
    expect(formatConsoleArgs([Array.from({ length: 25 }, (_, index) => index)])).toBe(
      `[${Array.from({ length: 20 }, (_, index) => index).join(', ')}, … 5 more]`,
    );
    const wide = Object.fromEntries(Array.from({ length: 22 }, (_, index) => [`k${index}`, index]));
    expect(formatConsoleArgs([wide])).toMatch(/, k19: 19, … 2 more\}$/);
  });

  it('shows a property whose getter throws', () => {
    const value = {
      get broken() {
        throw new Error('nope');
      },
    };
    expect(formatConsoleArgs([value])).toBe('{broken: [getter threw]}');
  });

  it('caps the text of an entry', () => {
    const text = formatConsoleArgs(['x'.repeat(MAX_ENTRY_CHARS * 3)]);
    expect(text).toBe(`${'x'.repeat(MAX_ENTRY_CHARS)}…`);
    const many = formatConsoleArgs(Array.from({ length: 5000 }, () => ({ key: 'value value value' })));
    expect(many.length).toBeLessThanOrEqual(MAX_ENTRY_CHARS + 1);
  });

  it('survives values that cannot be inspected', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('no keys');
        },
      },
    );
    expect(formatConsoleArgs(['value', hostile])).toBe('value [object]');
  });
});

describe('describeConsoleValue', () => {
  it('shows a top-level string as is', () => {
    expect(describeConsoleValue('plain')).toBe('plain');
  });
});
