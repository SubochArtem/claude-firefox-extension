import {
  ANTHROPIC_API_ORIGIN,
  CHAT_MODELS,
  CHAT_SETTINGS_STORAGE_KEY,
  type ChatBackend,
  type ChatModel,
  loadChatSettings,
  saveChatSettings,
  validApiKey,
} from '../chat-settings';
import { loadPermissions, PERMISSION_STORAGE_KEY } from '../permissions/permission-store';
import { type AgentTabs, loadSettings, saveSettings, SETTINGS_STORAGE_KEY } from '../settings';
import type { ClaudeCodeStatusReply } from '../chat/claude-code-relay';
import { CLAUDE_CODE_STATUS_MESSAGE, REVOKE_PERMISSION_MESSAGE } from './options-messages';
import { apiKeyStatus, claudeCodeStatusText, permissionRows } from './options-view';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`options page is missing #${id}`);
  return found as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function showStatus(text: string): void {
  element('status').textContent = text;
}

function reportFailure(task: Promise<void>, what: string): void {
  task.catch((error: unknown) => showStatus(`Could not ${what}: ${errorMessage(error)}`));
}

const agentTabInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="agentTabs"]')];

async function renderSettings(): Promise<void> {
  const { agentTabs } = await loadSettings();
  for (const input of agentTabInputs) input.checked = input.value === agentTabs;
}

function cell(text: string, className?: string): HTMLTableCellElement {
  const td = document.createElement('td');
  td.textContent = text;
  if (className !== undefined) td.className = className;
  return td;
}

async function revoke(id: string, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    const reply = (await browser.runtime.sendMessage({ type: REVOKE_PERMISSION_MESSAGE, id })) as { revoked: boolean };
    showStatus(reply.revoked ? '' : 'This permission was already removed.');
  } catch (error) {
    showStatus(`Could not revoke the permission: ${errorMessage(error)}`);
  }
  await renderPermissions();
}

let renderGeneration = 0;

async function renderPermissions(): Promise<void> {
  const generation = ++renderGeneration;
  const records = await loadPermissions();
  // A newer render started while this one was loading; its result is the current one.
  if (generation !== renderGeneration) return;
  const rows = permissionRows(records, (ms) => new Date(ms).toLocaleString());
  element('empty').hidden = rows.length > 0;
  element('permissions').hidden = rows.length === 0;
  element('permission-rows').replaceChildren(
    ...rows.map((row) => {
      const tr = document.createElement('tr');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Revoke';
      button.addEventListener('click', () => reportFailure(revoke(row.id, button), 'revoke the permission'));
      const action = document.createElement('td');
      action.append(button);
      tr.append(cell(row.site, 'site'), cell(row.decision), cell(row.duration), cell(row.created), cell(row.lastUsed), action);
      return tr;
    }),
  );
}

for (const input of agentTabInputs) {
  input.addEventListener('change', () => {
    if (!input.checked) return;
    saveSettings({ agentTabs: input.value as AgentTabs }).then(
      () => showStatus(''),
      (error: unknown) => {
        showStatus(`Could not save the setting: ${errorMessage(error)}`);
        reportFailure(renderSettings(), 'load the setting');
      },
    );
  });
}

const backendInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="chatBackend"]')];
const apiKeyInput = element<HTMLInputElement>('api-key');
const modelSelect = element<HTMLSelectElement>('chat-model');
const grantButton = element<HTMLButtonElement>('api-access-grant');
const apiAccess = { origins: [ANTHROPIC_API_ORIGIN] };

modelSelect.replaceChildren(
  ...CHAT_MODELS.map((model) => {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.label;
    return option;
  }),
);

async function renderChatSettings(): Promise<void> {
  const { apiKey, model, backend } = await loadChatSettings();
  element('api-key-status').textContent = apiKeyStatus(apiKey);
  modelSelect.value = model;
  for (const input of backendInputs) input.checked = input.value === backend;
}

async function renderApiAccess(): Promise<void> {
  const granted = await browser.permissions.contains(apiAccess);
  element('api-access-status').textContent = granted
    ? 'Access to api.anthropic.com is granted.'
    : 'Access to api.anthropic.com is not granted. The sidebar chat needs it.';
  grantButton.hidden = granted;
}

async function renderClaudeCodeStatus(): Promise<void> {
  const reply = (await browser.runtime.sendMessage({ type: CLAUDE_CODE_STATUS_MESSAGE })) as ClaudeCodeStatusReply;
  element('claude-code-status').textContent = claudeCodeStatusText(reply);
}

let chatSettingsUpdate: Promise<void> = Promise.resolve();

// Each update reads and writes the whole record, so updates run one at a time to keep each other's changes.
function updateChatSettings(change: { apiKey?: string; model?: ChatModel; backend?: ChatBackend }): Promise<void> {
  const update = chatSettingsUpdate.then(async () => {
    await saveChatSettings({ ...(await loadChatSettings()), ...change });
    showStatus('');
  });
  chatSettingsUpdate = update.catch(() => undefined);
  return update;
}

element('api-key-save').addEventListener('click', () => {
  const apiKey = validApiKey(apiKeyInput.value);
  if (apiKey === undefined) {
    showStatus('The API key must contain only printable ASCII characters without spaces.');
    return;
  }
  if (apiKey === '') {
    showStatus('Enter an API key to save.');
    return;
  }
  reportFailure(
    updateChatSettings({ apiKey }).then(() => {
      apiKeyInput.value = '';
    }),
    'save the API key',
  );
});

element('api-key-clear').addEventListener('click', () => {
  apiKeyInput.value = '';
  reportFailure(updateChatSettings({ apiKey: '' }), 'clear the API key');
});

for (const input of backendInputs) {
  input.addEventListener('change', () => {
    if (!input.checked) return;
    reportFailure(
      updateChatSettings({ backend: input.value as ChatBackend }).catch((error: unknown) => {
        reportFailure(renderChatSettings(), 'load the chat settings');
        throw error;
      }),
      'save the chat backend',
    );
  });
}

modelSelect.addEventListener('change', () => {
  reportFailure(
    updateChatSettings({ model: modelSelect.value as ChatModel }).catch((error: unknown) => {
      reportFailure(renderChatSettings(), 'load the chat settings');
      throw error;
    }),
    'save the model',
  );
});

grantButton.addEventListener('click', () => {
  // permissions.request needs the user gesture, so it is called before anything is awaited.
  reportFailure(
    browser.permissions.request(apiAccess).then((granted) => {
      showStatus(granted ? '' : 'Access to api.anthropic.com was not granted.');
      return renderApiAccess();
    }),
    'request access to api.anthropic.com',
  );
});

browser.permissions.onAdded.addListener(() => reportFailure(renderApiAccess(), 'check access to api.anthropic.com'));
browser.permissions.onRemoved.addListener(() => reportFailure(renderApiAccess(), 'check access to api.anthropic.com'));

browser.storage.local.onChanged.addListener((changes) => {
  if (SETTINGS_STORAGE_KEY in changes) reportFailure(renderSettings(), 'load the setting');
  if (CHAT_SETTINGS_STORAGE_KEY in changes) reportFailure(renderChatSettings(), 'load the chat settings');
  if (PERMISSION_STORAGE_KEY in changes) reportFailure(renderPermissions(), 'load the site permissions');
});

reportFailure(renderSettings(), 'load the setting');
reportFailure(renderChatSettings(), 'load the chat settings');
reportFailure(renderApiAccess(), 'check access to api.anthropic.com');
reportFailure(renderPermissions(), 'load the site permissions');
reportFailure(renderClaudeCodeStatus(), 'check Claude Code');
