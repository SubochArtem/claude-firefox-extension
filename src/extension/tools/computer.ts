import type { ContentBlock } from '../protocol';
import { parseComputerArgs, type ScreenshotArgs, type ZoomArgs } from './computer-input';
import { CoordinateFrames } from './coordinate-frame';
import { type Size, screenshotSize, zoomOutputSize } from './screenshot-size';
import { ToolError } from './tool-error';

// Base64 length that keeps an image at about 1 MB of decoded bytes.
export const MAX_IMAGE_BASE64_LENGTH = 1_398_100;
export const START_JPEG_QUALITY = 0.75;
export const JPEG_QUALITY_STEP = 0.05;
export const MIN_JPEG_QUALITY = 0.1;

interface ActionLabel {
  verb: string;
  target: string;
}

const SCREENSHOT_LABEL: ActionLabel = { verb: 'take a screenshot', target: 'take a screenshot of' };
const ZOOM_LABEL: ActionLabel = { verb: 'zoom', target: 'zoom into' };

export function permissionMessage(verb: string): string {
  return `Failed to ${verb}: the extension is not allowed to access websites. Open about:addons, choose Claude Firefox Extension, open its Permissions tab and enable "Access your data for all websites", then try again.`;
}

// Firefox's default extensions.webextensions.restrictedDomains: no extension may script or capture them.
const RESTRICTED_DOMAINS = new Set([
  'accounts-static.cdn.mozilla.net',
  'accounts.firefox.com',
  'addons.cdn.mozilla.net',
  'addons.mozilla.org',
  'api.accounts.firefox.com',
  'content.cdn.mozilla.net',
  'discovery.addons.mozilla.org',
  'install.mozilla.org',
  'oauth.accounts.firefox.com',
  'profile.accounts.firefox.com',
  'support.mozilla.org',
  'sync.services.mozilla.com',
]);
const CAPTURABLE_PROTOCOLS = new Set(['http:', 'https:', 'file:']);

export const screenshotFrames = new CoordinateFrames();

function forgetFrame(tabId: number): void {
  screenshotFrames.forget(tabId);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return String(error);
}

async function resolveTab(tabId: number | undefined, label: ActionLabel): Promise<browser.tabs.Tab & { id: number }> {
  if (tabId === undefined) {
    const [active] = await browser.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
    if (active?.id === undefined) {
      throw new ToolError(
        `Failed to ${label.verb}: there is no active tab in a normal browser window. Pass a tabId from tabs_context.`,
      );
    }
    return { ...active, id: active.id };
  }
  const tab = await browser.tabs.get(tabId).catch(() => undefined);
  if (!tab) {
    throw new ToolError(
      `Failed to ${label.verb}: tab ${tabId} does not exist (it may have been closed). Call tabs_context to see current tabs.`,
    );
  }
  return { ...tab, id: tabId };
}

function restrictedPageMessage(label: ActionLabel, tabId: number, url: string): string {
  return `Cannot ${label.target} tab ${tabId} (${url}): Firefox does not let extensions access this page (about: and other browser pages, addons.mozilla.org and other Mozilla sites, other extensions' pages, reader view, the PDF viewer), or the page failed to load. Navigate the tab to a regular website first.`;
}

function isRestrictedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  return !CAPTURABLE_PROTOCOLS.has(parsed.protocol) || RESTRICTED_DOMAINS.has(parsed.hostname);
}

// Firefox rejects executeScript with "Missing host permission for the tab[, or any frames]" and
// captureTab with "Missing activeTab permission".
function isPermissionError(message: string): boolean {
  return /missing (host|activeTab) permission/i.test(message);
}

interface Viewport extends Size {
  devicePixelRatio: number;
  scrollX: number;
  scrollY: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositive(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

async function readViewport(label: ActionLabel, tabId: number, url: string): Promise<Viewport> {
  let results: browser.scripting.InjectionResult<unknown>[];
  try {
    results = await browser.scripting.executeScript({
      target: { tabId },
      injectImmediately: true,
      func: () => ({
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      }),
    });
  } catch (error) {
    const message = errorMessage(error);
    if (isPermissionError(message)) throw new ToolError(restrictedPageMessage(label, tabId, url));
    throw new ToolError(`Failed to ${label.target} tab ${tabId}: could not read the viewport size: ${message}`);
  }
  const [main] = results;
  if (main?.error !== undefined) {
    throw new ToolError(
      `Failed to ${label.target} tab ${tabId}: could not read the viewport size: ${errorMessage(main.error)}`,
    );
  }
  const value = main?.result as Partial<Viewport> | undefined;
  if (
    !isPositive(value?.width) ||
    !isPositive(value.height) ||
    !isPositive(value.devicePixelRatio) ||
    !isFiniteNumber(value.scrollX) ||
    !isFiniteNumber(value.scrollY)
  ) {
    throw new ToolError(`Failed to ${label.target} tab ${tabId}: the page reported no usable viewport size`);
  }
  return {
    width: value.width,
    height: value.height,
    devicePixelRatio: value.devicePixelRatio,
    scrollX: value.scrollX,
    scrollY: value.scrollY,
  };
}

function base64FromBytes(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = '';
  for (let start = 0; start < bytes.length; start += chunk) {
    binary += String.fromCharCode(...bytes.subarray(start, start + chunk));
  }
  return btoa(binary);
}

function base64FromDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma === -1) throw new Error('captureTab returned no data URL');
  return dataUrl.slice(comma + 1);
}

