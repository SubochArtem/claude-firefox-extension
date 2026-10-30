import { loadPermissions, PERMISSION_STORAGE_KEY } from '../permissions/permission-store';
import { type AgentTabs, loadSettings, saveSettings, SETTINGS_STORAGE_KEY } from '../settings';
import { REVOKE_PERMISSION_MESSAGE } from './options-messages';
import { permissionRows } from './options-view';

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

browser.storage.local.onChanged.addListener((changes) => {
  if (SETTINGS_STORAGE_KEY in changes) reportFailure(renderSettings(), 'load the setting');
  if (PERMISSION_STORAGE_KEY in changes) reportFailure(renderPermissions(), 'load the site permissions');
});

reportFailure(renderSettings(), 'load the setting');
reportFailure(renderPermissions(), 'load the site permissions');
