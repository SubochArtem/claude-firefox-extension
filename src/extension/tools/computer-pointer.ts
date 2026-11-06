import { ELEMENT_POINT_ENTRY, type ElementPointResult } from '../page/element-point-api';
import { READ_PAGE_SCRIPT } from '../page/read-page-api';
import type { ApprovalPrompt } from '../permissions/approval';
import { siteForUrl } from '../permissions/site';
import { landedSite } from '../permissions/site-access';
import { type BidiInputChannel, performInput } from './bidi-input';
import type { ClickAction, Coordinate, PointerArgs, PointerTarget, ScrollArgs } from './computer-input';
import { type Point, screenshotFrames } from './coordinate-frame';
import { clickActions, dragActions, hoverActions, type InputSource, type MouseButton, scrollActions } from './input-actions';
import { unapprovedText } from './navigate';
import type { ParseResult } from './navigation-input';
import { type OpenTab, openTabPage, type PageAccess, requireSameSite, runOnTabPage } from './page-script';
import type { ActionLabel } from './tab-access';
import { ToolError } from './tool-error';

// Smooth scrolling keeps moving the page after the wheel input is done.
export const SCROLL_SETTLE_MS = 500;
// Time for an activated tab to be laid out and painted before it receives the wheel input.
export const ACTIVATE_SETTLE_MS = 250;
export const BACKGROUND_SCROLL_NOTE = '(tab activated: wheel scrolling does not work in background tabs)';

export function siteChangedNote(tabId: number, host: string, landedHost: string | undefined): string {
  return `Tab ${tabId} moved from ${host} to ${landedHost ?? 'another page'} after the input, so no screenshot was attached. Take a new screenshot of the tab.`;
}

const TOOL = 'computer';

export function inputPageChangedMessage(target: string): PageAccess['pageChanged'] {
  return (_tool, tabId, host) =>
    `Cannot ${target} tab ${tabId}: the page navigated away from ${host} to another site, so no input was sent. Take a new screenshot of the tab before trying again; a page on another site needs its own permission.`;
}

function access(action: PageAccess['action'], label: ActionLabel): PageAccess {
  return { action, label, pageChanged: inputPageChangedMessage(label.target) };
}

const CLICK_ACCESS = access('click', { verb: 'click', target: 'click in' });

const ACCESS: Record<PointerArgs['action'], PageAccess> = {
  left_click: CLICK_ACCESS,
  right_click: CLICK_ACCESS,
  double_click: CLICK_ACCESS,
  triple_click: CLICK_ACCESS,
  hover: access('read_page_content', { verb: 'hover', target: 'hover in' }),
  left_click_drag: access('click', { verb: 'drag', target: 'drag in' }),
  scroll: access('read_page_content', { verb: 'scroll', target: 'scroll' }),
  scroll_to: access('read_page_content', { verb: 'scroll to an element', target: 'scroll' }),
};

const CLICKS: Record<ClickAction, { button: MouseButton; clickCount: number; verb: string }> = {
  left_click: { button: 'left', clickCount: 1, verb: 'Clicked' },
  right_click: { button: 'right', clickCount: 1, verb: 'Right-clicked' },
  double_click: { button: 'left', clickCount: 2, verb: 'Double-clicked' },
  triple_click: { button: 'left', clickCount: 3, verb: 'Triple-clicked' },
};

// screenshot is the tab to attach a screenshot of, still on its approved host after the input.
export interface PointerOutcome {
  text: string;
  screenshot?: OpenTab;
}

function isResult(value: unknown): value is ElementPointResult {
  if (typeof value !== 'object' || value === null) return false;
  const reply = value as Record<string, unknown>;
  if (reply.ok === false) return typeof reply.error === 'string';
  return reply.ok === true && Number.isFinite(reply.x) && Number.isFinite(reply.y);
}

async function elementPoint(tab: OpenTab, ref: string, pageAccess: PageAccess, scrollOnly = false): Promise<Point> {
  const options = scrollOnly ? { ref, scrollOnly } : { ref };
  const result = await runOnTabPage(
    TOOL,
    tab,
    { entry: ELEMENT_POINT_ENTRY, file: READ_PAGE_SCRIPT, options, isResult },
    pageAccess,
  );
  if (!result.ok) throw new ToolError(result.error);
  return { x: result.x, y: result.y };
}

function framePoint(tab: OpenTab, [x, y]: Coordinate): Point {
  return screenshotFrames.toViewport(tab.tabId, { x, y });
}

function targetPoint(tab: OpenTab, target: PointerTarget, pageAccess: PageAccess): Promise<Point> {
  return 'ref' in target ? elementPoint(tab, target.ref, pageAccess) : Promise.resolve(framePoint(tab, target.coordinate));
}

function describeCoordinate([x, y]: Coordinate): string {
  return `(${x}, ${y})`;
}

