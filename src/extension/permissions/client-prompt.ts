import type { PermissionRequest, PermissionResponse } from '../protocol';
import { type ApprovalDecision, type ApprovalPrompt, parseApprovalAnswer, promptDetails } from './approval';
import { PROMPT_TIMEOUT_MS } from './popup-prompt';

const DENY: ApprovalDecision = { kind: 'answered', answer: 'deny', wildcard: false };

// Approval prompts answered in the MCP client over one native port. A timeout reports the same
// result as the popup; a closed port, a failed send or a malformed answer is a deny.
export interface ClientApprovals {
  promptFor(callId: string): ApprovalPrompt;
  handleResponse(response: PermissionResponse): void;
  close(): void;
}

export function createClientApprovals(send: (message: PermissionRequest) => void): ClientApprovals {
  const pending = new Map<string, { host: string; finish: (decision: ApprovalDecision) => void }>();
  let closed = false;

  const promptFor = (callId: string): ApprovalPrompt => ({
    requestApproval: (request) =>
      new Promise((resolve) => {
        if (closed) {
          resolve(DENY);
          return;
        }
        const requestId = crypto.randomUUID();
        const finish = (decision: ApprovalDecision) => {
          clearTimeout(timer);
          pending.delete(requestId);
          resolve(decision);
        };
        const timer = setTimeout(() => finish({ kind: 'timeout' }), PROMPT_TIMEOUT_MS);
        pending.set(requestId, { host: request.host, finish });
        try {
          send({ type: 'permission_request', requestId, callId, ...promptDetails(request) });
        } catch {
          finish(DENY);
        }
      }),
  });

  return {
    promptFor,
    handleResponse(response) {
      const entry = pending.get(response.requestId);
      entry?.finish(parseApprovalAnswer(response, entry.host) ?? DENY);
    },
    close() {
      closed = true;
      for (const { finish } of [...pending.values()]) finish(DENY);
    },
  };
}
