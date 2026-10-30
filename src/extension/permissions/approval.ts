import { isRecord } from '../tools/navigation-input';
import type { PermissionAction } from './actions';
import { canHaveWildcard } from './site';

export interface ApprovalRequest {
  host: string;
  url: string;
  tool: string;
  action: PermissionAction;
}

export const APPROVAL_ANSWERS = ['allow_once', 'allow_always', 'deny', 'deny_always'] as const;
export type ApprovalAnswer = (typeof APPROVAL_ANSWERS)[number];

export type ApprovalDecision = { kind: 'answered'; answer: ApprovalAnswer; wildcard: boolean } | { kind: 'timeout' };

// Asks the user whether a tool may act on a host. Rejects only when the user could not be asked.
export interface ApprovalPrompt {
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
}

export const PROMPT_GET_MESSAGE = 'permission_prompt_get';
export const PROMPT_ANSWER_MESSAGE = 'permission_prompt_answer';

export interface PromptDetails {
  host: string;
  tool: string;
  action: PermissionAction;
  canIncludeSubdomains: boolean;
}

export function promptDetails(request: ApprovalRequest): PromptDetails {
  return {
    host: request.host,
    tool: request.tool,
    action: request.action,
    canIncludeSubdomains: canHaveWildcard(request.host),
  };
}

function isApprovalAnswer(value: unknown): value is ApprovalAnswer {
  return typeof value === 'string' && (APPROVAL_ANSWERS as readonly string[]).includes(value);
}

// The answer a prompt page sent; a wildcard only counts for an always answer on a host that can have one.
export function parseApprovalAnswer(value: unknown, host: string): ApprovalDecision | undefined {
  if (!isRecord(value) || !isApprovalAnswer(value.answer)) return undefined;
  const { answer } = value;
  const always = answer === 'allow_always' || answer === 'deny_always';
  const wildcard = always && value.includeSubdomains === true && canHaveWildcard(host);
  return { kind: 'answered', answer, wildcard };
}
