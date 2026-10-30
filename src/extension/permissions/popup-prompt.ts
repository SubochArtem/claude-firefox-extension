import { isRecord } from '../tools/navigation-input';
import { ToolError } from '../tools/tool-error';
import {
  type ApprovalDecision,
  type ApprovalPrompt,
  type ApprovalRequest,
  PROMPT_ANSWER_MESSAGE,
  PROMPT_GET_MESSAGE,
  parseApprovalAnswer,
  promptDetails,
} from './approval';

export const PROMPT_TIMEOUT_MS = 120_000;
export const PROMPT_PAGE = 'permissions/prompt.html';
export const PROMPT_WIDTH = 480;
export const PROMPT_HEIGHT = 420;

const CLOSED: ApprovalDecision = { kind: 'answered', answer: 'deny', wildcard: false };

interface PendingPrompt {
  request: ApprovalRequest;
  pageUrl: string;
  answer: (decision: ApprovalDecision) => void;
}

const pending = new Map<string, PendingPrompt>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const pageUrl = browser.runtime.getURL(`${PROMPT_PAGE}?id=${id}`);
    let settled = false;
    let windowId: number | undefined;

    const onRemoved = (removedWindowId: number) => {
      if (removedWindowId === windowId) finish(CLOSED, false);
    };
    const timer = setTimeout(() => finish({ kind: 'timeout' }, true), PROMPT_TIMEOUT_MS);

    function cleanup() {
      settled = true;
      clearTimeout(timer);
      pending.delete(id);
      browser.windows.onRemoved.removeListener(onRemoved);
    }

    function finish(decision: ApprovalDecision, closeWindow: boolean) {
      if (settled) return;
      cleanup();
      if (closeWindow && windowId !== undefined) browser.windows.remove(windowId).catch(() => {});
      resolve(decision);
    }

    function fail(detail: string) {
      if (settled) return;
      cleanup();
      reject(
        new ToolError(`Could not ask the user for permission to access ${request.host}: the prompt window failed to open: ${detail}`),
      );
    }

    pending.set(id, { request, pageUrl, answer: (decision) => finish(decision, true) });
    browser.windows.onRemoved.addListener(onRemoved);
    browser.windows
      .create({ type: 'popup', url: pageUrl, width: PROMPT_WIDTH, height: PROMPT_HEIGHT, focused: true })
      .then(
        (window) => {
          if (settled) {
            if (window.id !== undefined) browser.windows.remove(window.id).catch(() => {});
            return;
          }
          if (window.id === undefined) fail('the window has no id');
          else windowId = window.id;
        },
        (error: unknown) => fail(errorMessage(error)),
      );
  });
}

export const popupApprovalPrompt: ApprovalPrompt = { requestApproval };

// Only the prompt page opened for a pending request, identified by its exact url, may read or answer it.
function pendingFor(message: Record<string, unknown>, sender: browser.runtime.MessageSender): PendingPrompt | undefined {
  if (typeof message.id !== 'string' || sender.id !== browser.runtime.id) return undefined;
  const prompt = pending.get(message.id);
  return prompt !== undefined && sender.url === prompt.pageUrl ? prompt : undefined;
}

export function handlePromptMessage(message: unknown, sender: browser.runtime.MessageSender): Promise<unknown> | undefined {
  if (!isRecord(message)) return undefined;
  if (message.type === PROMPT_GET_MESSAGE) {
    const prompt = pendingFor(message, sender);
    return Promise.resolve(prompt === undefined ? { pending: false } : { pending: true, ...promptDetails(prompt.request) });
  }
  if (message.type === PROMPT_ANSWER_MESSAGE) {
    const prompt = pendingFor(message, sender);
    const decision = prompt === undefined ? undefined : parseApprovalAnswer(message, prompt.request.host);
    if (prompt === undefined || decision === undefined) return Promise.resolve({ accepted: false });
    prompt.answer(decision);
    return Promise.resolve({ accepted: true });
  }
  return undefined;
}
