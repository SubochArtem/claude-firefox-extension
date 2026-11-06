import type { ApprovalPrompt } from '../permissions/approval';
import type { BidiInputChannel } from './bidi-input';
import type { KeyArgs, KeyboardArgs, TypeArgs } from './computer-input';
import { afterInput, built, inputAccess, type PointerOutcome, sendAndReport } from './computer-pointer';
import { keyActions, typeActions } from './input-actions';
import { isPageZoomShortcut, reloadShortcut } from './input-keys';
import { openTabPage, requireSameSite } from './page-script';
import { errorMessage } from './tab-access';
import { ToolError } from './tool-error';

const TOOL = 'computer';

export const ZOOM_SHORTCUT_MESSAGE =
  'Page zoom shortcuts are not sent: they change the page zoom and invalidate the screenshot coordinate frame. To see details, use the "zoom" action on a region of the last screenshot, or take a new screenshot.';

const TYPE_ACCESS = inputAccess('type', { verb: 'type', target: 'type in' });
const KEY_ACCESS = inputAccess('type', { verb: 'press keys', target: 'press keys in' });

function keyList(text: string): string[] {
  return text.split(/\s+/).filter((key) => key !== '');
}

function pressedText(keys: string[], repeat: number): string {
  let text = `Pressed ${keys.length} ${keys.length === 1 ? 'key' : 'keys'}: ${keys.join(' ')}`;
  if (repeat > 1) text += ` (repeated ${repeat} times)`;
  return text;
}

// Reload shortcuts belong to the browser, and WebDriver key input dispatched to the page may not trigger
// them, so the tab is reloaded through the tabs API instead.
async function reload(args: KeyArgs, prompt: ApprovalPrompt, kind: 'reload' | 'hard'): Promise<PointerOutcome> {
  const tab = await openTabPage(TOOL, args.tabId, prompt, KEY_ACCESS);
  await requireSameSite(TOOL, tab.tabId, tab.host, KEY_ACCESS);
  try {
    if (kind === 'hard') await browser.tabs.reload(tab.tabId, { bypassCache: true });
    else await browser.tabs.reload(tab.tabId);
  } catch (error) {
    throw new ToolError(`Failed to reload tab ${tab.tabId}: ${errorMessage(error)}`);
  }
  const text = `Executed ${keyList(args.text).join(' ')} (reload page)`;
  const after = await afterInput(tab);
  return { text: after.ok ? text : `${text}\n${after.note}` };
}

async function key(args: KeyArgs, prompt: ApprovalPrompt, input: BidiInputChannel | undefined): Promise<PointerOutcome> {
  // Checked first: "plus" and "minus" are only known to the zoom shortcut check, not to the key parser.
  if (isPageZoomShortcut(args.text)) throw new ToolError(ZOOM_SHORTCUT_MESSAGE);
  const reloadKind = reloadShortcut(args.text);
  if (reloadKind !== undefined) return reload(args, prompt, reloadKind);
  const actions = built(keyActions(args.text, args.repeat));
  const tab = await openTabPage(TOOL, args.tabId, prompt, KEY_ACCESS);
  return sendAndReport(tab, KEY_ACCESS, input, actions, pressedText(keyList(args.text), args.repeat));
}

async function type(args: TypeArgs, prompt: ApprovalPrompt, input: BidiInputChannel | undefined): Promise<PointerOutcome> {
  const tab = await openTabPage(TOOL, args.tabId, prompt, TYPE_ACCESS);
  return sendAndReport(tab, TYPE_ACCESS, input, typeActions(args.text), `Typed "${args.text}"`);
}

// Keyboard input goes to the tab's focused element; the tab is not activated.
export function keyboardAction(
  args: KeyboardArgs,
  prompt: ApprovalPrompt,
  input: BidiInputChannel | undefined,
): Promise<PointerOutcome> {
  return args.action === 'type' ? type(args, prompt, input) : key(args, prompt, input);
}
