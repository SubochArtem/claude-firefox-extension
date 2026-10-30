import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeTool } from '../tools';
import { MAX_IMAGE_BASE64_LENGTH, PERMISSION_MESSAGE, screenshotFrames } from '../tools/computer';
import { mockBrowser } from './browser-mock';

const TAB = 5;
const OTHER_TAB = 6;
const PAGE = 'https://example.com/';
const CAPTURED = 'Y2FwdHVyZWQ=';
const SMALL_BYTES = 1_000;
// Base64 of this many bytes is just over MAX_IMAGE_BASE64_LENGTH.
const LARGE_BYTES = 1_048_576;

let browserMock: ReturnType<typeof mockBrowser>;
let viewport: { width: number; height: number; devicePixelRatio: number };
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
  viewport = { width: 1280, height: 720, devicePixelRatio: 2 };
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
    viewport = { width: 2560, height: 1440, devicePixelRatio: 1 };
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
    expect(await failure()).toBe(PERMISSION_MESSAGE);
    expect(PERMISSION_MESSAGE).toContain('about:addons');
    expect(PERMISSION_MESSAGE).toContain('Access your data for all websites');
    expect(browserMock.permissions.contains).toHaveBeenCalledWith({ origins: ['<all_urls>'] });
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it.each([
    'about:addons',
    'about:blank',
    'https://addons.mozilla.org/en-US/firefox/',
    'https://support.mozilla.org/',
    'moz-extension://0a1b2c3d/page.html',
    'view-source:https://example.com/',
    '',
  ])('refuses the restricted page %j', async (url) => {
    browserMock.tabs.get.mockResolvedValue({ id: OTHER_TAB, url });
    expect(await failure({ tabId: OTHER_TAB })).toMatch(
      new RegExp(`^Cannot take a screenshot of tab ${OTHER_TAB} .*Firefox does not let extensions access this page`),
    );
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
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
    viewport = { width: 0, height: 720, devicePixelRatio: 1 };
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
