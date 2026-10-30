import { revokePermission } from '../permissions/permission-store';
import { isRecord } from '../tools/navigation-input';

export const OPTIONS_PAGE = 'options/options.html';
export const REVOKE_PERMISSION_MESSAGE = 'permission_revoke';

// The options page revokes through the background, whose store serializes every change to the records;
// a write from the page itself could race a grant or a check there and undo the revoke.
export function handleOptionsMessage(message: unknown, sender: browser.runtime.MessageSender): Promise<unknown> | undefined {
  if (!isRecord(message) || message.type !== REVOKE_PERMISSION_MESSAGE) return undefined;
  const fromOptionsPage = sender.id === browser.runtime.id && sender.url === browser.runtime.getURL(OPTIONS_PAGE);
  if (!fromOptionsPage || typeof message.id !== 'string') return Promise.resolve({ revoked: false });
  return revokePermission(message.id).then((revoked) => ({ revoked }));
}
