import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalDecision, ApprovalPrompt, ApprovalRequest } from '../permissions/approval';
import type { PermissionRecord } from '../permissions/permission-model';
import { PERMISSION_STORAGE_KEY } from '../permissions/permission-store';
import { popupApprovalPrompt } from '../permissions/popup-prompt';
import {
  approvalPromptFor,
  blockedMessage,
  deniedMessage,
  landedSite,
  requireSiteAccess,
  type SiteAccessRequest,
  timeoutMessage,
} from '../permissions/site-access';
import { ToolError } from '../tools/tool-error';
import { mockBrowser } from './browser-mock';

const REQUEST: SiteAccessRequest = {
  url: 'https://www.example.com/page',
  tool: 'navigate',
  action: 'navigate',
  subject: 'Failed to navigate to https://www.example.com/page',
};

let browserMock: ReturnType<typeof mockBrowser>;

beforeEach(() => {
  browserMock = mockBrowser();
});

function stored(): PermissionRecord[] {
  return (browserMock.storage.local.data.get(PERMISSION_STORAGE_KEY) as PermissionRecord[] | undefined) ?? [];
}

function store(...records: Partial<PermissionRecord>[]) {
  browserMock.storage.local.data.set(
    PERMISSION_STORAGE_KEY,
    records.map((record, index) => ({
      id: `r${index}`,
      wildcard: false,
      decision: 'allow',
      duration: 'always',
      createdAt: 0,
      ...record,
    })),
  );
}

function answering(...decisions: ApprovalDecision[]) {
  const requests: ApprovalRequest[] = [];
  const prompt: ApprovalPrompt = {
    requestApproval: vi.fn(async (request: ApprovalRequest) => {
      requests.push(request);
      const decision = decisions.shift();
      if (!decision) throw new Error('unexpected prompt');
      return decision;
    }),
  };
  return { prompt, requests };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ToolError);
  return (error as Error).message;
}

