import type { ClaudeCodeStatusReply } from '../chat/claude-code-relay';
import { revokePermission } from '../permissions/permission-store';
import { isRecord } from '../tools/navigation-input';

export const OPTIONS_PAGE = 'options/options.html';
export const REVOKE_PERMISSION_MESSAGE = 'permission_revoke';
export const CLAUDE_CODE_STATUS_MESSAGE = 'claude_code_status';

function isFromOptionsPage(sender: browser.runtime.MessageSender): boolean {
  return sender.id === browser.runtime.id && sender.url === browser.runtime.getURL(OPTIONS_PAGE);
}

// The options page revokes through the background, whose store serializes every change to the records;
// a write from the page itself could race a grant or a check there and undo the revoke.
export function handleOptionsMessage(message: unknown, sender: browser.runtime.MessageSender): Promise<unknown> | undefined {
  if (!isRecord(message) || message.type !== REVOKE_PERMISSION_MESSAGE) return undefined;
  if (!isFromOptionsPage(sender) || typeof message.id !== 'string') return Promise.resolve({ revoked: false });
  return revokePermission(message.id).then((revoked) => ({ revoked }));
}

// The options page shows whether Claude Code can run sidebar sessions; the background asks the host.
export function createClaudeCodeStatusHandler(status: () => Promise<ClaudeCodeStatusReply>) {
  return (message: unknown, sender: browser.runtime.MessageSender): Promise<ClaudeCodeStatusReply> | undefined => {
    if (!isRecord(message) || message.type !== CLAUDE_CODE_STATUS_MESSAGE) return undefined;
    if (!isFromOptionsPage(sender)) return Promise.reject(new Error('The Claude Code status is given only to the options page'));
    return status();
  };
}
