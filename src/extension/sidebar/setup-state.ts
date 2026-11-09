import { CHAT_SETTINGS_STORAGE_KEY } from '../chat-settings';
import type { ClaudeCodeStatusReply } from '../chat/claude-code-relay';

export type SetupState = { kind: 'ready' } | { kind: 'needs_key' | 'needs_access' | 'checking' | 'needs_claude_code'; text: string };

export const CHECKING_CLAUDE_CODE: SetupState = { kind: 'checking', text: 'Checking Claude Code...' };

export function setupState(apiKey: string, apiAccessGranted: boolean): SetupState {
  if (apiKey === '') {
    return { kind: 'needs_key', text: 'No Anthropic API key is saved. Add your key in the options page to start chatting.' };
  }
  if (!apiAccessGranted) {
    return { kind: 'needs_access', text: 'The chat needs access to api.anthropic.com to talk to Claude.' };
  }
  return { kind: 'ready' };
}

function needsClaudeCode(text: string): SetupState {
  return { kind: 'needs_claude_code', text };
}

export function claudeCodeSetupState(reply: ClaudeCodeStatusReply): SetupState {
  if (!reply.hostConnected) {
    return needsClaudeCode('The native host is not connected. Install it with "claude-firefox-host install" and restart Firefox.');
  }
  const { status } = reply;
  if (status === undefined) return needsClaudeCode('The native host did not report the Claude Code status. Update the native host.');
  if (!status.found) {
    return needsClaudeCode(
      `Claude Code was not found. Install it, or set CLAUDE_FIREFOX_CLAUDE_PATH in the environment Firefox starts with. ${status.error ?? ''}`.trim(),
    );
  }
  if (status.error !== undefined) return needsClaudeCode(`Claude Code could not be checked: ${status.error}`);
  if (status.versionOk !== true) {
    const version = status.version === undefined ? '' : ` ${status.version}`;
    return needsClaudeCode(`Claude Code${version} is too old or its version could not be read; 2.1.302 or newer is required.`);
  }
  if (status.ready) return { kind: 'ready' };
  if (status.loggedIn !== true) {
    return needsClaudeCode('Claude Code is not logged in. Run "claude" in a terminal and log in, or run "claude auth login".');
  }
  return needsClaudeCode(
    `Claude Code is logged in with ${status.authMethod ?? 'an unknown method'}, not a Claude subscription. Run "claude auth login" and log in with your Claude account.`,
  );
}

export function affectsSetup(changes: Record<string, unknown>): boolean {
  return CHAT_SETTINGS_STORAGE_KEY in changes;
}
