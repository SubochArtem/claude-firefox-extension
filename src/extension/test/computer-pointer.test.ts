import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ELEMENT_POINT_ENTRY, type ElementPointEntry, type ElementPointResult } from '../page/element-point-api';
import { READ_PAGE_SCRIPT } from '../page/read-page-api';
import {
  SYNTHETIC_INPUT_ENTRY,
  type SyntheticInputEntry,
  type SyntheticInputResult,
} from '../page/synthetic-input-api';
import type { ApprovalPrompt } from '../permissions/approval';
import type { ClientApprovals } from '../permissions/client-prompt';
import { deniedMessage } from '../permissions/site-access';
import type { ToolResponse } from '../protocol';
import { executeTool } from '../tools';
import type { BidiInputChannel, BidiInputResult } from '../tools/bidi-input';
import {
  ACTIVATE_SETTLE_MS,
  BACKGROUND_SCROLL_NOTE,
  inputPageChangedMessage,
  SCROLL_SETTLE_MS,
  siteChangedNote,
} from '../tools/computer-pointer';
import { screenshotFrames } from '../tools/coordinate-frame';
import { clickActions, dragActions, hoverActions, scrollActions } from '../tools/input-actions';
import { unapprovedText } from '../tools/navigate';
import { fallbackWarning } from '../tools/synthetic-input';
import { mockBrowser } from './browser-mock';

const TAB = 5;
const OTHER_TAB = 6;
const PAGE = 'https://example.com/';
const CAPTURED = 'Y2FwdHVyZWQ=';
// The last screenshot frame is half the viewport, so frame coordinates map to twice their value.
const VIEWPORT = { width: 800, height: 600 };
const FRAME = { width: 400, height: 300 };

type Injection = browser.scripting.ScriptInjection<unknown[], unknown>;

let browserMock: ReturnType<typeof mockBrowser>;
let tabs: Map<number, Partial<browser.tabs.Tab>>;
let entry: ReturnType<typeof vi.fn<ElementPointEntry>>;
let pointResult: ElementPointResult;
let inputResult: BidiInputResult;
let synthetic: ReturnType<typeof vi.fn<SyntheticInputEntry>>;
let syntheticResult: SyntheticInputResult;
let channel: BidiInputChannel & { request: ReturnType<typeof vi.fn<BidiInputChannel['request']>> };

function runInjection(injection: Injection): browser.scripting.InjectionResult<unknown>[] {
  if (injection.world === 'MAIN') return [{ frameId: 0, result: undefined }];
  if (injection.injectImmediately) {
    return [{ frameId: 0, result: { ...VIEWPORT, devicePixelRatio: 1, scrollX: 0, scrollY: 0 } }];
  }
  if (injection.files) {
    vi.stubGlobal(ELEMENT_POINT_ENTRY, entry);
    vi.stubGlobal(SYNTHETIC_INPUT_ENTRY, synthetic);
    return [{ frameId: 0, result: undefined }];
  }
  const func = injection.func as (...args: unknown[]) => unknown;
  return [{ frameId: 0, result: func(...(injection.args ?? [])) }];
}

function pageInjections(): Injection[] {
  return browserMock.scripting.executeScript.mock.calls
    .map(([injection]) => injection)
    .filter((injection) => injection.world !== 'MAIN' && !injection.injectImmediately);
}

function sentActions(): unknown[] {
  return channel.request.mock.calls.map(([request]) => request.actions);
}

function navigateTab(tabId: number, url: string): void {
  const tab = tabs.get(tabId);
  if (tab) tab.url = url;
}