describe('requireSiteAccess', () => {
  it('allows a host with a stored allow record without asking', async () => {
    store({ host: 'example.com' });
    const { prompt } = answering();
    expect(await requireSiteAccess(REQUEST, prompt)).toBe('example.com');
    expect(prompt.requestApproval).not.toHaveBeenCalled();
  });

  it('refuses a host with a stored deny record without asking', async () => {
    store({ host: 'example.com', wildcard: true, decision: 'deny' }, { host: 'example.com' });
    const { prompt } = answering();
    expect(await refusal(requireSiteAccess(REQUEST, prompt))).toBe(blockedMessage('example.com'));
    expect(blockedMessage('example.com')).toContain("blocked by the user's site settings");
    expect(prompt.requestApproval).not.toHaveBeenCalled();
  });

  it.each([
    ['about:blank', 'Unsupported URL scheme "about:"'],
    ['file:///etc/passwd', 'Unsupported URL scheme "file:"'],
    ['javascript:alert(1)', 'Unsupported URL scheme "javascript:"'],
    ['not a url', 'Invalid URL'],
  ])('refuses %j, which site permissions do not cover', async (url, reason) => {
    const { prompt } = answering();
    expect(await refusal(requireSiteAccess({ ...REQUEST, url, subject: 'Failed to navigate' }, prompt))).toBe(
      `Failed to navigate: ${reason}; site permissions only cover http and https pages`,
    );
    expect(prompt.requestApproval).not.toHaveBeenCalled();
  });

  it('asks with the host, url, tool and action', async () => {
    const { prompt, requests } = answering({ kind: 'answered', answer: 'allow_once', wildcard: false });
    await requireSiteAccess({ ...REQUEST, tool: 'computer', action: 'read_page_content' }, prompt);
    expect(requests).toEqual([
      { host: 'example.com', url: REQUEST.url, tool: 'computer', action: 'read_page_content' },
    ]);
  });

  it('lets the call proceed on allow once without storing anything', async () => {
    const { prompt } = answering({ kind: 'answered', answer: 'allow_once', wildcard: false });
    expect(await requireSiteAccess(REQUEST, prompt)).toBe('example.com');
    expect(stored()).toEqual([]);
  });

  it('stores an allow record on always allow and does not ask again', async () => {
    const { prompt } = answering({ kind: 'answered', answer: 'allow_always', wildcard: true });
    expect(await requireSiteAccess(REQUEST, prompt)).toBe('example.com');
    expect(stored()).toEqual([
      expect.objectContaining({ host: 'example.com', wildcard: true, decision: 'allow', duration: 'always' }),
    ]);
    expect(await requireSiteAccess({ ...REQUEST, url: 'https://docs.example.com/' }, prompt)).toBe('docs.example.com');
    expect(prompt.requestApproval).toHaveBeenCalledTimes(1);
  });

  it('refuses on deny without storing anything', async () => {
    const { prompt } = answering({ kind: 'answered', answer: 'deny', wildcard: false });
    const message = await refusal(requireSiteAccess(REQUEST, prompt));
    expect(message).toBe(deniedMessage('example.com'));
    expect(message).toBe(
      'The user denied access to example.com. Do not look for workarounds or other ways to reach this site; ask the user how to proceed.',
    );
    expect(stored()).toEqual([]);
  });

  it('stores a deny record on always deny and refuses later calls as blocked', async () => {
    const { prompt } = answering({ kind: 'answered', answer: 'deny_always', wildcard: false });
    expect(await refusal(requireSiteAccess(REQUEST, prompt))).toBe(deniedMessage('example.com'));
    expect(stored()).toEqual([
      expect.objectContaining({ host: 'example.com', wildcard: false, decision: 'deny', duration: 'always' }),
    ]);
    expect(await refusal(requireSiteAccess(REQUEST, prompt))).toBe(blockedMessage('example.com'));
  });

  it('refuses with a distinct message when the prompt times out', async () => {
    const { prompt } = answering({ kind: 'timeout' });
    const message = await refusal(requireSiteAccess(REQUEST, prompt));
    expect(message).toBe(timeoutMessage('example.com'));
    expect(message).toContain('within 120 s');
    expect(message).toContain('answer the prompt window in Firefox');
  });

  it('passes on a prompt that could not be shown', async () => {
    const failing: ApprovalPrompt = { requestApproval: async () => Promise.reject(new ToolError('no window')) };
    expect(await refusal(requireSiteAccess(REQUEST, failing))).toBe('no window');
  });

  it('shows one prompt at a time and checks again before the next one', async () => {
    let answer: (decision: ApprovalDecision) => void = () => {};
    const prompt: ApprovalPrompt = {
      requestApproval: vi.fn(() => new Promise<ApprovalDecision>((resolve) => (answer = resolve))),
    };
    const first = requireSiteAccess(REQUEST, prompt);
    const second = requireSiteAccess({ ...REQUEST, url: 'https://example.com/other' }, prompt);
    await vi.waitFor(() => expect(prompt.requestApproval).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prompt.requestApproval).toHaveBeenCalledTimes(1);
    answer({ kind: 'answered', answer: 'allow_always', wildcard: false });
    expect(await first).toBe('example.com');
    expect(await second).toBe('example.com');
    expect(prompt.requestApproval).toHaveBeenCalledTimes(1);
  });

  it('asks again for the next queued site after an answer that covers only the first', async () => {
    const { prompt, requests } = answering(
      { kind: 'answered', answer: 'deny', wildcard: false },
      { kind: 'answered', answer: 'allow_once', wildcard: false },
    );
    const first = refusal(requireSiteAccess(REQUEST, prompt));
    const second = requireSiteAccess({ ...REQUEST, url: 'https://other.example/' }, prompt);
    expect(await first).toBe(deniedMessage('example.com'));
    expect(await second).toBe('other.example');
    expect(requests.map((request) => request.host)).toEqual(['example.com', 'other.example']);
  });
});

describe('landedSite', () => {
  it('accepts the host approved for this call without a stored record', async () => {
    expect(await landedSite('https://www.example.com/after', 'example.com')).toEqual({ allowed: true });
  });

  it('accepts a host with a stored allow record', async () => {
    store({ host: 'other.example' });
    expect(await landedSite('https://other.example/', 'example.com')).toEqual({ allowed: true });
  });

  it('reports a host the user has not approved without asking', async () => {
    expect(await landedSite('https://evil.example/', 'example.com')).toEqual({ allowed: false, host: 'evil.example' });
    expect(browserMock.windows.create).not.toHaveBeenCalled();
  });

  it('reports a denied host as not allowed', async () => {
    store({ host: 'evil.example', decision: 'deny' });
    expect(await landedSite('https://evil.example/')).toEqual({ allowed: false, host: 'evil.example' });
  });

  it.each(['about:blank', undefined])('reports %j as outside site permissions', async (url) => {
    expect(await landedSite(url, 'example.com')).toEqual({ allowed: false, host: undefined });
  });
});

describe('approvalPromptFor', () => {
  const clientPrompt: ApprovalPrompt = { requestApproval: vi.fn() };

  it('asks through the MCP client only when the call is flagged for it', () => {
    expect(approvalPromptFor({ viaClient: true, clientPrompt })).toBe(clientPrompt);
  });

  it('uses the popup otherwise', () => {
    expect(approvalPromptFor({ viaClient: false, clientPrompt })).toBe(popupApprovalPrompt);
    expect(approvalPromptFor(undefined)).toBe(popupApprovalPrompt);
  });
});
