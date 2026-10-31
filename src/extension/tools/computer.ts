import type { ApprovalPrompt } from '../permissions/approval';
import { siteForUrl } from '../permissions/site';
import { requireSiteAccess } from '../permissions/site-access';
import type { ContentBlock } from '../protocol';
import { parseComputerArgs, type ScreenshotArgs, type ZoomArgs } from './computer-input';
import { CoordinateFrames } from './coordinate-frame';
import { type Size, screenshotSize, zoomOutputSize } from './screenshot-size';
import {
  type ActionLabel,
  errorMessage,
  isPermissionError,
  isRestrictedDomain,
  permissionMessage,
  resolveTab,
  restrictedPageMessage,
} from './tab-access';
import { ToolError } from './tool-error';

// Base64 length that keeps an image at about 1 MB of decoded bytes.
export const MAX_IMAGE_BASE64_LENGTH = 1_398_100;
export const START_JPEG_QUALITY = 0.75;
export const JPEG_QUALITY_STEP = 0.05;
export const MIN_JPEG_QUALITY = 0.1;

const SCREENSHOT_LABEL: ActionLabel = { verb: 'take a screenshot', target: 'take a screenshot of' };
const ZOOM_LABEL: ActionLabel = { verb: 'zoom', target: 'zoom into' };

export function siteChangedMessage(target: string, tabId: number, host: string): string {
  return `Cannot ${target} tab ${tabId}: the tab navigated away from ${host} before the capture, so nothing was captured. Try again; a page on another site needs its own permission.`;
}

export const screenshotFrames = new CoordinateFrames();

function forgetFrame(tabId: number): void {
  screenshotFrames.forget(tabId);
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

interface CapturableTab {
  tabId: number;
  url: string;
  host: string;
}

// The tab may navigate while the permission prompt is open or while the capture runs, so the host is
// checked again after both; an image of a page on another site is never returned.
async function requireSameSite(label: ActionLabel, tabId: number, host: string): Promise<string> {
  const tab = await browser.tabs.get(tabId).catch(() => undefined);
  if (!tab) throw new ToolError(`Cannot ${label.target} tab ${tabId}: the tab was closed`);
  const url = tab.url ?? '';
  const site = siteForUrl(url);
  if (!site.ok || site.host !== host) throw new ToolError(siteChangedMessage(label.target, tabId, host));
  return url;
}

async function capturableTab(tabId: number | undefined, label: ActionLabel, prompt: ApprovalPrompt): Promise<CapturableTab> {
  const tab = await resolveTab(tabId, label);
  const url = tab.url ?? '';
  // Checked before the site permission, so the user is not asked about a page that cannot be captured.
  if (isRestrictedDomain(url)) throw new ToolError(restrictedPageMessage(label, tab.id, url));
  if (!(await browser.permissions.contains({ origins: ['<all_urls>'] }))) {
    throw new ToolError(permissionMessage(label.verb));
  }
  const host = await requireSiteAccess(
    {
      url,
      tool: 'computer',
      action: 'read_page_content',
      subject: `Cannot ${label.target} tab ${tab.id} (${url})`,
    },
    prompt,
  );
  return { tabId: tab.id, url: await requireSameSite(label, tab.id, host), host };
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

async function screenshot(args: ScreenshotArgs, prompt: ApprovalPrompt): Promise<ContentBlock[]> {
  const { tabId, url, host } = await capturableTab(args.tabId, SCREENSHOT_LABEL, prompt);
  const viewport = await readViewport(SCREENSHOT_LABEL, tabId, url);
  const scale = args.scale ?? 1;
  const { frame, output } = screenshotSize(viewport, scale);

  // tabs.captureTab renders the tab without activating it, unlike captureVisibleTab. Its scale is
  // in image pixels per CSS pixel, so this renders the viewport at about the output size.
  const base64 = await capture(SCREENSHOT_LABEL, tabId, url, { scale: output.width / viewport.width }, output);
  await requireSameSite(SCREENSHOT_LABEL, tabId, host);

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
async function zoom(args: ZoomArgs, prompt: ApprovalPrompt): Promise<ContentBlock[]> {
  const { tabId, url, host } = await capturableTab(args.tabId, ZOOM_LABEL, prompt);
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
  await requireSameSite(ZOOM_LABEL, tabId, host);

  return [
    {
      type: 'text',
      text: `Zoomed into region [${args.region.join(', ')}] of the ${frame.width}x${frame.height} screenshot frame of tab ${tabId} (${output.width}x${output.height}, jpeg). Coordinates still refer to the screenshot frame, not to this image.`,
    },
    { type: 'image', data: base64, mimeType: 'image/jpeg' },
  ];
}

export async function computer(args: Record<string, unknown>, prompt: ApprovalPrompt): Promise<ContentBlock[]> {
  const parsed = parseComputerArgs(args);
  if (!parsed.ok) throw new ToolError(`Invalid computer arguments: ${parsed.error}`);
  return parsed.value.action === 'zoom' ? zoom(parsed.value, prompt) : screenshot(parsed.value, prompt);
}
