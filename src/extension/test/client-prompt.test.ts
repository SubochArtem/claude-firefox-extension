import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPROVAL_ANSWERS, type ApprovalDecision, type ApprovalRequest } from '../permissions/approval';
import { createClientApprovals } from '../permissions/client-prompt';
import { PROMPT_TIMEOUT_MS } from '../permissions/popup-prompt';
import type { PermissionRequest } from '../protocol';
import { PERMISSION_ANSWERS, PERMISSION_PROMPT_TIMEOUT_MS } from '../../host/protocol';

const REQUEST: ApprovalRequest = { host: 'example.com', url: 'https://example.com/', tool: 'navigate', action: 'navigate' };
const DENY: ApprovalDecision = { kind: 'answered', answer: 'deny', wildcard: false };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T } = { settled: false };
  void promise.then((value) => {
    state.settled = true;
    state.value = value;
  });
  return state;
}

function setup() {
  const sent: PermissionRequest[] = [];
  const approvals = createClientApprovals((message) => {
    sent.push(message);
  });
  const ask = (request: ApprovalRequest = REQUEST, callId = '3:1') => {
    const state = track(approvals.promptFor(callId).requestApproval(request));
    const message = sent.at(-1);
    if (!message) throw new Error('no permission request was sent');
    return { state, requestId: message.requestId };
  };
  const answer = (requestId: string, answer: unknown, includeSubdomains: unknown = false) =>
    approvals.handleResponse({ type: 'permission_response', requestId, answer, includeSubdomains });
  return { approvals, sent, ask, answer };
}

describe('client approval prompt', () => {
  it('sends a permission request with a fresh id, the call id and the prompt details', () => {
    const { sent, ask, approvals } = setup();
    const first = ask(REQUEST, '3:1');
    const second = ask({ ...REQUEST, host: 'localhost', tool: 'computer', action: 'read_page_content' }, '3:2');
    expect(sent).toEqual([
      {
        type: 'permission_request',
        requestId: first.requestId,
        callId: '3:1',
        host: 'example.com',
        tool: 'navigate',
        action: 'navigate',
        canIncludeSubdomains: true,
      },
      {
        type: 'permission_request',
        requestId: second.requestId,
        callId: '3:2',
        host: 'localhost',
        tool: 'computer',
        action: 'read_page_content',
        canIncludeSubdomains: false,
      },
    ]);
    expect(first.requestId).not.toBe(second.requestId);
    approvals.close();
  });

  it('resolves with the parsed answer of the matching response', async () => {
    const { ask, answer } = setup();
    const { state, requestId } = ask();
    answer('another-request', 'allow_once');
    await vi.advanceTimersByTimeAsync(0);
    expect(state.settled).toBe(false);
    answer(requestId, 'allow_always', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.value).toEqual({ kind: 'answered', answer: 'allow_always', wildcard: true });
  });

  it('drops the subdomain choice for a host that cannot have a wildcard', async () => {
    const { ask, answer } = setup();
    const { state, requestId } = ask({ ...REQUEST, host: 'localhost' });
    answer(requestId, 'deny_always', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.value).toEqual({ kind: 'answered', answer: 'deny_always', wildcard: false });
  });

  it.each([['maybe'], [undefined], [42], [{ answer: 'allow_once' }]])('denies on the invalid answer %j', async (invalid) => {
    const { ask, answer } = setup();
    const { state, requestId } = ask();
    answer(requestId, invalid, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.value).toEqual(DENY);
  });

  it('ignores a second answer to the same request', async () => {
    const { ask, answer } = setup();
    const { state, requestId } = ask();
    answer(requestId, 'deny');
    answer(requestId, 'allow_always');
    await vi.advanceTimersByTimeAsync(0);
    expect(state.value).toEqual(DENY);
  });

  it('times out after 120 s without an answer like the popup and drops the late answer', async () => {
    const { ask, answer } = setup();
    const { state, requestId } = ask();
    await vi.advanceTimersByTimeAsync(PROMPT_TIMEOUT_MS - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.value).toEqual({ kind: 'timeout' });
    answer(requestId, 'allow_always');
    await vi.advanceTimersByTimeAsync(0);
    expect(state.value).toEqual({ kind: 'timeout' });
  });

  it('denies every pending request when closed and every later one without sending it', async () => {
    const { ask, approvals, sent } = setup();
    const first = ask();
    const second = ask();
    approvals.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.state.value).toEqual(DENY);
    expect(second.state.value).toEqual(DENY);

    const later = track(approvals.promptFor('3:9').requestApproval(REQUEST));
    await vi.advanceTimersByTimeAsync(0);
    expect(later.value).toEqual(DENY);
    expect(sent).toHaveLength(2);
  });

  it('denies when the request cannot be sent', async () => {
    const approvals = createClientApprovals(() => {
      throw new Error('Attempt to postMessage on disconnected port');
    });
    const state = track(approvals.promptFor('3:1').requestApproval(REQUEST));
    await vi.advanceTimersByTimeAsync(0);
    expect(state.value).toEqual(DENY);
  });

  it('shares the prompt timeout and the answers with the host', () => {
    expect(PERMISSION_PROMPT_TIMEOUT_MS).toBe(PROMPT_TIMEOUT_MS);
    expect([...PERMISSION_ANSWERS]).toEqual([...APPROVAL_ANSWERS]);
  });
});
