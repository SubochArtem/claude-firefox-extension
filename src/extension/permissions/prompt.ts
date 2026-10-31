import type { PermissionAction } from './actions';
import { PROMPT_ANSWER_MESSAGE, PROMPT_GET_MESSAGE, type PromptDetails } from './approval';

const ACTION_LABELS: Record<PermissionAction, string> = {
  navigate: 'Open or close pages on this site',
  read_page_content: 'Read page content (screenshots, page structure)',
  click: 'Click on the page',
  type: 'Type into the page',
  execute_javascript: 'Run JavaScript on the page',
  read_console_messages: 'Read console messages',
  read_network_requests: 'Read network requests',
};

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`prompt page is missing #${id}`);
  return found as T;
}

function showStatus(text: string): void {
  element('request').hidden = true;
  element('status').textContent = text;
}

async function main(): Promise<void> {
  const id = new URLSearchParams(location.search).get('id') ?? '';
  const reply = (await browser.runtime.sendMessage({ type: PROMPT_GET_MESSAGE, id })) as
    | ({ pending: true } & PromptDetails)
    | { pending: false };
  if (!reply.pending) {
    showStatus('This permission request is no longer pending. You can close this window.');
    return;
  }

  element('host').textContent = reply.host;
  element('action').textContent = `${ACTION_LABELS[reply.action] ?? reply.action} (${reply.action})`;
  element('tool').textContent = reply.tool;
  element('subdomains-label').hidden = !reply.canIncludeSubdomains;
  element('request').hidden = false;

  const subdomains = element<HTMLInputElement>('subdomains');
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('button[data-answer]')];
  for (const button of buttons) {
    button.addEventListener('click', async () => {
      for (const other of buttons) other.disabled = true;
      const result = (await browser.runtime.sendMessage({
        type: PROMPT_ANSWER_MESSAGE,
        id,
        answer: button.dataset.answer,
        includeSubdomains: reply.canIncludeSubdomains && subdomains.checked,
      })) as { accepted: boolean };
      if (result.accepted) window.close();
      else showStatus('This permission request is no longer pending. You can close this window.');
    });
  }
}

main().catch((error: unknown) => {
  showStatus(`Could not load the permission request: ${error instanceof Error ? error.message : String(error)}`);
});
