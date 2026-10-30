import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeTool } from '../tools';
import { MAX_IMAGE_BASE64_LENGTH, permissionMessage, screenshotFrames, siteChangedMessage } from '../tools/computer';
import { PROMPT_ANSWER_MESSAGE } from '../permissions/approval';
import { PERMISSION_STORAGE_KEY } from '../permissions/permission-store';
import { handlePromptMessage } from '../permissions/popup-prompt';
import { blockedMessage, deniedMessage } from '../permissions/site-access';
import { EXTENSION_ID, mockBrowser } from './browser-mock';

const TAB = 5;
const OTHER_TAB = 6;
const PAGE = 'https://example.com/';
const CAPTURED = 'Y2FwdHVyZWQ=';
const SMALL_BYTES = 1_000;
// Base64 of this many bytes is just over MAX_IMAGE_BASE64_LENGTH.
const LARGE_BYTES = 1_048_576;

let browserMock: ReturnType<typeof mockBrowser>;
let viewport: { width: number; height: number; devicePixelRatio: number; scrollX: number; scrollY: number };
let bitmapSize: { width: number; height: number };
let bytesForQuality: (quality: number) => number;
let canvases: FakeCanvas[];
let bitmaps: { close: ReturnType<typeof vi.fn> }[];

class FakeCanvas {
  readonly context = { imageSmoothingQuality: 'low', drawImage: vi.fn() };
  readonly qualities: number[] = [];

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    canvases.push(this);
  }

  getContext(type: string) {
    return type === '2d' ? this.context : null;
  }

  async convertToBlob(options: { type: string; quality: number }) {
    expect(options.type).toBe('image/jpeg');
    this.qualities.push(options.quality);
    return new Blob([new Uint8Array(bytesForQuality(options.quality))]);
  }
}

beforeEach(() => {
  browserMock = mockBrowser();
  browserMock.allowSites('example.com', 'other.example', 'previous.example', 'slow.example', 'hang.example', 'nonexistent.invalid', 'popup.example', '127.0.0.1');
  viewport = { width: 1280, height: 720, devicePixelRatio: 2, scrollX: 0, scrollY: 0 };
  bitmapSize = { width: 1280, height: 720 };
  bytesForQuality = () => SMALL_BYTES;
  canvases = [];
  bitmaps = [];
  const tabs = new Map<number, Partial<browser.tabs.Tab>>([
    [TAB, { id: TAB, windowId: 1, url: PAGE, active: true }],
    [OTHER_TAB, { id: OTHER_TAB, windowId: 1, url: 'https://other.example/', active: false }],
  ]);
  browserMock.tabs.get.mockImplementation(async (tabId) => {
    const tab = tabs.get(tabId);
    if (!tab) throw new Error(`Invalid tab ID: ${tabId}`);
    return tab;
  });
  browserMock.query.mockImplementation(async (query) => [...tabs.values()].filter((tab) => !query.active || tab.active));
  browserMock.permissions.contains.mockResolvedValue(true);
  browserMock.scripting.executeScript.mockImplementation(async () => [{ frameId: 0, result: { ...viewport } }]);
  browserMock.tabs.captureTab.mockImplementation(async () => `data:image/jpeg;base64,${CAPTURED}`);
  vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => {
      const bitmap = { ...bitmapSize, close: vi.fn() };
      bitmaps.push(bitmap);
      return bitmap;
    }),
  );
});

afterEach(() => {
  screenshotFrames.forget(TAB);
  screenshotFrames.forget(OTHER_TAB);
});

async function run(args: Record<string, unknown>) {
  return executeTool({ type: 'tool_request', id: '1:1', tool: 'computer', args });
}

async function screenshot(args: Record<string, unknown> = {}) {
  const response = await run({ action: 'screenshot', ...args });
  if (!('result' in response)) throw new Error(`expected a result, got ${JSON.stringify(response)}`);
  const [text, image] = response.result.content;
  if (text?.type !== 'text' || image?.type !== 'image') throw new Error('expected a text and an image block');
  return { text: text.text, image };
}

