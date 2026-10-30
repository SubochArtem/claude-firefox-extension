import { beforeEach, describe, expect, it } from 'vitest';
import { handleOptionsMessage, OPTIONS_PAGE, REVOKE_PERMISSION_MESSAGE } from '../options/options-messages';
import { PERMISSION_STORAGE_KEY } from '../permissions/permission-store';
import { EXTENSION_ID, EXTENSION_ORIGIN, mockBrowser } from './browser-mock';

let browserMock: ReturnType<typeof mockBrowser>;

const OPTIONS_SENDER = { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}/${OPTIONS_PAGE}` } as browser.runtime.MessageSender;

function storedIds(): unknown {
  return (browserMock.storage.local.data.get(PERMISSION_STORAGE_KEY) as { id: string }[]).map((record) => record.id);
}

beforeEach(() => {
  browserMock = mockBrowser();
  browserMock.allowSites('example.com', 'other.example');
});

describe('options page messages', () => {
  it('revokes a record for the options page', async () => {
    expect(await handleOptionsMessage({ type: REVOKE_PERMISSION_MESSAGE, id: 'allow-example.com' }, OPTIONS_SENDER)).toEqual({
      revoked: true,
    });
    expect(storedIds()).toEqual(['allow-other.example']);
  });

  it('reports an unknown record as not revoked', async () => {
    expect(await handleOptionsMessage({ type: REVOKE_PERMISSION_MESSAGE, id: 'missing' }, OPTIONS_SENDER)).toEqual({
      revoked: false,
    });
    expect(storedIds()).toEqual(['allow-example.com', 'allow-other.example']);
  });

  it.each<[string, Partial<browser.runtime.MessageSender>]>([
    ['another extension', { id: 'other@example', url: `${EXTENSION_ORIGIN}/${OPTIONS_PAGE}` }],
    ['another page of this extension', { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}/permissions/prompt.html` }],
    ['a content script', { id: EXTENSION_ID, url: 'https://example.com/' }],
  ])('refuses a revoke from %s', async (_label, sender) => {
    const reply = await handleOptionsMessage(
      { type: REVOKE_PERMISSION_MESSAGE, id: 'allow-example.com' },
      sender as browser.runtime.MessageSender,
    );
    expect(reply).toEqual({ revoked: false });
    expect(storedIds()).toEqual(['allow-example.com', 'allow-other.example']);
  });

  it('refuses a revoke without a string id', async () => {
    expect(await handleOptionsMessage({ type: REVOKE_PERMISSION_MESSAGE, id: 3 }, OPTIONS_SENDER)).toEqual({ revoked: false });
  });

  it.each([undefined, 'text', { type: 'permission_prompt_get' }])('ignores other messages (%o)', (message) => {
    expect(handleOptionsMessage(message, OPTIONS_SENDER)).toBeUndefined();
  });
});
