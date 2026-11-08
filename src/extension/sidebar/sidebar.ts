import { type AgentLoopEvents, type ChatToolResult, runAgentLoop } from '../chat/agent-loop';
import { AnthropicProvider } from '../chat/anthropic-provider';
import type { ChatMessage, ToolUseBlock } from '../chat/provider';
import { type BoundTab, buildSystemPrompt } from '../chat/system-prompt';
import { ANTHROPIC_API_ORIGIN, loadChatSettings } from '../chat-settings';
import { isRecord } from '../tools/navigation-input';
import { type ChatChange, type ChatItem, ChatSession } from './chat-session';
import { renderMarkdown } from './markdown';
import { affectsSetup, type SetupState, setupState } from './setup-state';
import { CHAT_TOOL_CALL_MESSAGE } from './sidebar-messages';

const apiAccess = { origins: [ANTHROPIC_API_ORIGIN] };
const SCROLL_SLACK_PX = 40;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`sidebar page is missing #${id}`);
  return found as T;
}

const messages = element('messages');
const prompt = element<HTMLTextAreaElement>('prompt');
const stopButton = element<HTMLButtonElement>('stop');
const newChatButton = element<HTMLButtonElement>('new-chat');
const views = new Map<number, HTMLElement>();
let setup: SetupState = { kind: 'needs_key', text: '' };

// The sidebar's own window: each window has its own sidebar document.
const currentWindow = browser.windows.getCurrent();

async function boundTab(): Promise<BoundTab | undefined> {
  const { id: windowId } = await currentWindow;
  const [tab] = await browser.tabs.query({ active: true, ...(windowId === undefined ? { currentWindow: true } : { windowId }) });
  if (tab?.id === undefined) return undefined;
  return { id: tab.id, url: tab.url ?? '', title: tab.title ?? '' };
}

async function executeTool(call: ToolUseBlock): Promise<ChatToolResult> {
  const reply: unknown = await browser.runtime.sendMessage({ type: CHAT_TOOL_CALL_MESSAGE, name: call.name, input: call.input });
  if (isRecord(reply) && Array.isArray(reply.content) && typeof reply.isError === 'boolean') return reply as unknown as ChatToolResult;
  return { content: [{ type: 'text', text: 'The tool call got no answer from the extension' }], isError: true };
}

async function runLoop(history: ChatMessage[], signal: AbortSignal, events: AgentLoopEvents) {
  const { apiKey, model } = await loadChatSettings();
  if (apiKey === '') throw new Error('No Anthropic API key is saved. Add it in the options page.');
  const [tab, platform] = await Promise.all([boundTab(), browser.runtime.getPlatformInfo()]);
  const system = buildSystemPrompt({ now: new Date(), model, platform: platform.os, ...(tab === undefined ? {} : { tab }) });
  return runAgentLoop({ provider: new AnthropicProvider({ apiKey }), executeTool, history, model, system, signal, events });
}

function toolView(item: Extract<ChatItem, { kind: 'tool' }>, wasOpen: boolean): HTMLElement {
  const view = document.createElement('div');
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = item.name;
  view.append(name);
  if (item.summary !== '') view.append(` ${item.summary}`);
  if (item.result === undefined) return view;
  const details = document.createElement('details');
  details.open = wasOpen;
  if (item.result.isError) details.className = 'error';
  const summary = document.createElement('summary');
  summary.textContent = item.result.isError ? 'Error' : 'Result';
  const output = document.createElement('pre');
  output.textContent = item.result.text;
  details.append(summary, output);
  view.append(details);
  return view;
}

function itemView(item: ChatItem, previous: HTMLElement | undefined): HTMLElement {
  if (item.kind === 'tool') {
    const view = toolView(item, previous?.querySelector('details')?.open === true);
    view.className = 'tool';
    return view;
  }
  const view = document.createElement('div');
  if (item.kind === 'assistant') view.replaceChildren(renderMarkdown(item.text, document));
  else view.textContent = item.text;
  view.className = item.kind === 'notice' ? `notice ${item.level}` : item.kind;
  return view;
}

function render(change: ChatChange): void {
  const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < SCROLL_SLACK_PX;
  if (change.type === 'clear') {
    views.clear();
    messages.replaceChildren();
  } else if (change.type === 'running') {
    renderControls();
  } else if (change.type === 'remove') {
    views.get(change.item.id)?.remove();
    views.delete(change.item.id);
  } else {
    const previous = views.get(change.item.id);
    const view = itemView(change.item, previous);
    if (previous === undefined) messages.append(view);
    else previous.replaceWith(view);
    views.set(change.item.id, view);
  }
  if (atBottom) messages.scrollTop = messages.scrollHeight;
}

const session = new ChatSession(runLoop, render);

function renderControls(): void {
  stopButton.disabled = !session.running;
  newChatButton.disabled = session.running;
  prompt.disabled = setup.kind !== 'ready';
}

async function renderSetup(): Promise<void> {
  const [{ apiKey }, granted] = await Promise.all([loadChatSettings(), browser.permissions.contains(apiAccess)]);
  setup = setupState(apiKey, granted);
  element('setup').hidden = setup.kind === 'ready';
  element('setup-text').textContent = setup.kind === 'ready' ? '' : setup.text;
  element('open-options').hidden = setup.kind !== 'needs_key';
  element('grant-access').hidden = setup.kind !== 'needs_access';
  renderControls();
}

function refreshSetup(): void {
  renderSetup().catch((error: unknown) => {
    element('setup').hidden = false;
    element('setup-text').textContent = `Could not load the chat settings: ${error instanceof Error ? error.message : String(error)}`;
  });
}

prompt.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  if (session.running || setup.kind !== 'ready') return;
  const text = prompt.value;
  if (text.trim() === '') return;
  prompt.value = '';
  void session.send(text);
});

stopButton.addEventListener('click', () => session.stop());
newChatButton.addEventListener('click', () => {
  session.newChat();
  prompt.focus();
});

element('open-options').addEventListener('click', () => {
  void browser.runtime.openOptionsPage();
});

element('grant-access').addEventListener('click', () => {
  // permissions.request needs the user gesture, so it is called before anything is awaited.
  browser.permissions.request(apiAccess).then(refreshSetup, refreshSetup);
});

browser.permissions.onAdded.addListener(refreshSetup);
browser.permissions.onRemoved.addListener(refreshSetup);
browser.storage.local.onChanged.addListener((changes) => {
  if (affectsSetup(changes)) refreshSetup();
});

refreshSetup();