async function failure(args: Record<string, unknown> = {}): Promise<string> {
  const response = await run({ action: 'screenshot', ...args });
  if (!('error' in response)) throw new Error('expected an error');
  const [block] = response.error.content;
  return block?.type === 'text' ? block.text : '';
}

describe('computer screenshot: tab resolution', () => {
  it('captures the active tab of the last focused normal window by default', async () => {
    await screenshot();
    expect(browserMock.query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true, windowType: 'normal' });
    expect(browserMock.tabs.captureTab).toHaveBeenCalledWith(TAB, expect.anything());
    expect(browserMock.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: TAB }, injectImmediately: true }),
    );
  });

  it('captures the given tab without activating it', async () => {
    await screenshot({ tabId: OTHER_TAB });
    expect(browserMock.tabs.get).toHaveBeenCalledWith(OTHER_TAB);
    expect(browserMock.tabs.captureTab).toHaveBeenCalledWith(OTHER_TAB, expect.anything());
    expect(browserMock.tabs.update).not.toHaveBeenCalled();
  });

  it('reports a tab that does not exist', async () => {
    expect(await failure({ tabId: 99 })).toBe(
      'Failed to take a screenshot: tab 99 does not exist (it may have been closed). Call tabs_context to see current tabs.',
    );
    expect(browserMock.tabs.captureTab).not.toHaveBeenCalled();
  });

  it('reports when there is no active tab', async () => {
    browserMock.query.mockResolvedValue([]);
    expect(await failure()).toMatch(/^Failed to take a screenshot: there is no active tab in a normal browser window/);
  });

  it('rejects invalid arguments before touching the browser', async () => {
    const response = await run({ action: 'screenshot', scale: 2 });
    expect(response).toMatchObject({ error: { content: [{ type: 'text', text: expect.stringMatching(/^Invalid computer arguments: scale/) }] } });
    expect(browserMock.query).not.toHaveBeenCalled();
  });
});

describe('computer screenshot: capture', () => {
  it('captures a jpeg at quality 75, scaled from CSS pixels to the output size', async () => {
    const { text, image } = await screenshot();
    expect(browserMock.tabs.captureTab).toHaveBeenCalledWith(TAB, { format: 'jpeg', quality: 75, scale: 1 });
    expect(text).toBe('Captured screenshot (1280x720, jpeg)');
    expect(image).toEqual({ type: 'image', data: CAPTURED, mimeType: 'image/jpeg' });
  });

  it('returns the capture as is when it already has the output size and fits', async () => {
    await screenshot();
    expect(canvases).toEqual([]);
    expect(bitmaps[0]?.close).toHaveBeenCalled();
  });

  it('downscales a large viewport to the frame and records the frame', async () => {
    viewport = { width: 2560, height: 1440, devicePixelRatio: 1, scrollX: 0, scrollY: 0 };
    bitmapSize = { width: 1456, height: 819 };
    const { text, image } = await screenshot();
    expect(browserMock.tabs.captureTab).toHaveBeenCalledWith(TAB, {
      format: 'jpeg',
      quality: 75,
      scale: 1456 / 2560,
    });
    expect(text).toBe('Captured screenshot (1456x819, jpeg)');
    expect(image.data).toBe(CAPTURED);
    expect(screenshotFrames.get(TAB)).toEqual({
      viewport: { width: 2560, height: 1440 },
      frame: { width: 1456, height: 819 },
    });
  });

  it('resizes a capture of the wrong size to the output size starting at quality 0.75', async () => {
    bitmapSize = { width: 2560, height: 1440 };
    await screenshot();
    expect(canvases).toHaveLength(1);
    const [canvas] = canvases;
    expect([canvas?.width, canvas?.height]).toEqual([1280, 720]);
    expect(canvas?.context.drawImage).toHaveBeenCalledWith(expect.objectContaining(bitmapSize), 0, 0, 1280, 720);
    expect(canvas?.qualities).toEqual([0.75]);
  });

  it('steps the quality down by 0.05 until the image fits', async () => {
    bitmapSize = { width: 100, height: 100 };
    bytesForQuality = (quality) => (quality > 0.5 ? LARGE_BYTES : SMALL_BYTES);
    const { image } = await screenshot();
    expect(canvases[0]?.qualities).toEqual([0.75, 0.7, 0.65, 0.6, 0.55, 0.5]);
    expect(image.data.length).toBeLessThanOrEqual(MAX_IMAGE_BASE64_LENGTH);
  });

  it('stops at quality 0.1 and returns that image', async () => {
    bitmapSize = { width: 100, height: 100 };
    bytesForQuality = () => LARGE_BYTES;
    const { image } = await screenshot();
    const qualities = canvases[0]?.qualities ?? [];
    expect(qualities).toHaveLength(14);
    expect(qualities.at(-1)).toBe(0.1);
    expect(image.data.length).toBeGreaterThan(MAX_IMAGE_BASE64_LENGTH);
  });

  it('re-encodes a capture of the right size that is too large, starting one step lower', async () => {
    const large = btoa('\0'.repeat(LARGE_BYTES));
    browserMock.tabs.captureTab.mockResolvedValue(`data:image/jpeg;base64,${large}`);
    await screenshot();
    expect(canvases[0]?.qualities).toEqual([0.7]);
  });

  it('notes the frame when the image is scaled down', async () => {
    bitmapSize = { width: 640, height: 360 };
    const { text } = await screenshot({ scale: 0.5 });
    expect(browserMock.tabs.captureTab).toHaveBeenCalledWith(TAB, { format: 'jpeg', quality: 75, scale: 0.5 });
    expect(text).toBe(
      'Captured screenshot (640x360, jpeg). Coordinates refer to the 1280x720 screenshot frame, not to this scaled image.',
    );
    expect(screenshotFrames.get(TAB)?.frame).toEqual({ width: 1280, height: 720 });
  });
});