function built(result: ParseResult<InputSource[]>): InputSource[] {
  if (!result.ok) throw new ToolError(`Invalid computer arguments: ${result.error}`);
  return result.value;
}

type AfterInput = { ok: true; tab: OpenTab } | { ok: false; note: string };

// A click may navigate the tab, so nothing from the page is attached unless it is still on an allowed site.
async function afterInput(tab: OpenTab): Promise<AfterInput> {
  const current = await browser.tabs.get(tab.tabId).catch(() => undefined);
  if (!current) return { ok: false, note: `Tab ${tab.tabId} was closed after the input.` };
  const landed = await landedSite(current.url, tab.host);
  if (!landed.allowed) return { ok: false, note: unapprovedText(tab.tabId, landed.host) };
  return { ok: true, tab: { ...tab, url: current.url ?? tab.url } };
}

async function send(tab: OpenTab, pageAccess: PageAccess, input: BidiInputChannel | undefined, actions: InputSource[]) {
  const url = await requireSameSite(TOOL, tab.tabId, tab.host, pageAccess);
  await performInput(input, tab.tabId, url, actions);
}

async function sendAndReport(
  tab: OpenTab,
  pageAccess: PageAccess,
  input: BidiInputChannel | undefined,
  actions: InputSource[],
  text: string,
): Promise<PointerOutcome> {
  await send(tab, pageAccess, input, actions);
  const after = await afterInput(tab);
  return { text: after.ok ? text : `${text}\n${after.note}` };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Firefox delivers a trusted wheel event to a background tab but does not scroll it, so scroll alone activates
// the tab first. The window is not focused. A closed tab is left to the site check before the input.
async function activateForWheel(tabId: number): Promise<boolean> {
  const current = await browser.tabs.get(tabId).catch(() => undefined);
  if (!current || current.active) return false;
  await browser.tabs.update(tabId, { active: true });
  await delay(ACTIVATE_SETTLE_MS);
  return true;
}

async function scroll(
  tab: OpenTab,
  pageAccess: PageAccess,
  input: BidiInputChannel | undefined,
  args: ScrollArgs,
): Promise<PointerOutcome> {
  const point = framePoint(tab, args.coordinate);
  const actions = built(scrollActions({ point, direction: args.direction, amount: args.amount }));
  const activated = await activateForWheel(tab.tabId);
  await send(tab, pageAccess, input, actions);
  await delay(SCROLL_SETTLE_MS);
  let text = `Scrolled ${args.direction} by ${args.amount} ticks at ${describeCoordinate(args.coordinate)}`;
  if (activated) text += ` ${BACKGROUND_SCROLL_NOTE}`;
  const after = await afterInput(tab);
  if (!after.ok) return { text: `${text}\n${after.note}` };
  // The screenshot is checked against the host approved for this call, so another allowed site gets a note instead.
  const site = siteForUrl(after.tab.url);
  const landedHost = site.ok ? site.host : undefined;
  if (landedHost !== tab.host) return { text: `${text}\n${siteChangedNote(tab.tabId, tab.host, landedHost)}` };
  return { text, screenshot: after.tab };
}

export async function pointerAction(
  args: PointerArgs,
  prompt: ApprovalPrompt,
  input: BidiInputChannel | undefined,
): Promise<PointerOutcome> {
  const pageAccess = ACCESS[args.action];
  const tab = await openTabPage(TOOL, args.tabId, prompt, pageAccess);
  switch (args.action) {
    case 'scroll_to':
      await elementPoint(tab, args.ref, pageAccess, true);
      return { text: `Scrolled to element with reference: ${args.ref}` };
    case 'hover': {
      const point = await targetPoint(tab, args.target, pageAccess);
      const where = 'ref' in args.target ? `over element ${args.target.ref}` : `at ${describeCoordinate(args.target.coordinate)}`;
      return sendAndReport(tab, pageAccess, input, built(hoverActions(point)), `Hovered ${where}`);
    }
    case 'left_click_drag': {
      const actions = built(dragActions(framePoint(tab, args.start), framePoint(tab, args.end)));
      const text = `Dragged from ${describeCoordinate(args.start)} to ${describeCoordinate(args.end)}`;
      return sendAndReport(tab, pageAccess, input, actions, text);
    }
    case 'scroll':
      return scroll(tab, pageAccess, input, args);
    default: {
      const { button, clickCount, verb } = CLICKS[args.action];
      const point = await targetPoint(tab, args.target, pageAccess);
      const actions = built(clickActions({ point, button, clickCount, modifiers: args.modifiers ?? '' }));
      const where = 'ref' in args.target ? `on element ${args.target.ref}` : `at ${describeCoordinate(args.target.coordinate)}`;
      return sendAndReport(tab, pageAccess, input, actions, `${verb} ${where}`);
    }
  }
}