// Qualities in whole percent, so repeated subtraction does not drift: 0.75, 0.7, ... 0.1.
function jpegQualities(start: number): number[] {
  const qualities: number[] = [];
  for (let percent = Math.round(start * 100); percent >= Math.round(MIN_JPEG_QUALITY * 100); percent -= JPEG_QUALITY_STEP * 100) {
    qualities.push(percent / 100);
  }
  return qualities;
}

async function encodeJpeg(dataUrl: string, output: Size): Promise<string> {
  const captured = base64FromDataUrl(dataUrl);
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  try {
    const rightSize = bitmap.width === output.width && bitmap.height === output.height;
    if (rightSize && captured.length <= MAX_IMAGE_BASE64_LENGTH) return captured;
    const canvas = new OffscreenCanvas(output.width, output.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2d context for resizing');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, output.width, output.height);
    // The capture was already encoded at the start quality, so a too large capture of the right size
    // starts one step lower.
    const start = rightSize ? START_JPEG_QUALITY - JPEG_QUALITY_STEP : START_JPEG_QUALITY;
    let encoded = captured;
    for (const quality of jpegQualities(start)) {
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      encoded = base64FromBytes(new Uint8Array(await blob.arrayBuffer()));
      if (encoded.length <= MAX_IMAGE_BASE64_LENGTH) break;
    }
    return encoded;
  } finally {
    bitmap.close();
  }
}

async function capturableTab(
  tabId: number | undefined,
  label: ActionLabel,
): Promise<{ tabId: number; url: string }> {
  const tab = await resolveTab(tabId, label);
  const url = tab.url ?? '';
  if (isRestrictedUrl(url)) throw new ToolError(restrictedPageMessage(label, tab.id, url));
  if (!(await browser.permissions.contains({ origins: ['<all_urls>'] }))) {
    throw new ToolError(permissionMessage(label.verb));
  }
  return { tabId: tab.id, url };
}

async function capture(
  label: ActionLabel,
  tabId: number,
  url: string,
  options: browser.extensionTypes.ImageDetails,
  output: Size,
): Promise<string> {
  try {
    const dataUrl = await browser.tabs.captureTab(tabId, {
      format: 'jpeg',
      quality: Math.round(START_JPEG_QUALITY * 100),
      ...options,
    });
    return await encodeJpeg(dataUrl, output);
  } catch (error) {
    const message = errorMessage(error);
    if (isPermissionError(message)) throw new ToolError(restrictedPageMessage(label, tabId, url));
    throw new ToolError(`Failed to ${label.target} tab ${tabId}: ${message}`);
  }
}

async function screenshot(args: ScreenshotArgs): Promise<ContentBlock[]> {
  const { tabId, url } = await capturableTab(args.tabId, SCREENSHOT_LABEL);
  const viewport = await readViewport(SCREENSHOT_LABEL, tabId, url);
  const scale = args.scale ?? 1;
  const { frame, output } = screenshotSize(viewport, scale);

  // tabs.captureTab renders the tab without activating it, unlike captureVisibleTab. Its scale is
  // in image pixels per CSS pixel, so this renders the viewport at about the output size.
  const base64 = await capture(SCREENSHOT_LABEL, tabId, url, { scale: output.width / viewport.width }, output);

  screenshotFrames.record(tabId, { width: viewport.width, height: viewport.height }, frame);
  if (!browser.tabs.onRemoved.hasListener(forgetFrame)) browser.tabs.onRemoved.addListener(forgetFrame);

  let text = `Captured screenshot (${output.width}x${output.height}, jpeg)`;
  if (scale < 1) {
    text += `. Coordinates refer to the ${frame.width}x${frame.height} screenshot frame, not to this scaled image.`;
  }
  return [
    { type: 'text', text },
    { type: 'image', data: base64, mimeType: 'image/jpeg' },
  ];
}

// Zoom keeps the last screenshot's coordinate frame, so later actions still use its coordinates.
async function zoom(args: ZoomArgs): Promise<ContentBlock[]> {
  const { tabId, url } = await capturableTab(args.tabId, ZOOM_LABEL);
  const { frame } = screenshotFrames.require(tabId);
  const viewport = await readViewport(ZOOM_LABEL, tabId, url);
  const rect = screenshotFrames.regionToViewport(tabId, args.region, viewport);
  const output = zoomOutputSize(rect, viewport.devicePixelRatio, args.scale ?? 1);

  // captureTab's rect is relative to the document, not to the viewport.
  const base64 = await capture(
    ZOOM_LABEL,
    tabId,
    url,
    {
      rect: { x: rect.x + viewport.scrollX, y: rect.y + viewport.scrollY, width: rect.width, height: rect.height },
      scale: output.width / rect.width,
    },
    output,
  );

  return [
    {
      type: 'text',
      text: `Zoomed into region [${args.region.join(', ')}] of the ${frame.width}x${frame.height} screenshot frame of tab ${tabId} (${output.width}x${output.height}, jpeg). Coordinates still refer to the screenshot frame, not to this image.`,
    },
    { type: 'image', data: base64, mimeType: 'image/jpeg' },
  ];
}

export async function computer(args: Record<string, unknown>): Promise<ContentBlock[]> {
  const parsed = parseComputerArgs(args);
  if (!parsed.ok) throw new ToolError(`Invalid computer arguments: ${parsed.error}`);
  return parsed.value.action === 'zoom' ? zoom(parsed.value) : screenshot(parsed.value);
}