describe('computer screenshot: coordinate frames', () => {
  it('forgets the frame of a closed tab and listens for removals only once', async () => {
    await screenshot();
    await screenshot({ tabId: OTHER_TAB });
    expect(browserMock.tabs.onRemoved.listenerCount()).toBe(1);
    browserMock.tabs.onRemoved.emit(TAB, { windowId: 1, isWindowClosing: false });
    expect(screenshotFrames.get(TAB)).toBeUndefined();
    expect(screenshotFrames.get(OTHER_TAB)).toBeDefined();
  });

  it('records no frame when the capture fails', async () => {
    browserMock.tabs.captureTab.mockRejectedValue(new Error('boom'));
    await failure();
    expect(screenshotFrames.get(TAB)).toBeUndefined();
  });
});

describe('computer screenshot: errors', () => {
  it('asks the user to grant the host permission in about:addons', async () => {
    browserMock.permissions.contains.mockResolvedValue(false);
    expect(await failure()).toBe(permissionMessage('take a screenshot'));
    expect(await failure()).toMatch(/^Failed to take a screenshot: /);
    expect(permissionMessage('take a screenshot')).toContain('about:addons');
    expect(permissionMessage('take a screenshot')).toContain('Access your data for all websites');
    expect(browserMock.permissions.contains).toHaveBeenCalledWith({ origins: ['<all_urls>'] });
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it.each(['https://addons.mozilla.org/en-US/firefox/', 'https://support.mozilla.org/'])(
    'refuses the restricted Mozilla site %j without asking for permission',
    async (url) => {
      browserMock.tabs.get.mockResolvedValue({ id: OTHER_TAB, url });
      expect(await failure({ tabId: OTHER_TAB })).toMatch(
        new RegExp(`^Cannot take a screenshot of tab ${OTHER_TAB} .*Firefox does not let extensions access this page`),
      );
      expect(browserMock.windows.create).not.toHaveBeenCalled();
      expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['about:addons', 'about:'],
    ['about:blank', 'about:'],
    ['file:///home/user/page.html', 'file:'],
    ['moz-extension://0a1b2c3d/page.html', 'moz-extension:'],
    ['view-source:https://example.com/', 'view-source:'],
  ])('refuses %j, which site permissions do not cover', async (url, scheme) => {
    browserMock.tabs.get.mockResolvedValue({ id: OTHER_TAB, url });
    expect(await failure({ tabId: OTHER_TAB })).toBe(
      `Cannot take a screenshot of tab ${OTHER_TAB} (${url}): Unsupported URL scheme "${scheme}"; site permissions only cover http and https pages`,
    );
    expect(browserMock.windows.create).not.toHaveBeenCalled();
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('refuses a tab without a url', async () => {
    browserMock.tabs.get.mockResolvedValue({ id: OTHER_TAB, url: '' });
    expect(await failure({ tabId: OTHER_TAB })).toBe(
      `Cannot take a screenshot of tab ${OTHER_TAB} (): Invalid URL; site permissions only cover http and https pages`,
    );
  });

  it('reports a page that refuses script injection as restricted', async () => {
    browserMock.scripting.executeScript.mockRejectedValue(new Error('Missing host permission for the tab'));
    expect(await failure()).toMatch(/^Cannot take a screenshot of tab 5 \(https:\/\/example.com\/\)/);
  });

  it('mentions that the page may have failed to load', async () => {
    browserMock.scripting.executeScript.mockRejectedValue(new Error('Missing host permission for the tab, or any frames'));
    expect(await failure()).toContain('or the page failed to load');
  });

  it('does not report unrelated permission errors as a restricted page', async () => {
    browserMock.scripting.executeScript.mockRejectedValue(new Error('Permission denied to access property "x"'));
    expect(await failure()).toBe(
      'Failed to take a screenshot of tab 5: could not read the viewport size: Permission denied to access property "x"',
    );
  });

  it('reports other injection failures', async () => {
    browserMock.scripting.executeScript.mockRejectedValue(new Error('No tab with id: 5'));
    expect(await failure()).toBe(
      'Failed to take a screenshot of tab 5: could not read the viewport size: No tab with id: 5',
    );
  });

  it('reports an error thrown by the injected script', async () => {
    browserMock.scripting.executeScript.mockResolvedValue([{ frameId: 0, error: { message: 'denied' } }]);
    expect(await failure()).toBe('Failed to take a screenshot of tab 5: could not read the viewport size: denied');
  });

  it('reports an unusable viewport', async () => {
    viewport = { ...viewport, width: 0 };
    expect(await failure()).toBe('Failed to take a screenshot of tab 5: the page reported no usable viewport size');
  });

  it('reports a capture failure', async () => {
    browserMock.tabs.captureTab.mockRejectedValue(new Error('capture went wrong'));
    expect(await failure()).toBe('Failed to take a screenshot of tab 5: capture went wrong');
  });

  it('reports a capture refused for permissions as a restricted page', async () => {
    browserMock.tabs.captureTab.mockRejectedValue(new Error('Missing activeTab permission'));
    expect(await failure()).toMatch(/^Cannot take a screenshot of tab 5/);
  });
});

async function zoom(args: Record<string, unknown>) {
  const response = await run({ action: 'zoom', ...args });
  if (!('result' in response)) throw new Error(`expected a result, got ${JSON.stringify(response)}`);
  const [text, image] = response.result.content;
  if (text?.type !== 'text' || image?.type !== 'image') throw new Error('expected a text and an image block');
  return { text: text.text, image };
}

async function zoomFailure(args: Record<string, unknown>): Promise<string> {
  const response = await run({ action: 'zoom', ...args });
  if (!('error' in response)) throw new Error('expected an error');
  const [block] = response.error.content;
  return block?.type === 'text' ? block.text : '';
}

describe('computer zoom', () => {
  it('asks for a screenshot first when the tab has no frame', async () => {
    expect(await zoomFailure({ region: [0, 0, 10, 10] })).toBe(
      'No screenshot of tab 5 has been taken yet; take a screenshot first',
    );
    expect(browserMock.tabs.captureTab).not.toHaveBeenCalled();
  });

  it('rejects an invalid region before touching the browser', async () => {
    expect(await zoomFailure({ region: [10, 0, 5, 10] })).toBe(
      'Invalid computer arguments: region x1 must be greater than x0, received [10, 0, 5, 10]',
    );
    expect(browserMock.query).not.toHaveBeenCalled();
  });

  it('captures only the region at device pixels', async () => {
    await screenshot();
    browserMock.tabs.captureTab.mockClear();
    bitmapSize = { width: 400, height: 200 };
    const { text, image } = await zoom({ region: [100, 50, 300, 150] });
    expect(browserMock.tabs.captureTab).toHaveBeenCalledWith(TAB, {
      format: 'jpeg',
      quality: 75,
      rect: { x: 100, y: 50, width: 200, height: 100 },
      scale: 2,
    });
    expect(text).toBe(
      'Zoomed into region [100, 50, 300, 150] of the 1280x720 screenshot frame of tab 5 (400x200, jpeg). Coordinates still refer to the screenshot frame, not to this image.',
    );
    expect(image).toEqual({ type: 'image', data: CAPTURED, mimeType: 'image/jpeg' });
    expect(canvases).toEqual([]);
  });

  it('maps the region through the frame and offsets the rect by the scroll position', async () => {
    viewport = { width: 2560, height: 1440, devicePixelRatio: 1, scrollX: 30, scrollY: 500 };
    await screenshot();
    browserMock.tabs.captureTab.mockClear();
    await zoom({ region: [0, 0, 728, 409.5] });
    expect(browserMock.tabs.captureTab).toHaveBeenCalledWith(TAB, {
      format: 'jpeg',
      quality: 75,
      rect: { x: 30, y: 500, width: 1280, height: 720 },
      scale: 1,
    });
  });

  it('fits a large region into the budget, applies scale and resizes on a canvas', async () => {
    await screenshot();
    browserMock.tabs.captureTab.mockClear();
    bitmapSize = { width: 2560, height: 1440 };
    const { text } = await zoom({ tabId: TAB, region: [0, 0, 1280, 720], scale: 0.5 });
    expect(browserMock.tabs.captureTab).toHaveBeenCalledWith(TAB, {
      format: 'jpeg',
      quality: 75,
      rect: { x: 0, y: 0, width: 1280, height: 720 },
      scale: 728 / 1280,
    });
    expect(text).toContain('(728x410, jpeg)');
    expect([canvases[0]?.width, canvases[0]?.height]).toEqual([728, 410]);
  });

  it('does not update the coordinate frame', async () => {
    await screenshot();
    const before = screenshotFrames.get(TAB);
    viewport = { ...viewport, width: 1300, height: 800 };
    await zoom({ region: [0, 0, 100, 100] });
    expect(screenshotFrames.get(TAB)).toEqual(before);
    expect(screenshotFrames.get(TAB)?.viewport).toEqual({ width: 1280, height: 720 });
  });

  it('refuses a region outside the current viewport', async () => {
    await screenshot();
    browserMock.tabs.captureTab.mockClear();
    viewport = { ...viewport, width: 800, height: 600 };
    expect(await zoomFailure({ region: [0, 0, 1280, 720] })).toBe(
      'Region [0, 0, 1280, 720] is outside the current 800x600 viewport of tab 5, which changed since the last screenshot; take a new screenshot',
    );
    expect(browserMock.tabs.captureTab).not.toHaveBeenCalled();
  });

  it('refuses a region outside the last screenshot frame', async () => {
    await screenshot();
    expect(await zoomFailure({ region: [0, 0, 1290, 10] })).toBe(
      'Region [0, 0, 1290, 10] is outside the last screenshot of tab 5 (1280x720); take a new screenshot',
    );
  });

  it('reports a missing host permission like screenshot', async () => {
    browserMock.permissions.contains.mockResolvedValue(false);
    expect(await zoomFailure({ region: [0, 0, 10, 10] })).toBe(permissionMessage('zoom'));
    expect(await zoomFailure({ region: [0, 0, 10, 10] })).toMatch(/^Failed to zoom: /);
  });

  it('refuses a restricted page like screenshot', async () => {
    browserMock.tabs.get.mockResolvedValue({ id: OTHER_TAB, url: 'https://addons.mozilla.org/' });
    expect(await zoomFailure({ tabId: OTHER_TAB, region: [0, 0, 10, 10] })).toMatch(
      /^Cannot zoom into tab 6 .*Firefox does not let extensions access this page/,
    );
  });

  it('refuses a page outside site permissions like screenshot', async () => {
    browserMock.tabs.get.mockResolvedValue({ id: OTHER_TAB, url: 'about:addons' });
    expect(await zoomFailure({ tabId: OTHER_TAB, region: [0, 0, 10, 10] })).toBe(
      'Cannot zoom into tab 6 (about:addons): Unsupported URL scheme "about:"; site permissions only cover http and https pages',
    );
  });

  it('reports a capture refused for permissions as a restricted page', async () => {
    await screenshot();
    browserMock.tabs.captureTab.mockRejectedValue(new Error('Missing activeTab permission'));
    expect(await zoomFailure({ region: [0, 0, 10, 10] })).toMatch(/^Cannot zoom into tab 5/);
  });

  it('names the zoom action in capture and viewport failures', async () => {
    await screenshot();
    browserMock.tabs.captureTab.mockRejectedValue(new Error('capture went wrong'));
    expect(await zoomFailure({ region: [0, 0, 10, 10] })).toBe('Failed to zoom into tab 5: capture went wrong');
    viewport = { ...viewport, width: 0 };
    expect(await zoomFailure({ region: [0, 0, 10, 10] })).toBe(
      'Failed to zoom into tab 5: the page reported no usable viewport size',
    );
  });

  it('names the zoom action when the tab does not exist', async () => {
    browserMock.tabs.get.mockRejectedValue(new Error('Invalid tab ID: 99'));
    expect(await zoomFailure({ tabId: 99, region: [0, 0, 10, 10] })).toMatch(/^Failed to zoom: tab 99 does not exist/);
  });
});

describe('computer: site permissions', () => {
  const PROMPT_WINDOW = 50;

  beforeEach(() => {
    browserMock.storage.local.data.clear();
    browserMock.windows.create.mockResolvedValue({ id: PROMPT_WINDOW });
  });

  async function promptUrl(): Promise<string> {
    await vi.waitFor(() => expect(browserMock.windows.create).toHaveBeenCalledTimes(1));
    return String(browserMock.windows.create.mock.calls[0]?.[0].url);
  }

  it('asks before reading a page on a site without a decision and captures on allow once', async () => {
    const response = run({ action: 'screenshot', tabId: OTHER_TAB });
    const url = await promptUrl();
    expect(browserMock.tabs.captureTab).not.toHaveBeenCalled();
    const id = new URL(url).searchParams.get('id');
    await handlePromptMessage({ type: PROMPT_ANSWER_MESSAGE, id, answer: 'allow_once' }, { id: EXTENSION_ID, url });
    expect(await response).toHaveProperty('result');
    expect(browserMock.tabs.captureTab).toHaveBeenCalledWith(OTHER_TAB, expect.anything());
  });

  it('captures nothing when the user closes the prompt window', async () => {
    const response = run({ action: 'screenshot', tabId: OTHER_TAB });
    await promptUrl();
    browserMock.windows.onRemoved.emit(PROMPT_WINDOW);
    expect(await response).toEqual({
      type: 'tool_response',
      id: '1:1',
      error: { content: [{ type: 'text', text: deniedMessage('other.example') }] },
    });
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
    expect(browserMock.tabs.captureTab).not.toHaveBeenCalled();
  });

  it('captures nothing when the tab leaves the site while the prompt is open', async () => {
    const response = run({ action: 'screenshot', tabId: OTHER_TAB });
    const url = await promptUrl();
    const tab = await browserMock.tabs.get(OTHER_TAB);
    tab.url = 'https://elsewhere.example/secret';
    const id = new URL(url).searchParams.get('id');
    await handlePromptMessage({ type: PROMPT_ANSWER_MESSAGE, id, answer: 'allow_once' }, { id: EXTENSION_ID, url });
    expect(await response).toEqual({
      type: 'tool_response',
      id: '1:1',
      error: { content: [{ type: 'text', text: siteChangedMessage('take a screenshot of', OTHER_TAB, 'other.example') }] },
    });
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
    expect(browserMock.tabs.captureTab).not.toHaveBeenCalled();
  });

  it('captures a page on the approved site after a same-site navigation during the prompt', async () => {
    const response = run({ action: 'screenshot', tabId: OTHER_TAB });
    const url = await promptUrl();
    const tab = await browserMock.tabs.get(OTHER_TAB);
    tab.url = 'https://www.other.example/next';
    const id = new URL(url).searchParams.get('id');
    await handlePromptMessage({ type: PROMPT_ANSWER_MESSAGE, id, answer: 'allow_once' }, { id: EXTENSION_ID, url });
    expect(await response).toHaveProperty('result');
  });

  it('captures nothing when the tab is closed while the prompt is open', async () => {
    const response = run({ action: 'screenshot', tabId: OTHER_TAB });
    const url = await promptUrl();
    browserMock.tabs.get.mockRejectedValue(new Error(`Invalid tab ID: ${OTHER_TAB}`));
    const id = new URL(url).searchParams.get('id');
    await handlePromptMessage({ type: PROMPT_ANSWER_MESSAGE, id, answer: 'allow_once' }, { id: EXTENSION_ID, url });
    expect(await response).toEqual({
      type: 'tool_response',
      id: '1:1',
      error: { content: [{ type: 'text', text: `Cannot take a screenshot of tab ${OTHER_TAB}: the tab was closed` }] },
    });
    expect(browserMock.tabs.captureTab).not.toHaveBeenCalled();
  });

  it.each([
    ['screenshot', 'take a screenshot of'],
    ['zoom', 'zoom into'],
  ])('discards the %s image when the tab leaves the site during the capture', async (action, target) => {
    browserMock.allowSites('example.com');
    if (action === 'zoom') await screenshot({ tabId: TAB });
    const frameBefore = screenshotFrames.get(TAB);
    const tab = await browserMock.tabs.get(TAB);
    browserMock.tabs.captureTab.mockImplementation(async () => {
      tab.url = 'https://elsewhere.example/';
      return `data:image/jpeg;base64,${CAPTURED}`;
    });
    const response = await run(action === 'zoom' ? { action, tabId: TAB, region: [0, 0, 10, 10] } : { action, tabId: TAB });
    expect(response).toEqual({
      type: 'tool_response',
      id: '1:1',
      error: { content: [{ type: 'text', text: siteChangedMessage(target, TAB, 'example.com') }] },
    });
    expect(screenshotFrames.get(TAB)).toEqual(frameBefore);
  });

  it.each(['screenshot', 'zoom'])('refuses %s on an always denied site without asking', async (action) => {
    browserMock.storage.local.data.set(PERMISSION_STORAGE_KEY, [
      { id: 'deny', host: 'example.com', wildcard: false, decision: 'deny', duration: 'always', createdAt: 0 },
    ]);
    const response = await run(action === 'zoom' ? { action, tabId: TAB, region: [0, 0, 10, 10] } : { action, tabId: TAB });
    expect(response).toEqual({
      type: 'tool_response',
      id: '1:1',
      error: { content: [{ type: 'text', text: blockedMessage('example.com') }] },
    });
    expect(browserMock.windows.create).not.toHaveBeenCalled();
    expect(browserMock.tabs.captureTab).not.toHaveBeenCalled();
  });
});
