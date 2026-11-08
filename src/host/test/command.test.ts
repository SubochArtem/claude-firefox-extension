import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCommand } from '../command';
import { EXTENSION_ID } from '../protocol';

const extensionManifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../extension/manifest.json', import.meta.url)), 'utf8'),
) as { browser_specific_settings: { gecko: { id: string } } };

describe('parseCommand', () => {
  it('uses the extension id Firefox passes to the native host', () => {
    expect(EXTENSION_ID).toBe(extensionManifest.browser_specific_settings.gecko.id);
  });

  it.each([
    ['--native-host', ['--native-host'], { kind: 'native-host' }],
    ['--native-host with the arguments Firefox adds after the wrapper', ['--native-host', '/m.json', EXTENSION_ID], { kind: 'native-host' }],
    ['--mcp', ['--mcp'], { kind: 'mcp' }],
    ['install', ['install'], { kind: 'install' }],
    ['install --print-paths', ['install', '--print-paths'], { kind: 'print-paths' }],
    ['uninstall', ['uninstall'], { kind: 'uninstall' }],
  ] as const)('reads %s', (_name, args, expected) => {
    expect(parseCommand(args)).toEqual(expected);
  });

  // Firefox starts the manifest's executable with the manifest path and the extension id only.
  it.each([
    ['a Linux manifest path', ['/home/anna/.mozilla/native-messaging-hosts/claude_firefox_extension.json', EXTENSION_ID]],
    ['a Windows manifest path', ['C:\\Users\\Анна\\AppData\\Local\\claude-firefox-extension\\claude_firefox_extension.json', EXTENSION_ID]],
    ['a manifest path with spaces', ['/Users/anna/Library/Application Support/Mozilla/NativeMessagingHosts/claude_firefox_extension.json', EXTENSION_ID]],
    ['an extra argument after the id', ['/m.json', EXTENSION_ID, 'later']],
  ])('runs as the native host when Firefox starts it with %s', (_name, args) => {
    expect(parseCommand(args)).toEqual({ kind: 'native-host' });
  });

  it.each([
    ['no arguments', []],
    ['an unknown flag', ['--help']],
    ['an unknown subcommand', ['setup']],
    ['the manifest path without the id', ['/m.json']],
    ['another extension id', ['/m.json', 'other@example.com']],
    ['an id that only contains ours', ['/m.json', `x${EXTENSION_ID}`]],
    ['install with an unknown option', ['install', '--force']],
    ['uninstall with an option', ['uninstall', '--print-paths']],
    ['a subcommand as a flag', ['--install']],
  ])('shows the usage for %s', (_name, args) => {
    expect(parseCommand(args)).toEqual({ kind: 'usage' });
  });

  it('does not treat a subcommand with the id after it as the native host', () => {
    expect(parseCommand(['install', EXTENSION_ID])).toEqual({ kind: 'usage' });
  });
});
