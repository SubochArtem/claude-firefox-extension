import { describe, expect, it } from 'vitest';
import { CHAT_SETTINGS_STORAGE_KEY } from '../chat-settings';
import { affectsSetup, claudeCodeSetupState, setupState } from '../sidebar/setup-state';

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

describe('sidebar setup state for Claude Code', () => {
  const found = { found: true, path: '/usr/bin/claude', version: '2.1.316', versionOk: true };

  it('is ready when the host reports a session can start, without a key or API access', () => {
    expect(claudeCodeSetupState({ hostConnected: true, status: { ...found, loggedIn: true, authMethod: 'claude.ai', ready: true } })).toEqual({
      kind: 'ready',
    });
  });

  it.each([
    [{ hostConnected: false as const }, 'native host is not connected'],
    [{ hostConnected: true as const }, 'did not report the Claude Code status'],
    [{ hostConnected: true as const, status: { found: false, ready: false } }, 'Claude Code was not found'],
    [{ hostConnected: true as const, status: { ...found, error: 'timed out', ready: false } }, 'could not be checked: timed out'],
    [{ hostConnected: true as const, status: { ...found, version: '2.0.1', versionOk: false, ready: false } }, 'Claude Code 2.0.1 is too old'],
    [{ hostConnected: true as const, status: { ...found, loggedIn: false, ready: false } }, 'Run "claude" in a terminal and log in, or run "claude auth login"'],
    [{ hostConnected: true as const, status: { ...found, loggedIn: true, authMethod: 'api_key', ready: false } }, 'logged in with api_key, not a Claude subscription'],
  ])('explains %o', (reply, text) => {
    expect(claudeCodeSetupState(reply)).toEqual({ kind: 'needs_claude_code', text: expect.stringContaining(text) });
  });
});
