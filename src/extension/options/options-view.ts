import type { ClaudeCodeStatusReply } from '../chat/claude-code-relay';
import type { PermissionRecord } from '../permissions/permission-model';

export interface PermissionRow {
  id: string;
  site: string;
  decision: string;
  duration: string;
  created: string;
  lastUsed: string;
}

export function permissionRows(records: PermissionRecord[], formatTime: (ms: number) => string): PermissionRow[] {
  return [...records]
    .sort((a, b) => (a.host === b.host ? a.createdAt - b.createdAt : a.host < b.host ? -1 : 1))
    .map((record) => ({
      id: record.id,
      site: record.wildcard ? `*.${record.host}` : record.host,
      decision: record.decision === 'allow' ? 'Allow' : 'Deny',
      duration: record.duration === 'once' ? 'Once' : 'Always',
      created: formatTime(record.createdAt),
      lastUsed: record.lastUsed === undefined ? 'Never' : formatTime(record.lastUsed),
    }));
}

const MIN_KEY_LENGTH_FOR_SUFFIX = 12;

export function apiKeyStatus(apiKey: string): string {
  if (apiKey === '') return 'No API key is saved.';
  if (apiKey.length < MIN_KEY_LENGTH_FOR_SUFFIX) return 'An API key is saved.';
  return `An API key ending in ${apiKey.slice(-4)} is saved.`;
}

export function claudeCodeStatusText(reply: ClaudeCodeStatusReply): string {
  if (!reply.hostConnected) return 'Claude Code: the native host is not connected.';
  const { status } = reply;
  if (status === undefined) return 'Claude Code: the native host did not report a status. Update the native host.';
  if (!status.found) return `Claude Code was not found. ${status.error ?? ''}`.trim();
  const where = `Claude Code${status.version === undefined ? '' : ` ${status.version}`} at ${status.path ?? 'an unknown path'}`;
  if (status.error !== undefined) return `${where} could not be checked: ${status.error}`;
  if (status.versionOk !== true) return `${where} is too old or its version could not be read; 2.1.302 or newer is required.`;
  if (status.ready) return `${where}, logged in with a Claude subscription (claude.ai).`;
  if (status.loggedIn !== true) return `${where} is not logged in. Run "claude auth login" in a terminal.`;
  return `${where} is logged in with ${status.authMethod ?? 'an unknown method'}, not a Claude subscription; the sidebar uses only a claude.ai login.`;
}