beforeEach(() => {
  browserMock = mockBrowser();
  browserMock.allowSites('example.com', 'other.example');
  tabs = new Map([
    [TAB, { id: TAB, windowId: 1, url: PAGE, active: true }],
    [OTHER_TAB, { id: OTHER_TAB, windowId: 1, url: 'https://other.example/', active: false }],
  ]);
  browserMock.tabs.get.mockImplementation(async (tabId) => {
    const tab = tabs.get(tabId);
    if (!tab) throw new Error(`Invalid tab ID: ${tabId}`);
    return { ...tab };
  });
  browserMock.query.mockImplementation(async (query) => [...tabs.values()].filter((tab) => !query.active || tab.active));
  browserMock.tabs.update.mockImplementation(async (tabId, properties) => {
    const tab = tabs.get(tabId);
    if (!tab) throw new Error(`Invalid tab ID: ${tabId}`);
    if (properties.active) for (const other of tabs.values()) other.active = other === tab;
    return { ...tab };
  });
  browserMock.permissions.contains.mockResolvedValue(true);
  browserMock.scripting.executeScript.mockImplementation(async (injection) => runInjection(injection));
  browserMock.tabs.captureTab.mockImplementation(async () => `data:image/jpeg;base64,${CAPTURED}`);
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ ...VIEWPORT, close: vi.fn() })),
  );
  pointResult = { ok: true, x: 150, y: 75.5 };
  entry = vi.fn<ElementPointEntry>(() => pointResult);
  inputResult = { ok: true };
  syntheticResult = { ok: true };
  synthetic = vi.fn<SyntheticInputEntry>(() => syntheticResult);
  channel = {
    request: vi.fn<BidiInputChannel['request']>(async () => inputResult),
    handleResponse: vi.fn(),
    close: vi.fn(),
  };
  screenshotFrames.record(TAB, VIEWPORT, FRAME);
});

