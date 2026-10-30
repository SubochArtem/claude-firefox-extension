import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, parseSettings, saveSettings, SETTINGS_STORAGE_KEY } from '../settings';
import { mockBrowser } from './browser-mock';

let browserMock: ReturnType<typeof mockBrowser>;

beforeEach(() => {
  browserMock = mockBrowser();
});

describe('settings', () => {
  it('uses the settings key and opens agent tabs in the container by default', () => {
    expect(SETTINGS_STORAGE_KEY).toBe('settings');
    expect(DEFAULT_SETTINGS).toEqual({ agentTabs: 'container' });
  });

  it.each(['container', 'default'] as const)('accepts agentTabs %s', (agentTabs) => {
    expect(parseSettings({ agentTabs })).toEqual({ agentTabs });
  });

  it.each([undefined, null, 'container', 42, [], {}, { agentTabs: 'normal' }, { agentTabs: '' }, { agentTabs: true }])(
    'falls back to the default for %o',
    (value) => {
      expect(parseSettings(value)).toEqual(DEFAULT_SETTINGS);
    },
  );

  it('drops unknown fields', () => {
    expect(parseSettings({ agentTabs: 'default', extra: 1 })).toEqual({ agentTabs: 'default' });
  });

  it('loads the default from empty storage', async () => {
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('loads a stored setting and replaces an invalid one with the default', async () => {
    browserMock.storage.local.data.set(SETTINGS_STORAGE_KEY, { agentTabs: 'default' });
    expect(await loadSettings()).toEqual({ agentTabs: 'default' });
    browserMock.storage.local.data.set(SETTINGS_STORAGE_KEY, { agentTabs: 'private' });
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('saves only validated settings', async () => {
    await saveSettings({ agentTabs: 'default' });
    expect(browserMock.storage.local.data.get(SETTINGS_STORAGE_KEY)).toEqual({ agentTabs: 'default' });
    await expect(saveSettings({ agentTabs: 'other' } as never)).rejects.toThrow('Invalid settings');
    expect(browserMock.storage.local.data.get(SETTINGS_STORAGE_KEY)).toEqual({ agentTabs: 'default' });
  });
});
