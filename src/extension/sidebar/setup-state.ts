import { CHAT_SETTINGS_STORAGE_KEY } from '../chat-settings';

export type SetupState = { kind: 'ready' } | { kind: 'needs_key' | 'needs_access'; text: string };

export function setupState(apiKey: string, apiAccessGranted: boolean): SetupState {
  if (apiKey === '') {
    return { kind: 'needs_key', text: 'No Anthropic API key is saved. Add your key in the options page to start chatting.' };
  }
  if (!apiAccessGranted) {
    return { kind: 'needs_access', text: 'The chat needs access to api.anthropic.com to talk to Claude.' };
  }
  return { kind: 'ready' };
}

export function affectsSetup(changes: Record<string, unknown>): boolean {
  return CHAT_SETTINGS_STORAGE_KEY in changes;
}