afterEach(() => {
  screenshotFrames.forget(TAB);
  screenshotFrames.forget(OTHER_TAB);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function run(args: Record<string, unknown>, connected = true): Promise<ToolResponse> {
  return executeTool({ type: 'tool_request', id: '1:1', tool: 'computer', args }, undefined, connected ? channel : undefined);
}

function texts(response: ToolResponse): string[] {
  if (!('result' in response)) throw new Error(`expected a result, got ${JSON.stringify(response)}`);
  return response.result.content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
}

async function text(args: Record<string, unknown>): Promise<string> {
  const response = await run(args);
  const [first, ...rest] = texts(response);
  expect(rest).toEqual([]);
  return first ?? '';
}

async function failure(args: Record<string, unknown>, connected = true): Promise<string> {
  const response = await run(args, connected);
  if (!('error' in response)) throw new Error(`expected an error, got ${JSON.stringify(response)}`);
  const [block] = response.error.content;
  return block?.type === 'text' ? block.text : '';
}

function built<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe('computer clicks', () => {
  it('clicks at a frame coordinate mapped to viewport CSS pixels', async () => {
    expect(await text({ action: 'left_click', coordinate: [10, 20] })).toBe('Clicked at (10, 20)');
    expect(channel.request).toHaveBeenCalledWith({
      marker: expect.objectContaining({ name: expect.any(String) }),
      url: PAGE,
      actions: built(clickActions({ point: { x: 20, y: 40 } })),
    });
  });

  it.each([
    ['right_click', 'Right-clicked', { button: 'right' as const, clickCount: 1 }],
    ['double_click', 'Double-clicked', { button: 'left' as const, clickCount: 2 }],
    ['triple_click', 'Triple-clicked', { button: 'left' as const, clickCount: 3 }],
  ])('%s uses its button and click count', async (action, verb, options) => {
    expect(await text({ action, coordinate: [100, 50] })).toBe(`${verb} at (100, 50)`);
    expect(sentActions()).toEqual([built(clickActions({ point: { x: 200, y: 100 }, ...options }))]);
  });

  it('holds the modifiers during the click', async () => {
    await text({ action: 'left_click', coordinate: [1, 2], modifiers: 'ctrl+shift' });
    expect(sentActions()).toEqual([built(clickActions({ point: { x: 2, y: 4 }, modifiers: 'ctrl+shift' }))]);
    expect(sentActions()[0]).toHaveLength(2);
  });

  it('clicks the center of a ref after the page scrolled it into view', async () => {
    expect(await text({ action: 'left_click', ref: 'ref_3' })).toBe('Clicked on element ref_3');
    expect(entry).toHaveBeenCalledWith({ ref: 'ref_3' });
    expect(pageInjections().some((injection) => injection.files?.[0] === READ_PAGE_SCRIPT)).toBe(true);
    expect(sentActions()).toEqual([built(clickActions({ point: { x: 150, y: 75.5 } }))]);
  });

  it.each([
    ['double_click', 'Double-clicked on element ref_4'],
    ['right_click', 'Right-clicked on element ref_4'],
    ['triple_click', 'Triple-clicked on element ref_4'],
  ])('%s reports a ref target', async (action, expected) => {
    expect(await text({ action, ref: 'ref_4' })).toBe(expected);
  });

  it('clicks a ref without a screenshot of the tab', async () => {
    screenshotFrames.forget(TAB);
    expect(await text({ action: 'left_click', ref: 'ref_3' })).toBe('Clicked on element ref_3');
  });

  it('reports a ref the page cannot resolve and sends no input', async () => {
    pointResult = { ok: false, error: 'ref_3 was not found in this page. Call read_page or find to get fresh element references.' };
    expect(await failure({ action: 'left_click', ref: 'ref_3' })).toBe(pointResult.error);
    expect(channel.request).not.toHaveBeenCalled();
  });

  it('clicks in the given tab', async () => {
    screenshotFrames.record(OTHER_TAB, VIEWPORT, VIEWPORT);
    await text({ action: 'left_click', coordinate: [7, 8], tabId: OTHER_TAB });
    expect(channel.request).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://other.example/' }));
    expect(sentActions()).toEqual([built(clickActions({ point: { x: 7, y: 8 } }))]);
  });
});

describe('computer hover and drag', () => {
  it('hovers at a frame coordinate', async () => {
    expect(await text({ action: 'hover', coordinate: [30, 40] })).toBe('Hovered at (30, 40)');
    expect(sentActions()).toEqual([built(hoverActions({ x: 60, y: 80 }))]);
  });

  it('hovers over a ref', async () => {
    expect(await text({ action: 'hover', ref: 'ref_8' })).toBe('Hovered over element ref_8');
    expect(entry).toHaveBeenCalledWith({ ref: 'ref_8' });
    expect(sentActions()).toEqual([built(hoverActions({ x: 150, y: 75.5 }))]);
  });

  it('drags between two mapped frame coordinates', async () => {
    expect(await text({ action: 'left_click_drag', start_coordinate: [10, 10], coordinate: [100, 50] })).toBe(
      'Dragged from (10, 10) to (100, 50)',
    );
    expect(sentActions()).toEqual([built(dragActions({ x: 20, y: 20 }, { x: 200, y: 100 }))]);
  });
});

describe('computer scroll', () => {
  it('scrolls at a mapped coordinate, waits for the page to settle and attaches a screenshot', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = run({ action: 'scroll', coordinate: [50, 60], scroll_direction: 'down', scroll_amount: 5 });
    await vi.advanceTimersByTimeAsync(SCROLL_SETTLE_MS - 1);
    expect(sentActions()).toEqual([built(scrollActions({ point: { x: 100, y: 120 }, direction: 'down', amount: 5 }))]);
    expect(browserMock.tabs.captureTab).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;
    expect(texts(response)).toEqual(['Scrolled down by 5 ticks at (50, 60)', 'Captured screenshot (800x600, jpeg)']);
    expect(response).toMatchObject({ result: { content: [{}, {}, { type: 'image', data: CAPTURED, mimeType: 'image/jpeg' }] } });
    expect(browserMock.tabs.captureTab).toHaveBeenCalledWith(TAB, expect.anything());
    expect(screenshotFrames.get(TAB)).toEqual({ viewport: VIEWPORT, frame: VIEWPORT });
  });

  it('uses the default amount', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = run({ action: 'scroll', coordinate: [1, 1], scroll_direction: 'left' });
    await vi.advanceTimersByTimeAsync(SCROLL_SETTLE_MS);
    expect(texts(await pending)[0]).toBe('Scrolled left by 3 ticks at (1, 1)');
    expect(sentActions()).toEqual([built(scrollActions({ point: { x: 2, y: 2 }, direction: 'left' }))]);
  });

  it('attaches no screenshot when the tab ended up on a site without permission', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    channel.request.mockImplementation(async () => {
      navigateTab(TAB, 'https://evil.example/');
      return { ok: true };
    });
    const pending = run({ action: 'scroll', coordinate: [1, 1], scroll_direction: 'up' });
    await vi.advanceTimersByTimeAsync(SCROLL_SETTLE_MS);
    const response = await pending;
    expect(texts(response)).toEqual([`Scrolled up by 3 ticks at (1, 1)\n${unapprovedText(TAB, 'evil.example')}`]);
    expect(response).not.toMatchObject({ result: { content: [{}, { type: 'image' }] } });
    expect(browserMock.tabs.captureTab).not.toHaveBeenCalled();
  });

  it('notes a move to another allowed site instead of attaching a screenshot', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    channel.request.mockImplementation(async () => {
      navigateTab(TAB, 'https://other.example/next');
      return { ok: true };
    });
    const pending = run({ action: 'scroll', coordinate: [1, 1], scroll_direction: 'up' });
    await vi.advanceTimersByTimeAsync(SCROLL_SETTLE_MS);
    const response = await pending;
    expect(texts(response)).toEqual([`Scrolled up by 3 ticks at (1, 1)\n${siteChangedNote(TAB, 'example.com', 'other.example')}`]);
    expect(browserMock.tabs.captureTab).not.toHaveBeenCalled();
  });

  it('does not activate a tab that is already active', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = run({ action: 'scroll', coordinate: [1, 1], scroll_direction: 'down' });
    await vi.advanceTimersByTimeAsync(SCROLL_SETTLE_MS);
    expect(texts(await pending)[0]).toBe('Scrolled down by 3 ticks at (1, 1)');
    expect(browserMock.tabs.update).not.toHaveBeenCalled();
  });

  it('activates a background tab before the wheel input, without focusing its window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    screenshotFrames.record(OTHER_TAB, VIEWPORT, VIEWPORT);
    const pending = run({ action: 'scroll', coordinate: [1, 1], scroll_direction: 'down', tabId: OTHER_TAB });
    await vi.advanceTimersByTimeAsync(ACTIVATE_SETTLE_MS - 1);
    expect(browserMock.tabs.update).toHaveBeenCalledWith(OTHER_TAB, { active: true });
    expect(channel.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sentActions()).toEqual([built(scrollActions({ point: { x: 1, y: 1 }, direction: 'down' }))]);
    await vi.advanceTimersByTimeAsync(SCROLL_SETTLE_MS);
    const response = await pending;
    expect(texts(response)).toEqual([
      `Scrolled down by 3 ticks at (1, 1) ${BACKGROUND_SCROLL_NOTE}`,
      'Captured screenshot (800x600, jpeg)',
    ]);
    expect(tabs.get(OTHER_TAB)?.active).toBe(true);
  });

  it.each([
    [{ action: 'left_click', coordinate: [1, 1] }],
    [{ action: 'hover', coordinate: [1, 1] }],
    [{ action: 'left_click_drag', start_coordinate: [1, 1], coordinate: [2, 2] }],
    [{ action: 'scroll_to', ref: 'ref_1' }],
  ])('does not activate a background tab for %o', async (args) => {
    screenshotFrames.record(OTHER_TAB, VIEWPORT, VIEWPORT);
    await text({ ...args, tabId: OTHER_TAB });
    expect(browserMock.tabs.update).not.toHaveBeenCalled();
    expect(tabs.get(OTHER_TAB)?.active).toBe(false);
  });
});

