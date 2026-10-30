import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_CONTAINER_COLOR,
  AGENT_CONTAINER_ICON,
  AGENT_CONTAINER_NAME,
  AGENT_CONTAINER_STORAGE_KEY,
  containerUnavailableMessage,
  resolveAgentContainer,
} from '../permissions/agent-container';
import { ToolError } from '../tools/tool-error';
import { mockBrowser } from './browser-mock';

let browserMock: ReturnType<typeof mockBrowser>;

function addIdentity(cookieStoreId: string, name: string) {
  browserMock.contextualIdentities.identities.set(cookieStoreId, {
    cookieStoreId,
    name,
    color: 'blue',
    icon: 'circle',
    iconUrl: '',
    colorCode: '',
  });
}

function storedId(): unknown {
  return browserMock.storage.local.data.get(AGENT_CONTAINER_STORAGE_KEY);
}

beforeEach(() => {
  browserMock = mockBrowser();
});

describe('agent container', () => {
  it('creates the Claude container when there is none and remembers its cookieStoreId', async () => {
    expect(await resolveAgentContainer()).toBe('firefox-container-1');
    expect(browserMock.contextualIdentities.create).toHaveBeenCalledWith({
      name: AGENT_CONTAINER_NAME,
      color: AGENT_CONTAINER_COLOR,
      icon: AGENT_CONTAINER_ICON,
    });
    expect(AGENT_CONTAINER_NAME).toBe('Claude');
    expect(storedId()).toEqual({ cookieStoreId: 'firefox-container-1' });
  });

  it('reuses the stored container while it exists, even if the user renamed it', async () => {
    addIdentity('firefox-container-7', 'Renamed');
    addIdentity('firefox-container-8', 'Claude');
    browserMock.storage.local.data.set(AGENT_CONTAINER_STORAGE_KEY, { cookieStoreId: 'firefox-container-7' });
    expect(await resolveAgentContainer()).toBe('firefox-container-7');
    expect(browserMock.contextualIdentities.get).toHaveBeenCalledWith('firefox-container-7');
    expect(browserMock.contextualIdentities.query).not.toHaveBeenCalled();
    expect(browserMock.contextualIdentities.create).not.toHaveBeenCalled();
  });

  it('adopts an existing container named Claude when nothing is stored', async () => {
    addIdentity('firefox-container-4', 'Personal');
    addIdentity('firefox-container-5', 'Claude');
    expect(await resolveAgentContainer()).toBe('firefox-container-5');
    expect(browserMock.contextualIdentities.query).toHaveBeenCalledWith({ name: 'Claude' });
    expect(browserMock.contextualIdentities.create).not.toHaveBeenCalled();
    expect(storedId()).toEqual({ cookieStoreId: 'firefox-container-5' });
  });

  it('creates a new container when the stored one was deleted', async () => {
    browserMock.storage.local.data.set(AGENT_CONTAINER_STORAGE_KEY, { cookieStoreId: 'firefox-container-9' });
    expect(await resolveAgentContainer()).toBe('firefox-container-1');
    expect(browserMock.contextualIdentities.create).toHaveBeenCalledTimes(1);
    expect(storedId()).toEqual({ cookieStoreId: 'firefox-container-1' });
  });

  it.each([null, 'firefox-container-3', { cookieStoreId: '' }, { cookieStoreId: 3 }])(
    'ignores malformed stored data %o',
    async (value) => {
      browserMock.storage.local.data.set(AGENT_CONTAINER_STORAGE_KEY, value);
      expect(await resolveAgentContainer()).toBe('firefox-container-1');
      expect(browserMock.contextualIdentities.get).not.toHaveBeenCalled();
    },
  );

  it('creates one container for concurrent resolutions', async () => {
    const results = await Promise.all([resolveAgentContainer(), resolveAgentContainer(), resolveAgentContainer()]);
    expect(results).toEqual(['firefox-container-1', 'firefox-container-1', 'firefox-container-1']);
    expect(browserMock.contextualIdentities.create).toHaveBeenCalledTimes(1);
    expect(await resolveAgentContainer()).toBe('firefox-container-1');
    expect(browserMock.contextualIdentities.create).toHaveBeenCalledTimes(1);
  });

  it('tries again after a failed resolution', async () => {
    browserMock.contextualIdentities.query.mockRejectedValueOnce(new Error('Contextual identities are currently disabled'));
    await expect(resolveAgentContainer()).rejects.toBeInstanceOf(ToolError);
    expect(await resolveAgentContainer()).toBe('firefox-container-1');
  });

  it('fails with a ToolError when the contextualIdentities API is missing', async () => {
    vi.stubGlobal('browser', { ...browser, contextualIdentities: undefined });
    const error = await resolveAgentContainer().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as Error).message).toBe(containerUnavailableMessage('the contextualIdentities API is not available'));
  });

  it.each<[string, () => void]>([
    ['query', () => browserMock.contextualIdentities.query.mockRejectedValue(new Error('Contextual identities are currently disabled'))],
    ['create', () => browserMock.contextualIdentities.create.mockRejectedValue(new Error('Contextual identities are currently disabled'))],
  ])('fails with a ToolError when containers are disabled (%s rejects)', async (_label, setup) => {
    setup();
    const error = await resolveAgentContainer().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as Error).message).toBe(containerUnavailableMessage('Contextual identities are currently disabled'));
    expect(storedId()).toBeUndefined();
  });

  it('names both ways out in the error message', () => {
    const message = containerUnavailableMessage('detail');
    expect(message).toContain('detail');
    expect(message).toContain('Enable container tabs');
    expect(message).toContain('normal profile');
  });
});
