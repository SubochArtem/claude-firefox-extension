import { describe, expect, it } from 'vitest';
import { PERMISSION_ACTIONS, permissionActionForTool } from '../permissions/actions';

describe('PERMISSION_ACTIONS', () => {
  it('lists every action type a permission prompt can show', () => {
    expect(PERMISSION_ACTIONS).toEqual([
      'navigate',
      'read_page_content',
      'click',
      'type',
      'execute_javascript',
      'read_console_messages',
      'read_network_requests',
    ]);
  });
});

describe('permissionActionForTool', () => {
  it.each([
    ['navigate', { tabId: 1, url: 'https://example.com' }],
    ['navigate', { tabId: 1, url: 'back' }],
    ['tabs_create', { url: 'https://example.com' }],
  ])('maps %s with a url to navigate', (tool, args) => {
    expect(permissionActionForTool(tool, args)).toBe('navigate');
  });

  it.each([{}, { url: undefined }])('needs no permission for tabs_create without a url (%o)', (args) => {
    expect(permissionActionForTool('tabs_create', args)).toBeUndefined();
  });

  it('maps tabs_close to navigate', () => {
    expect(permissionActionForTool('tabs_close', { tabId: 1 })).toBe('navigate');
  });

  it.each(['screenshot', 'zoom'])('maps the computer %s action to read_page_content', (action) => {
    expect(permissionActionForTool('computer', { action, tabId: 1 })).toBe('read_page_content');
  });

  it('maps read_page to read_page_content', () => {
    expect(permissionActionForTool('read_page', { tabId: 1, filter: 'interactive' })).toBe('read_page_content');
  });

  it('maps get_page_text to read_page_content', () => {
    expect(permissionActionForTool('get_page_text', { tabId: 1 })).toBe('read_page_content');
    expect(permissionActionForTool('get_page_text', undefined)).toBe('read_page_content');
  });

  it('maps find to read_page_content', () => {
    expect(permissionActionForTool('find', { query: 'login button', tabId: 1 })).toBe('read_page_content');
    expect(permissionActionForTool('find', undefined)).toBe('read_page_content');
  });

  it.each([undefined, null, 'url', 42, ['https://example.com']])('treats non-object args %j as empty', (args) => {
    expect(permissionActionForTool('navigate', args)).toBe('navigate');
    expect(permissionActionForTool('tabs_create', args)).toBeUndefined();
    expect(permissionActionForTool('computer', args)).toBeUndefined();
  });

  it.each([
    ['computer', { action: 'click' }],
    ['computer', {}],
    ['tabs_context', {}],
    ['unknown_tool', {}],
  ])('returns undefined for %s %o', (tool, args) => {
    expect(permissionActionForTool(tool, args)).toBeUndefined();
  });
});
