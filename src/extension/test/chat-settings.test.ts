import { beforeEach, describe, expect, it } from 'vitest';
import {
  ANTHROPIC_API_ORIGIN,
  CHAT_MODELS,
  CHAT_SETTINGS_STORAGE_KEY,
  DEFAULT_CHAT_SETTINGS,
  loadChatSettings,
  parseChatSettings,
  saveChatSettings,
  validApiKey,
} from '../chat-settings';
import { ANTHROPIC_MESSAGES_URL } from '../chat/anthropic-provider';
import { mockBrowser } from './browser-mock';

let browserMock: ReturnType<typeof mockBrowser>;

beforeEach(() => {
  browserMock = mockBrowser();
});

describe('chat settings', () => {
  it('uses the chatSettings key, no key and Sonnet by default', () => {
    expect(CHAT_SETTINGS_STORAGE_KEY).toBe('chatSettings');
    expect(DEFAULT_CHAT_SETTINGS).toEqual({ apiKey: '', model: 'claude-sonnet-5-5' });
  });

  it('lists the allowed models with labels', () => {
    expect(CHAT_MODELS.map((model) => model.id)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']);
    for (const model of CHAT_MODELS) expect(model.label).not.toBe('');
  });

  it('matches the origin of the Messages API endpoint', () => {
    expect(ANTHROPIC_API_ORIGIN).toBe('https://api.anthropic.com/*');
    expect(new URL(ANTHROPIC_MESSAGES_URL).origin).toBe('https://api.anthropic.com');
  });

  it.each(CHAT_MODELS.map((model) => model.id))('accepts model %s', (model) => {
    expect(parseChatSettings({ apiKey: 'sk-ant-key', model })).toEqual({ apiKey: 'sk-ant-key', model });
  });

  it('trims the stored key', () => {
    expect(parseChatSettings({ apiKey: '  sk-ant-key\n', model: 'claude-opus-5-5' })).toEqual({ apiKey: 'sk-ant-key', model: 'claude-opus-5-5' });
  });

  it.each([undefined, null, 'sk', 42, [], {}])('falls back to the defaults for %o', (value) => {
    expect(parseChatSettings(value)).toEqual(DEFAULT_CHAT_SETTINGS);
  });

  it.each([42, null, 'sk ant', 'sk-ant-é', 'sk-\u0000'])('drops an invalid key %o and keeps the model', (apiKey) => {
    expect(parseChatSettings({ apiKey, model: 'claude-haiku-5-5' })).toEqual({ apiKey: '', model: 'claude-haiku-5-5' });
  });

  it.each([
    ['sk-ant-key', 'sk-ant-key'],
    ['  sk-ant-key\n', 'sk-ant-key'],
    ['', ''],
  ])('validApiKey accepts %o as %o', (value, expected) => {
    expect(validApiKey(value)).toBe(expected);
  });

  it.each([42, null, undefined, 'sk ant', 'sk-ant-é', 'sk-\u0000', 'sk-\u007f'])('validApiKey rejects %o', (value) => {
    expect(validApiKey(value)).toBeUndefined();
  });

  it.each(['claude-unknown', '', 7, undefined])('replaces an unknown model %o with the default and keeps the key', (model) => {
    expect(parseChatSettings({ apiKey: 'sk-ant-key', model })).toEqual({ apiKey: 'sk-ant-key', model: 'claude-sonnet-5-5' });
  });

  it('drops unknown fields', () => {
    expect(parseChatSettings({ apiKey: 'k', model: 'claude-opus-5-5', extra: 1 })).toEqual({ apiKey: 'k', model: 'claude-opus-5-5' });
  });

  it('loads the defaults from empty storage and a stored value otherwise', async () => {
    expect(await loadChatSettings()).toEqual(DEFAULT_CHAT_SETTINGS);
    browserMock.storage.local.data.set(CHAT_SETTINGS_STORAGE_KEY, { apiKey: 'sk-ant-key', model: 'claude-fable-5-1' });
    expect(await loadChatSettings()).toEqual({ apiKey: 'sk-ant-key', model: 'claude-fable-5-1' });
  });

  it('saves a trimmed key and the model', async () => {
    await saveChatSettings({ apiKey: ' sk-ant-key ', model: 'claude-opus-5-5' });
    expect(browserMock.storage.local.data.get(CHAT_SETTINGS_STORAGE_KEY)).toEqual({ apiKey: 'sk-ant-key', model: 'claude-opus-5-5' });
    await saveChatSettings({ apiKey: '', model: 'claude-opus-5-5' });
    expect(browserMock.storage.local.data.get(CHAT_SETTINGS_STORAGE_KEY)).toEqual({ apiKey: '', model: 'claude-opus-5-5' });
  });

  it.each([
    { apiKey: 'sk ant', model: 'claude-opus-5-5' },
    { apiKey: 'sk-ant-key', model: 'claude-unknown' },
    { apiKey: 42, model: 'claude-opus-5-5' },
    null,
  ])('refuses to save %o and keeps the stored value', async (settings) => {
    browserMock.storage.local.data.set(CHAT_SETTINGS_STORAGE_KEY, { apiKey: 'old', model: 'claude-haiku-5-5' });
    await expect(saveChatSettings(settings as never)).rejects.toThrow('Invalid chat settings');
    expect(browserMock.storage.local.data.get(CHAT_SETTINGS_STORAGE_KEY)).toEqual({ apiKey: 'old', model: 'claude-haiku-5-5' });
  });

  it('does not put the key into the error message', async () => {
    await expect(saveChatSettings({ apiKey: 'sk-secret value', model: 'claude-opus-5-5' })).rejects.toThrow(/^Invalid chat settings$/);
  });
});
