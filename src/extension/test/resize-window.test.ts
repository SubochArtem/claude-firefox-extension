import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeTool } from '../tools';
import { mockBrowser } from './browser-mock';

const WINDOW = 1;
const POPUP_WINDOW = 2;
const TAB = 5;
const POPUP_TAB = 6;

let browserMock: ReturnType<typeof mockBrowser>;
let windowState: Partial<browser.windows.Window>;
// What the window manager applies for a requested size; the identity by default.
let applySize: (width: number, height: number) => [number, number];

function request(args: Record<string, unknown>) {
  return { type: 'tool_request' as const, id: '1:7', tool: 'resize_window', args };
}

async function run(args: Record<string, unknown>) {
  const response = executeTool(request(args));
  await vi.runAllTimersAsync();
  return response;
}

function success(text: string) {
  return { type: 'tool_response', id: '1:7', result: { content: [{ type: 'text', text }] } };
}

function failure(text: string) {
  return { type: 'tool_response', id: '1:7', error: { content: [{ type: 'text', text }] } };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  browserMock = mockBrowser();
  windowState = { id: WINDOW, type: 'normal', state: 'normal', width: 1000, height: 800, focused: false };
  applySize = (width, height) => [width, height];
  browserMock.tabs.get.mockImplementation(async (tabId) => {
    if (tabId === TAB) return { id: TAB, windowId: WINDOW, active: false, url: 'https://example.com/' };
    if (tabId === POPUP_TAB) return { id: POPUP_TAB, windowId: POPUP_WINDOW, active: true };
    throw new Error(`Invalid tab ID: ${tabId}`);
  });
  browserMock.query.mockImplementation(async () => [{ id: TAB, windowId: WINDOW, active: true }]);
  browserMock.windows.get.mockImplementation(async (windowId) => {
    if (windowId === WINDOW) return { ...windowState };
    if (windowId === POPUP_WINDOW) return { id: POPUP_WINDOW, type: 'popup', state: 'normal' };
    throw new Error(`Invalid window ID: ${windowId}`);
  });
  browserMock.windows.update.mockImplementation(async (windowId, info) => {
    if (info.state !== undefined) windowState.state = info.state;
    if (info.width !== undefined && info.height !== undefined) {
      const [width, height] = applySize(info.width, info.height);
      windowState.width = width;
      windowState.height = height;
    }
    return { ...windowState, id: windowId };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const NOT_APPLIED =
  'The window manager did not apply the exact size; the screen size, a minimum window size or a tiling window manager can limit it.';

describe('resize_window', () => {
  it('resizes the window of the given tab without focusing it or activating the tab', async () => {
    const response = await run({ tabId: TAB, width: 1280.7, height: 720 });
    expect(response).toEqual(success(`Resized window ${WINDOW} containing tab ${TAB} to 1280x720 (requested 1280x720)`));
    expect(browserMock.windows.update).toHaveBeenCalledTimes(1);
    expect(browserMock.windows.update).toHaveBeenCalledWith(WINDOW, { width: 1280, height: 720 });
    expect(browserMock.tabs.update).not.toHaveBeenCalled();
    expect(browserMock.storage.local.get).not.toHaveBeenCalled();
  });

  it('defaults to the active tab of the last focused normal window', async () => {
    const response = await run({ width: 800, height: 600 });
    expect(browserMock.query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true, windowType: 'normal' });
    expect(response).toEqual(success(`Resized window ${WINDOW} containing tab ${TAB} to 800x600 (requested 800x600)`));
  });

  it.each(['maximized', 'minimized', 'fullscreen'] as const)('sets a %s window back to normal with the size in one update', async (state) => {
    windowState.state = state;
    const response = await run({ tabId: TAB, width: 1024, height: 768 });
    expect(browserMock.windows.update).toHaveBeenCalledTimes(1);
    expect(browserMock.windows.update).toHaveBeenCalledWith(WINDOW, { state: 'normal', width: 1024, height: 768 });
    expect(response).toEqual(
      success(`Resized window ${WINDOW} containing tab ${TAB} to 1024x768 (requested 1024x768). The window was ${state} and is now normal.`),
    );
  });

  it('applies the size again after the state change when Firefox ignored it in the combined update', async () => {
    windowState.state = 'maximized';
    windowState.width = 1920;
    windowState.height = 1080;
    browserMock.windows.update.mockImplementationOnce(async (windowId) => {
      windowState.state = 'normal';
      return { ...windowState, id: windowId };
    });
    const response = await run({ tabId: TAB, width: 1024, height: 768 });
    expect(browserMock.windows.update.mock.calls).toEqual([
      [WINDOW, { state: 'normal', width: 1024, height: 768 }],
      [WINDOW, { width: 1024, height: 768 }],
    ]);
    expect(response).toEqual(
      success(`Resized window ${WINDOW} containing tab ${TAB} to 1024x768 (requested 1024x768). The window was maximized and is now normal.`),
    );
  });

  it('settles the size read back after the retry when the combined update left the old size', async () => {
    windowState.state = 'maximized';
    windowState.width = 1920;
    windowState.height = 1080;
    browserMock.windows.update
      .mockImplementationOnce(async (windowId) => {
        windowState.state = 'normal';
        return { ...windowState, id: windowId };
      })
      .mockImplementationOnce(async (windowId, info) => {
        let staleReads = 3;
        browserMock.windows.get.mockImplementation(async () => {
          if (staleReads-- > 0) return { ...windowState };
          return { ...windowState, width: info.width, height: info.height };
        });
        return { ...windowState, id: windowId };
      });
    const response = await run({ tabId: TAB, width: 1024, height: 768 });
    expect(browserMock.windows.update).toHaveBeenCalledTimes(2);
    expect(browserMock.windows.get).toHaveBeenCalledTimes(1 + 21 + 4);
    expect(response).toEqual(
      success(`Resized window ${WINDOW} containing tab ${TAB} to 1024x768 (requested 1024x768). The window was maximized and is now normal.`),
    );
  });

  it('reports a window closed while the size is polled', async () => {
    browserMock.windows.update.mockImplementationOnce(async (windowId) => {
      browserMock.windows.get.mockRejectedValue(new Error(`Invalid window ID: ${windowId}`));
      return { ...windowState, id: windowId };
    });
    const response = await run({ tabId: TAB, width: 800, height: 600 });
    expect(response).toEqual(failure(`Failed to resize window ${WINDOW} containing tab ${TAB}: Invalid window ID: ${WINDOW}`));
  });

  it('reports the actual size when the window manager does not apply the requested one', async () => {
    applySize = (width, height) => [Math.min(width, 2560), Math.min(height, 1400)];
    const response = await run({ tabId: TAB, width: 7680, height: 4320 });
    expect(browserMock.windows.update).toHaveBeenCalledTimes(1);
    expect(response).toEqual(
      success(
        `Resized window ${WINDOW} containing tab ${TAB} to 2560x1400 (requested 7680x4320). ${NOT_APPLIED}`,
      ),
    );
  });

  it('waits until the size read back settles before reporting it', async () => {
    browserMock.windows.update.mockImplementationOnce(async (windowId, info) => {
      let staleReads = 3;
      browserMock.windows.get.mockImplementation(async () => {
        if (staleReads-- > 0) return { ...windowState };
        return { ...windowState, width: info.width, height: info.height };
      });
      return { ...windowState, id: windowId };
    });
    const response = await run({ tabId: TAB, width: 1000, height: 700 });
    expect(response).toEqual(success(`Resized window ${WINDOW} containing tab ${TAB} to 1000x700 (requested 1000x700)`));
    expect(browserMock.windows.get).toHaveBeenCalledTimes(1 + 4);
    expect(browserMock.windows.update).toHaveBeenCalledTimes(1);
  });

  it('reports the size not applied only after about a second of polling', async () => {
    applySize = () => [1290, 1050];
    const response = executeTool(request({ tabId: TAB, width: 1000, height: 700 }));
    let settled = false;
    void response.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(900);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(settled).toBe(true);
    expect(await response).toEqual(
      success(`Resized window ${WINDOW} containing tab ${TAB} to 1290x1050 (requested 1000x700). ${NOT_APPLIED}`),
    );
    expect(browserMock.windows.get).toHaveBeenCalledTimes(1 + 21);
  });

  it('reports a window that stays maximized and keeps its size after the retry', async () => {
    windowState.state = 'maximized';
    windowState.width = 1920;
    windowState.height = 1080;
    browserMock.windows.update.mockImplementation(async (windowId) => ({ ...windowState, id: windowId }));
    const response = await run({ tabId: TAB, width: 1024, height: 768 });
    expect(browserMock.windows.update).toHaveBeenCalledTimes(2);
    expect(response).toEqual(
      success(
        `Resized window ${WINDOW} containing tab ${TAB} to 1920x1080 (requested 1024x768). The window was maximized and is still maximized. ${NOT_APPLIED}`,
      ),
    );
  });

  it('reports a window that no longer exists', async () => {
    browserMock.tabs.get.mockResolvedValueOnce({ id: TAB, windowId: 9, active: false });
    const response = await run({ tabId: TAB, width: 800, height: 600 });
    expect(response).toEqual(failure(`Failed to resize the window: window 9 of tab ${TAB} no longer exists`));
    expect(browserMock.windows.update).not.toHaveBeenCalled();
  });

  it('refuses a tab that is not in a normal window', async () => {
    const response = await run({ tabId: POPUP_TAB, width: 800, height: 600 });
    expect(response).toEqual(failure(`Failed to resize the window: tab ${POPUP_TAB} is not in a normal browser window`));
    expect(browserMock.windows.update).not.toHaveBeenCalled();
  });

  it('reports a tab that does not exist', async () => {
    const response = await run({ tabId: 99, width: 800, height: 600 });
    expect(response).toEqual(
      failure('Failed to resize the window: tab 99 does not exist (it may have been closed). Call tabs_context to see current tabs.'),
    );
  });

  it('reports invalid arguments without touching the window', async () => {
    const response = await run({ tabId: TAB, width: 0, height: 600 });
    expect(response).toEqual(failure('Invalid resize_window arguments: width must be at least 1, received 0'));
    expect(browserMock.windows.get).not.toHaveBeenCalled();
  });

  it('reports a failed update', async () => {
    browserMock.windows.update.mockRejectedValueOnce(new Error('Invalid window ID: 1'));
    const response = await run({ tabId: TAB, width: 800, height: 600 });
    expect(response).toEqual(failure(`Failed to resize window ${WINDOW} containing tab ${TAB}: Invalid window ID: 1`));
  });
});
