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
      return params.action === 'screenshot' || params.action === 'zoom' ? 'read_page_content' : undefined;
    default:
      return undefined;
  }
}
