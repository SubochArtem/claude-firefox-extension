import { describe, expect, it } from 'vitest';
import manifest from '../manifest.json';

describe('manifest', () => {
  it('declares the webNavigation permission that navigate needs', () => {
    expect(manifest.permissions).toContain('webNavigation');
  });

  it('declares the tabs permission that the tab tools need for titles and urls', () => {
    expect(manifest.permissions).toContain('tabs');
  });

  it('declares the scripting permission that the screenshot needs to read the viewport', () => {
    expect(manifest.permissions).toContain('scripting');
  });

  it('declares the storage permission that site permission records need', () => {
    expect(manifest.permissions).toContain('storage');
  });

  it('declares contextualIdentities for the agent container and cookies, which tabs.create needs for cookieStoreId', () => {
    expect(manifest.permissions).toContain('contextualIdentities');
    expect(manifest.permissions).toContain('cookies');
  });

  it('points the options page at the built options page', () => {
    expect(manifest.options_ui).toEqual({ page: 'options/options.html' });
  });

  it('requests access to all websites, which tabs.captureTab requires', () => {
    expect(manifest.host_permissions).toEqual(['<all_urls>']);
  });
});
