import { describe, expect, it } from 'vitest';
import manifest from '../manifest.json';
import { SIDEBAR_PAGE } from '../sidebar/sidebar-messages';

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

  it('declares the webRequest permission that read_network_requests needs', () => {
    expect(manifest.permissions).toContain('webRequest');
  });

  it('points the options page at the built options page', () => {
    expect(manifest.options_ui).toEqual({ page: 'options/options.html' });
  });

  it('declares the sidebar chat panel at the built sidebar page that the background accepts tool calls from', () => {
    expect(manifest.sidebar_action).toEqual({
      default_panel: SIDEBAR_PAGE,
      default_title: 'Claude',
      default_icon: 'icons/icon.svg',
      open_at_install: false,
    });
  });

  it('requests access to all websites, which tabs.captureTab requires', () => {
    expect(manifest.host_permissions).toEqual(['<all_urls>']);
  });

  it('declares the Anthropic API as an optional host permission for the sidebar chat', () => {
    expect(manifest.optional_host_permissions).toEqual(['https://api.anthropic.com/*']);
  });
});
