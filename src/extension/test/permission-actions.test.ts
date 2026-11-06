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

  it.each(['left_click', 'right_click', 'double_click', 'triple_click', 'left_click_drag'])('maps the computer %s action to click', (action) => {
    expect(permissionActionForTool('computer', { action, coordinate: [1, 2] })).toBe('click');
  });

  it.each([
    { action: 'type', text: 'hello' },
    { action: 'key', text: 'Enter', repeat: 2 },
  ])('maps the computer $action action to type', (args) => {
    expect(permissionActionForTool('computer', args)).toBe('type');
  });

  it('needs no permission for the computer wait action', () => {
    expect(permissionActionForTool('computer', { action: 'wait', duration: 1 })).toBeUndefined();
  });

  it.each(['screenshot', 'zoom', 'hover', 'scroll', 'scroll_to'])('maps the computer %s action to read_page_content', (action) => {
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

  it('maps form_input to type', () => {
    expect(permissionActionForTool('form_input', { ref: 'ref_1', value: 'x', tabId: 1 })).toBe('type');
    expect(permissionActionForTool('form_input', undefined)).toBe('type');
  });

  it('maps javascript_tool to execute_javascript', () => {
    expect(permissionActionForTool('javascript_tool', { action: 'javascript_exec', text: '1', tabId: 1 })).toBe('execute_javascript');
    expect(permissionActionForTool('javascript_tool', undefined)).toBe('execute_javascript');
  });

  it('maps read_console_messages to read_console_messages', () => {
    expect(permissionActionForTool('read_console_messages', { tabId: 1, onlyErrors: true })).toBe('read_console_messages');
    expect(permissionActionForTool('read_console_messages', undefined)).toBe('read_console_messages');
  });

  it('maps read_network_requests to read_network_requests', () => {
    expect(permissionActionForTool('read_network_requests', { tabId: 1, urlPattern: '/api/' })).toBe('read_network_requests');
    expect(permissionActionForTool('read_network_requests', undefined)).toBe('read_network_requests');
  });

  it.each([undefined, null, 'url', 42, ['https://example.com']])('treats non-object args %j as empty', (args) => {
    expect(permissionActionForTool('navigate', args)).toBe('navigate');
    expect(permissionActionForTool('tabs_create', args)).toBeUndefined();
    expect(permissionActionForTool('computer', args)).toBeUndefined();
  });

  it.each([
    ['computer', { action: 'click' }],
    ['computer', { action: 'Type' }],
    ['computer', {}],
    ['tabs_context', {}],
    ['resize_window', { width: 800, height: 600, tabId: 1 }],
    ['unknown_tool', {}],
  ])('returns undefined for %s %o', (tool, args) => {
    expect(permissionActionForTool(tool, args)).toBeUndefined();
  });
});
