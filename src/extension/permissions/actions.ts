import { isRecord } from '../tools/navigation-input';

export const PERMISSION_ACTIONS = [
  'navigate',
  'read_page_content',
  'click',
  'type',
  'execute_javascript',
  'read_console_messages',
  'read_network_requests',
] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

function computerAction(action: unknown): PermissionAction | undefined {
  switch (action) {
    case 'left_click':
    case 'right_click':
    case 'double_click':
    case 'triple_click':
    case 'left_click_drag':
      return 'click';
    case 'screenshot':
    case 'zoom':
    case 'hover':
    case 'scroll':
    case 'scroll_to':
      return 'read_page_content';
    case 'type':
    case 'key':
      return 'type';
    default:
      return undefined;
  }
}

// Returns the action a tool call performs on a site, or undefined when the call touches no site content.
export function permissionActionForTool(tool: string, args: unknown): PermissionAction | undefined {
  const params = isRecord(args) ? args : {};
  switch (tool) {
    case 'navigate':
      return 'navigate';
    case 'tabs_create':
      return params.url === undefined ? undefined : 'navigate';
    case 'tabs_close':
      return 'navigate';
    case 'computer':
      return computerAction(params.action);
    case 'read_page':
    case 'get_page_text':
    case 'find':
      return 'read_page_content';
    case 'form_input':
      return 'type';
    case 'javascript_tool':
      return 'execute_javascript';
    default:
      return undefined;
  }
}