describe('computer scroll_to', () => {
  it('scrolls the element into view through the page without input', async () => {
    expect(await text({ action: 'scroll_to', ref: 'ref_6' })).toBe('Scrolled to element with reference: ref_6');
    expect(entry).toHaveBeenCalledWith({ ref: 'ref_6', scrollOnly: true });
    expect(channel.request).not.toHaveBeenCalled();
  });

  it('works without a native host connection', async () => {
    expect(await failure({ action: 'left_click', coordinate: [1, 1] }, false)).toBe(
      `Failed to send input to tab ${TAB}: the native host is not connected`,
    );
    const response = await run({ action: 'scroll_to', ref: 'ref_6' }, false);
    expect(texts(response)).toEqual(['Scrolled to element with reference: ref_6']);
  });

  it('reports a ref error', async () => {
    pointResult = { ok: false, error: 'ref_6 no longer exists in the page. Call read_page or find to get fresh element references.' };
    expect(await failure({ action: 'scroll_to', ref: 'ref_6' })).toBe(pointResult.error);
  });
});

describe('computer wait', () => {
  it('waits for the duration without touching the browser', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = false;
    const pending = run({ action: 'wait', duration: 2 }).then((response) => {
      settled = true;
      return response;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(texts(await pending)).toEqual(['Waited for 2 seconds']);
    expect(browserMock.query).not.toHaveBeenCalled();
    expect(browserMock.tabs.get).not.toHaveBeenCalled();
    expect(browserMock.storage.local.get).not.toHaveBeenCalled();
  });

  it('says second for one second', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = run({ action: 'wait', duration: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(texts(await pending)).toEqual(['Waited for 1 second']);
  });
});

describe('computer pointer: coordinate frames', () => {
  it('asks for a screenshot first when the tab has none', async () => {
    screenshotFrames.forget(TAB);
    expect(await failure({ action: 'left_click', coordinate: [1, 2] })).toBe(
      `No screenshot of tab ${TAB} has been taken yet; take a screenshot first`,
    );
    expect(channel.request).not.toHaveBeenCalled();
  });

  it.each([
    [{ action: 'left_click', coordinate: [403, 10] }, '(403, 10)'],
    [{ action: 'hover', coordinate: [10, -5] }, '(10, -5)'],
    [{ action: 'scroll', coordinate: [10, 400], scroll_direction: 'down' }, '(10, 400)'],
    [{ action: 'left_click_drag', start_coordinate: [10, 10], coordinate: [500, 10] }, '(500, 10)'],
  ])('refuses a coordinate outside the last screenshot %j', async (args, point) => {
    expect(await failure(args)).toBe(
      `Coordinate ${point} is outside the last screenshot of tab ${TAB} (400x300); take a new screenshot`,
    );
    expect(channel.request).not.toHaveBeenCalled();
  });

  it('rejects invalid arguments before touching the browser', async () => {
    expect(await failure({ action: 'left_click', coordinate: [1, 2], ref: 'ref_1' })).toMatch(
      /^Invalid computer arguments: coordinate and ref are mutually exclusive/,
    );
    expect(browserMock.query).not.toHaveBeenCalled();
  });
});

describe('computer pointer: input results', () => {
  it('reports a failed input', async () => {
    inputResult = { ok: false, error: 'Firefox was not started with --remote-debugging-port' };
    expect(await failure({ action: 'left_click', coordinate: [1, 2] })).toBe(inputResult.error);
  });

  it('notes that a click moved the tab to a site without permission', async () => {
    channel.request.mockImplementation(async () => {
      navigateTab(TAB, 'https://evil.example/login');
      return { ok: true };
    });
    expect(await text({ action: 'left_click', coordinate: [1, 2] })).toBe(
      `Clicked at (1, 2)\n${unapprovedText(TAB, 'evil.example')}`,
    );
  });

  it('accepts a click that stays on an allowed site', async () => {
    channel.request.mockImplementation(async () => {
      navigateTab(TAB, 'https://other.example/next');
      return { ok: true };
    });
    expect(await text({ action: 'left_click', coordinate: [1, 2] })).toBe('Clicked at (1, 2)');
  });

  it('notes that the tab was closed by the input', async () => {
    channel.request.mockImplementation(async () => {
      tabs.delete(TAB);
      return { ok: true };
    });
    expect(await text({ action: 'left_click', coordinate: [1, 2] })).toBe(`Clicked at (1, 2)\nTab ${TAB} was closed after the input.`);
  });

  it('sends no input when the tab leaves the site while the ref is resolved', async () => {
    entry.mockImplementation(() => {
      navigateTab(TAB, 'https://evil.example/');
      return pointResult;
    });
    expect(await failure({ action: 'left_click', ref: 'ref_3' })).toBe(
      inputPageChangedMessage('click in')('computer', TAB, 'example.com'),
    );
    expect(channel.request).not.toHaveBeenCalled();
  });
});

describe('computer pointer: synthetic fallback', () => {
  const CAUSE = 'Firefox is not listening for WebDriver BiDi on port 9222.';
  const NONE = { ctrl: false, shift: false, alt: false, meta: false };

  beforeEach(() => {
    inputResult = { ok: false, error: CAUSE, unavailable: true };
  });

  it('clicks with synthetic events when BiDi is unavailable and warns about it', async () => {
    expect(await text({ action: 'left_click', coordinate: [10, 20], modifiers: 'ctrl+shift' })).toBe(
      `Clicked at (10, 20)\n${fallbackWarning(CAUSE)}`,
    );
    expect(channel.request).toHaveBeenCalledTimes(1);
    expect(synthetic).toHaveBeenCalledWith({
      kind: 'click',
      point: { x: 20, y: 40 },
      button: 'left',
      clickCount: 1,
      modifiers: { ...NONE, ctrl: true, shift: true },
    });
  });

  it('names the cause and the remote debugging flag in the warning', () => {
    expect(fallbackWarning(CAUSE)).toMatch(/^Warning: .*synthetic DOM events.*some pages ignore.*--remote-debugging-port/);
    expect(fallbackWarning(CAUSE)).toContain(CAUSE);
  });

  it.each([
    ['right_click', 'right', 1],
    ['double_click', 'left', 2],
    ['triple_click', 'left', 3],
  ])('%s passes its button and click count', async (action, button, clickCount) => {
    await text({ action, coordinate: [1, 1] });
    expect(synthetic).toHaveBeenCalledWith(expect.objectContaining({ kind: 'click', button, clickCount }));
  });

  it('passes the ref with its point', async () => {
    await text({ action: 'left_click', ref: 'ref_3' });
    expect(synthetic).toHaveBeenCalledWith({
      kind: 'click',
      point: { x: 150, y: 75.5 },
      ref: 'ref_3',
      button: 'left',
      clickCount: 1,
      modifiers: NONE,
    });
  });

  it('hovers and drags with synthetic events', async () => {
    expect(await text({ action: 'hover', ref: 'ref_2' })).toBe(`Hovered over element ref_2\n${fallbackWarning(CAUSE)}`);
    expect(synthetic).toHaveBeenLastCalledWith({ kind: 'hover', point: { x: 150, y: 75.5 }, ref: 'ref_2' });
    await text({ action: 'left_click_drag', start_coordinate: [1, 2], coordinate: [30, 40] });
    expect(synthetic).toHaveBeenLastCalledWith({ kind: 'drag', start: { x: 2, y: 4 }, end: { x: 60, y: 80 } });
  });

  it('scrolls with synthetic events and still attaches the screenshot', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = run({ action: 'scroll', coordinate: [50, 60], scroll_direction: 'up', scroll_amount: 2 });
    await vi.advanceTimersByTimeAsync(SCROLL_SETTLE_MS);
    const response = await pending;
    expect(texts(response)).toEqual([
      `Scrolled up by 2 ticks at (50, 60)\n${fallbackWarning(CAUSE)}`,
      'Captured screenshot (800x600, jpeg)',
    ]);
    expect(synthetic).toHaveBeenCalledWith({ kind: 'scroll', point: { x: 100, y: 120 }, deltaX: 0, deltaY: -200 });
  });

  it('does not fall back on a real input error', async () => {
    inputResult = { ok: false, error: 'Firefox WebDriver BiDi input.performActions failed: invalid argument' };
    expect(await failure({ action: 'left_click', coordinate: [1, 2] })).toBe(inputResult.error);
    expect(synthetic).not.toHaveBeenCalled();
  });

  it('does not fall back without a native host connection', async () => {
    expect(await failure({ action: 'left_click', coordinate: [1, 2] }, false)).toBe(
      `Failed to send input to tab ${TAB}: the native host is not connected`,
    );
    expect(synthetic).not.toHaveBeenCalled();
  });

  it('reports an error from the synthetic input', async () => {
    syntheticResult = { ok: false, error: 'There is no element at that point in the page. Take a new screenshot and try again.' };
    expect(await failure({ action: 'left_click', coordinate: [1, 2] })).toBe(syntheticResult.error);
  });

  it('sends no synthetic input when the tab left the site during the BiDi attempt', async () => {
    channel.request.mockImplementation(async () => {
      navigateTab(TAB, 'https://evil.example/');
      return inputResult;
    });
    expect(await failure({ action: 'left_click', coordinate: [1, 2] })).toBe(
      inputPageChangedMessage('click in')('computer', TAB, 'example.com'),
    );
    expect(synthetic).not.toHaveBeenCalled();
  });

  it('checks where the tab landed after the synthetic input', async () => {
    synthetic.mockImplementation(() => {
      navigateTab(TAB, 'https://evil.example/login');
      return { ok: true };
    });
    expect(await text({ action: 'left_click', coordinate: [1, 2] })).toBe(
      `Clicked at (1, 2)\n${fallbackWarning(CAUSE)}\n${unapprovedText(TAB, 'evil.example')}`,
    );
  });
});

describe('computer pointer: site permissions', () => {
  function clientApprovals() {
    const prompt: ApprovalPrompt = {
      requestApproval: vi.fn(async () => ({ kind: 'answered' as const, answer: 'deny' as const, wildcard: false })),
    };
    const approvals: ClientApprovals = { promptFor: vi.fn(() => prompt), handleResponse: vi.fn(), close: vi.fn() };
    return { approvals, prompt };
  }

  it.each([
    [{ action: 'left_click', coordinate: [1, 2] }, 'click'],
    [{ action: 'triple_click', ref: 'ref_1' }, 'click'],
    [{ action: 'left_click_drag', start_coordinate: [1, 2], coordinate: [3, 4] }, 'click'],
    [{ action: 'hover', coordinate: [1, 2] }, 'read_page_content'],
    [{ action: 'scroll', coordinate: [1, 2], scroll_direction: 'down' }, 'read_page_content'],
    [{ action: 'scroll_to', ref: 'ref_1' }, 'read_page_content'],
  ])('asks for the site permission of %j as %s and sends nothing when denied', async (args, action) => {
    navigateTab(TAB, 'https://unknown.example/');
    const { approvals, prompt } = clientApprovals();
    const response = await executeTool(
      { type: 'tool_request', id: '1:1', tool: 'computer', args, approvalViaClient: true },
      approvals,
      channel,
    );
    expect(prompt.requestApproval).toHaveBeenCalledWith({
      host: 'unknown.example',
      url: 'https://unknown.example/',
      tool: 'computer',
      action,
    });
    expect(response).toMatchObject({ error: { content: [{ type: 'text', text: deniedMessage('unknown.example') }] } });
    expect(channel.request).not.toHaveBeenCalled();
    expect(entry).not.toHaveBeenCalled();
  });

  it('refuses a restricted page before asking', async () => {
    navigateTab(TAB, 'https://addons.mozilla.org/');
    expect(await failure({ action: 'left_click', coordinate: [1, 2] })).toMatch(/^Cannot click in tab 5 \(https:\/\/addons\.mozilla\.org\/\)/);
    expect(channel.request).not.toHaveBeenCalled();
  });
});
