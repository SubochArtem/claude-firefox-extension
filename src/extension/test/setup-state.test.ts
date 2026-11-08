import { describe, expect, it } from 'vitest';
import { CHAT_SETTINGS_STORAGE_KEY } from '../chat-settings';
import { affectsSetup, setupState } from '../sidebar/setup-state';

describe('sidebar setup state', () => {
  it('asks for an API key first', () => {
    expect(setupState('', false)).toEqual({ kind: 'needs_key', text: expect.stringContaining('No Anthropic API key is saved') });
    expect(setupState('', true).kind).toBe('needs_key');
  });

  it('asks for access to the Anthropic API when a key is saved', () => {
    expect(setupState('sk-ant-123', false)).toEqual({ kind: 'needs_access', text: expect.stringContaining('api.anthropic.com') });
  });

  it('is ready with a key and access', () => {
    expect(setupState('sk-ant-123', true)).toEqual({ kind: 'ready' });
  });

  it('reacts only to changes of the chat settings', () => {
    expect(affectsSetup({ [CHAT_SETTINGS_STORAGE_KEY]: { newValue: {} } })).toBe(true);
    expect(affectsSetup({ settings: { newValue: {} } })).toBe(false);
  });
});
