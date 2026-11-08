import { EXTENSION_ID } from './protocol';

export type HostCommand =
  | { kind: 'native-host' }
  | { kind: 'mcp' }
  | { kind: 'install' }
  | { kind: 'print-paths' }
  | { kind: 'uninstall' }
  | { kind: 'usage' };

// The manifest points Firefox at the installed binary itself, without a wrapper that could add
// --native-host, and Firefox starts it with the manifest path and the extension id as arguments, so
// the extension id selects the native host mode.
export function parseCommand(args: readonly string[]): HostCommand {
  const [first, ...rest] = args;
  if (first === '--native-host') return { kind: 'native-host' };
  if (first === '--mcp') return { kind: 'mcp' };
  if (first === 'install') {
    if (rest.length === 0) return { kind: 'install' };
    if (rest.length === 1 && rest[0] === '--print-paths') return { kind: 'print-paths' };
    return { kind: 'usage' };
  }
  if (first === 'uninstall') return rest.length === 0 ? { kind: 'uninstall' } : { kind: 'usage' };
  if (args.length >= 2 && args.slice(1).includes(EXTENSION_ID)) return { kind: 'native-host' };
  return { kind: 'usage' };
}
