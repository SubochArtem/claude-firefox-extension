import { ToolError } from '../tools/tool-error';
import type { PermissionAction } from './actions';
import type { ApprovalPrompt } from './approval';
import { addPermission, checkSitePermission } from './permission-store';
import { PROMPT_TIMEOUT_MS, popupApprovalPrompt } from './popup-prompt';
import { siteForUrl } from './site';

export interface SiteAccessRequest {
  url: string;
  tool: string;
  action: PermissionAction;
  // Opens the refusal of a URL outside site permissions, e.g. "Failed to navigate to <url>".
  subject: string;
}

export function blockedMessage(host: string): string {
  return `Access to ${host} is blocked by the user's site settings in the Claude Firefox Extension. Do not try to reach this site another way; ask the user if it is needed.`;
}

export function deniedMessage(host: string): string {
  return `The user denied access to ${host}. Do not look for workarounds or other ways to reach this site; ask the user how to proceed.`;
}

export function timeoutMessage(host: string): string {
  return `The user did not answer the permission prompt for ${host} within ${PROMPT_TIMEOUT_MS / 1000} s. Ask the user to answer the prompt window in Firefox, then try again.`;
}

let promptQueue: Promise<unknown> = Promise.resolve();

// One prompt at a time; a queued request checks the stored records again once it is its turn, so an
// "always" answer to an earlier prompt also settles later requests for the same site.
function serializedPrompt<T>(task: () => Promise<T>): Promise<T> {
  const result = promptQueue.then(task);
  promptQueue = result.catch(() => {});
  return result;
}

async function checkOrPrompt(request: SiteAccessRequest, prompt: ApprovalPrompt, retry: boolean): Promise<string> {
  const outcome = await checkSitePermission(request.url);
  switch (outcome.kind) {
    case 'unsupported':
      throw new ToolError(`${request.subject}: ${outcome.reason}`);
    case 'denied':
      throw new ToolError(blockedMessage(outcome.host));
    case 'allowed':
      return outcome.host;
    case 'prompt':
      if (retry) return serializedPrompt(() => checkOrPrompt(request, prompt, false));
      return askUser(request, outcome.host, prompt);
  }
}

async function askUser(request: SiteAccessRequest, host: string, prompt: ApprovalPrompt): Promise<string> {
  const decision = await prompt.requestApproval({ host, url: request.url, tool: request.tool, action: request.action });
  if (decision.kind === 'timeout') throw new ToolError(timeoutMessage(host));
  const { answer, wildcard } = decision;
  if (answer === 'allow_always' || answer === 'deny_always') {
    await addPermission({ host, wildcard, decision: answer === 'allow_always' ? 'allow' : 'deny', duration: 'always' });
  }
  if (answer === 'deny' || answer === 'deny_always') throw new ToolError(deniedMessage(host));
  return host;
}

// Resolves with the host the tool may act on, asking the user when no stored decision covers it.
export function requireSiteAccess(request: SiteAccessRequest, prompt: ApprovalPrompt = popupApprovalPrompt): Promise<string> {
  return checkOrPrompt(request, prompt, true);
}

// host is undefined when the navigation ended outside http and https.
export type LandedSite = { allowed: true } | { allowed: false; host: string | undefined };

// Checks where a navigation ended without asking: the host approved for this call or a stored allow.
export async function landedSite(url: string | undefined, approvedHost?: string): Promise<LandedSite> {
  const site = siteForUrl(url ?? '');
  if (!site.ok) return { allowed: false, host: undefined };
  if (site.host === approvedHost) return { allowed: true };
  const outcome = await checkSitePermission(url ?? '');
  return outcome.kind === 'allowed' ? { allowed: true } : { allowed: false, host: site.host };
}
