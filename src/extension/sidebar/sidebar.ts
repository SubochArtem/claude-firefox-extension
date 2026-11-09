import { type AgentLoopEvents, type ChatToolResult, runAgentLoop } from '../chat/agent-loop';
import { AnthropicProvider } from '../chat/anthropic-provider';
import type { ChatMessage, ToolUseBlock } from '../chat/provider';
import { type BoundTab, buildSystemPrompt } from '../chat/system-prompt';
import { ANTHROPIC_API_ORIGIN, type ChatBackend, loadChatSettings } from '../chat-settings';
import { isRecord } from '../tools/navigation-input';
import { type ChatChange, type ChatItem, ChatSession } from './chat-session';
import { ClaudeCodeSession } from './claude-code-session';
import { renderMarkdown } from './markdown';
import { affectsSetup, CHECKING_CLAUDE_CODE, claudeCodeSetupState, type SetupState, setupState } from './setup-state';
import { CHAT_TOOL_CALL_MESSAGE, CLAUDE_CODE_PORT } from './sidebar-constants';

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
let setupGeneration = 0;
let backend: ChatBackend | undefined;

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

const apiSession = new ChatSession(runLoop, (change) => {
  if (backend !== 'claude-code') render(change);
});
const claudeCodeSession = new ClaudeCodeSession({
  connect: () => browser.runtime.connect({ name: CLAUDE_CODE_PORT }),
  windowId: async () => (await currentWindow).id,
  model: async () => (await loadChatSettings()).model,
  onChange: (change) => {
    if (backend === 'claude-code') render(change);
  },
});

function activeSession(): ChatSession | ClaudeCodeSession {
  return backend === 'claude-code' ? claudeCodeSession : apiSession;
}

function renderControls(): void {
  const { running } = activeSession();
  stopButton.disabled = !running;
  newChatButton.disabled = running;
  prompt.disabled = setup.kind !== 'ready';
}

// The Claude Code session cannot outlive a switch away from it; the API conversation stays until New chat.
function switchBackend(next: ChatBackend): void {
  if (backend === next) return;
  const previous = backend;
  backend = next;
  if (previous === 'claude-code') claudeCodeSession.newChat();
  if (previous === 'api') apiSession.stop();
  render({ type: 'clear' });
  for (const item of activeSession().items) render({ type: 'add', item });
  renderControls();
}

function showSetup(state: SetupState): void {
  setup = state;
  element('setup').hidden = setup.kind === 'ready';
  element('setup-text').textContent = setup.kind === 'ready' ? '' : setup.text;
  element('open-options').hidden = setup.kind !== 'needs_key';
  element('grant-access').hidden = setup.kind !== 'needs_access';
  element('check-again').hidden = setup.kind !== 'needs_claude_code';
  renderControls();
}

async function claudeCodeSetup(): Promise<SetupState> {
  try {
    return claudeCodeSetupState(await claudeCodeSession.status());
  } catch (error) {
    return { kind: 'needs_claude_code', text: `Could not check Claude Code: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function renderSetup(generation: number): Promise<void> {
  const settings = await loadChatSettings();
  if (generation !== setupGeneration) return;
  switchBackend(settings.backend);
  if (settings.backend === 'claude-code') {
    showSetup(CHECKING_CLAUDE_CODE);
    const state = await claudeCodeSetup();
    if (generation === setupGeneration) showSetup(state);
    return;
  }
  const granted = await browser.permissions.contains(apiAccess);
  if (generation !== setupGeneration) return;
  showSetup(setupState(settings.apiKey, granted));
}

function refreshSetup(): void {
  const generation = ++setupGeneration;
  renderSetup(generation).catch((error: unknown) => {
    if (generation !== setupGeneration) return;
    element('setup').hidden = false;
    element('setup-text').textContent = `Could not load the chat settings: ${error instanceof Error ? error.message : String(error)}`;
  });
}

// The Claude Code check runs claude twice, so a change of the key or the model does not repeat it.
function onChatSettingsChanged(): void {
  loadChatSettings().then(
    (settings) => {
      if (settings.backend === 'api' || settings.backend !== backend) refreshSetup();
    },
    () => refreshSetup(),
  );
}

prompt.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  const session = activeSession();
  if (session.running || setup.kind !== 'ready') return;
  const text = prompt.value;
  if (text.trim() === '') return;
  prompt.value = '';
  void session.send(text);
});

stopButton.addEventListener('click', () => activeSession().stop());
newChatButton.addEventListener('click', () => {
  activeSession().newChat();
  prompt.focus();
});

element('check-again').addEventListener('click', refreshSetup);

element('open-options').addEventListener('click', () => {
  void browser.runtime.openOptionsPage();
});

element('grant-access').addEventListener('click', () => {
  // permissions.request needs the user gesture, so it is called before anything is awaited.
  browser.permissions.request(apiAccess).then(refreshSetup, refreshSetup);
});

function onApiAccessChanged(): void {
  if (backend !== 'claude-code') refreshSetup();
}

browser.permissions.onAdded.addListener(onApiAccessChanged);
browser.permissions.onRemoved.addListener(onApiAccessChanged);
browser.storage.local.onChanged.addListener((changes) => {
  if (affectsSetup(changes)) onChatSettingsChanged();
});

refreshSetup();
