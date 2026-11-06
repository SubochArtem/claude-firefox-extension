import type { ContentBlock } from '../protocol';
import { parseResizeWindowArgs } from './resize-window-input';
import { errorMessage, resolveTab } from './tab-access';
import { ToolError } from './tool-error';

const LABEL = { verb: 'resize the window', target: 'resize the window of' };
const SETTLE_POLL_MS = 50;
const SETTLE_POLLS = 20;

function size(window: browser.windows.Window): string {
  return `${window.width ?? '?'}x${window.height ?? '?'}`;
}

// windows.get right after windows.update can still return the old size, and Firefox has no
// windows.onBoundsChanged event, so the size is polled for about a second until it matches.
async function settledWindow(
  windowId: number,
  matches: (window: browser.windows.Window) => boolean,
): Promise<browser.windows.Window> {
  let current = await browser.windows.get(windowId);
  for (let poll = 0; poll < SETTLE_POLLS && !matches(current); poll++) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    current = await browser.windows.get(windowId);
  }
  return current;
}

// No site permission: the window is not tied to a site; the tab is not activated and focus is not requested.
export async function resizeWindow(args: Record<string, unknown>): Promise<ContentBlock[]> {
  const parsed = parseResizeWindowArgs(args);
  if (!parsed.ok) throw new ToolError(`Invalid resize_window arguments: ${parsed.error}`);
  const { width, height } = parsed.value;
  const tab = await resolveTab(parsed.value.tabId, LABEL);
  let window: browser.windows.Window | undefined;
  if (tab.windowId !== undefined) {
    try {
      window = await browser.windows.get(tab.windowId);
    } catch {
      throw new ToolError(`Failed to resize the window: window ${tab.windowId} of tab ${tab.id} no longer exists`);
    }
  }
  const windowId = window?.id;
  if (window?.type !== 'normal' || windowId === undefined) {
    throw new ToolError(`Failed to resize the window: tab ${tab.id} is not in a normal browser window`);
  }
  const previousState = window.state ?? 'normal';
  const exact = (current: browser.windows.Window) => current.width === width && current.height === height;

  let actual: browser.windows.Window;
  try {
    await browser.windows.update(windowId, { ...(previousState === 'normal' ? {} : { state: 'normal' }), width, height });
    actual = await settledWindow(windowId, exact);
    // Leaving maximized or fullscreen is asynchronous on some window managers, which can apply the restored
    // geometry after the size of the combined update; the size is set again once the window is normal.
    if (previousState !== 'normal' && !exact(actual)) {
      await browser.windows.update(windowId, { width, height });
      actual = await settledWindow(windowId, exact);
    }
  } catch (error) {
    throw new ToolError(`Failed to resize window ${windowId} containing tab ${tab.id}: ${errorMessage(error)}`);
  }

  const notes: string[] = [];
  if (previousState !== 'normal') {
    const now = actual.state ?? 'normal';
    notes.push(`The window was ${previousState} and is ${now === 'normal' ? 'now normal' : `still ${now}`}.`);
  }
  if (!exact(actual)) {
    notes.push(
      'The window manager did not apply the exact size; the screen size, a minimum window size or a tiling window manager can limit it.',
    );
  }
  const headline = `Resized window ${windowId} containing tab ${tab.id} to ${size(actual)} (requested ${width}x${height})`;
  const text = notes.length === 0 ? headline : `${headline}. ${notes.join(' ')}`;
  return [{ type: 'text', text }];
}
