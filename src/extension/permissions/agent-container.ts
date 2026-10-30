import { isRecord } from '../tools/navigation-input';
import { ToolError } from '../tools/tool-error';

export const AGENT_CONTAINER_NAME = 'Claude';
export const AGENT_CONTAINER_COLOR = 'orange';
export const AGENT_CONTAINER_ICON = 'circle';
export const AGENT_CONTAINER_STORAGE_KEY = 'agentContainer';

export function containerUnavailableMessage(detail: string): string {
  return (
    `Failed to create a tab: the "${AGENT_CONTAINER_NAME}" container for agent tabs is not available (${detail}). ` +
    'Ask the user to turn on "Enable container tabs" in Firefox settings (General, Tabs) or to switch agent tabs to ' +
    'the normal profile in the extension options (about:addons, Claude Firefox Extension, Options).'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function storedCookieStoreId(): Promise<string | undefined> {
  const items = await browser.storage.local.get(AGENT_CONTAINER_STORAGE_KEY);
  const value: unknown = items[AGENT_CONTAINER_STORAGE_KEY];
  if (!isRecord(value) || typeof value.cookieStoreId !== 'string' || value.cookieStoreId === '') return undefined;
  return value.cookieStoreId;
}

async function find(): Promise<string> {
  const api = browser.contextualIdentities as typeof browser.contextualIdentities | undefined;
  if (api === undefined) throw new ToolError(containerUnavailableMessage('the contextualIdentities API is not available'));

  const stored = await storedCookieStoreId();
  // A stored container is used while it exists, even if the user renamed it; get rejects once it is deleted.
  if (stored !== undefined && (await api.get(stored).then(() => true, () => false))) return stored;

  let cookieStoreId: string;
  try {
    const [existing] = await api.query({ name: AGENT_CONTAINER_NAME });
    cookieStoreId =
      existing?.cookieStoreId ??
      (await api.create({ name: AGENT_CONTAINER_NAME, color: AGENT_CONTAINER_COLOR, icon: AGENT_CONTAINER_ICON }))
        .cookieStoreId;
  } catch (error) {
    // Firefox rejects every contextualIdentities call while privacy.userContext.enabled is false.
    throw new ToolError(containerUnavailableMessage(errorMessage(error)));
  }
  await browser.storage.local.set({ [AGENT_CONTAINER_STORAGE_KEY]: { cookieStoreId } });
  return cookieStoreId;
}

let inFlight: Promise<string> | undefined;

// Concurrent callers share one resolution, so parallel tabs_create calls do not create two containers.
export function resolveAgentContainer(): Promise<string> {
  inFlight ??= find().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}
