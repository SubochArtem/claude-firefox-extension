import { isRecord } from './tools/navigation-input';

export const SETTINGS_STORAGE_KEY = 'settings';

// container: agent tabs open in the dedicated Claude container; default: in the normal profile.
export type AgentTabs = 'container' | 'default';

export interface Settings {
  agentTabs: AgentTabs;
}

export const DEFAULT_SETTINGS: Settings = { agentTabs: 'container' };

function isAgentTabs(value: unknown): value is AgentTabs {
  return value === 'container' || value === 'default';
}

export function parseSettings(value: unknown): Settings {
  if (!isRecord(value) || !isAgentTabs(value.agentTabs)) return { ...DEFAULT_SETTINGS };
  return { agentTabs: value.agentTabs };
}

export async function loadSettings(): Promise<Settings> {
  const items = await browser.storage.local.get(SETTINGS_STORAGE_KEY);
  return parseSettings(items[SETTINGS_STORAGE_KEY]);
}

export async function saveSettings(settings: Settings): Promise<void> {
  if (!isRecord(settings) || !isAgentTabs(settings.agentTabs)) throw new Error('Invalid settings');
  await browser.storage.local.set({ [SETTINGS_STORAGE_KEY]: { agentTabs: settings.agentTabs } });
}
