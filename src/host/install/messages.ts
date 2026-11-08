import type { HostSource, InstallPaths } from './paths';

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The command that registers the MCP server: the installed binary, or Node with the development build. */
export function mcpAddCommand(platform: NodeJS.Platform, source: HostSource, paths: InstallPaths): string {
  const command = source.kind === 'binary' ? [paths.binaryPath] : [source.nodePath, source.entry];
  const quote = platform === 'win32' ? (value: string) => `"${value}"` : shellQuote;
  return `claude mcp add firefox -- ${command.map(quote).join(' ')} --mcp`;
}

const FIREFOX_COMMANDS = {
  win32: '"C:\\Program Files\\Mozilla Firefox\\firefox.exe" --remote-debugging-port=9222',
  darwin: '/Applications/Firefox.app/Contents/MacOS/firefox --remote-debugging-port=9222',
  linux: 'firefox --remote-debugging-port=9222',
};

/** Must match DEFAULT_BIDI_PORT and BIDI_PORT_ENV in host/bidi-client.ts. */
export function remoteDebuggingNote(platform: NodeJS.Platform): string[] {
  const command = platform === 'win32' || platform === 'darwin' ? FIREFOX_COMMANDS[platform] : FIREFOX_COMMANDS.linux;
  return [
    'Clicks and typing need Firefox started with WebDriver BiDi on port 9222. Close every Firefox window, then run:',
    `  ${command}`,
    'To use another port, start Firefox with that port and set CLAUDE_FIREFOX_BIDI_PORT to it in the environment Firefox is started from.',
  ];
}
