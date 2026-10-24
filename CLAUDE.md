# claude-firefox-extension

A Firefox extension that lets Claude Code control the user's real Firefox browser: navigate, read pages, click, type, take screenshots, inspect console and network. It is an independent implementation of the same idea as Claude in Chrome, built on Firefox APIs.

## Architecture

```
Claude Code ──MCP (stdio)──> native host ──native messaging──> Firefox extension
                                  │                              ├─ background script
                                  │                              └─ content scripts
                                  └──WebDriver BiDi──> Firefox (trusted input events)
```

- **MCP server / native host**: exposes browser tools to Claude Code over stdio and relays them to the extension through native messaging.
- **Extension**: tabs, screenshots (`tabs.captureVisibleTab`), script execution (`scripting.executeScript`), network (`webRequest`), console capture, accessibility tree built from the DOM with `ref_N` element references.
- **WebDriver BiDi**: Firefox WebExtensions cannot produce trusted input events, so clicks and keystrokes go through BiDi `input.performActions`. Firefox must be started with `--remote-debugging-port`.

## Tools

Browser tools follow the shape Claude already works well with: `computer`, `navigate`, `read_page`, `find`, `form_input`, `get_page_text`, `javascript_tool`, `tabs_*`, `read_console_messages`, `read_network_requests`, `resize_window`.

The native host is a local program installed on the user's machine, not a hosted server. Claude Code starts the MCP side over stdio, Firefox starts the native messaging side; the two processes talk over a local channel.

## Decisions

- Extension: TypeScript with a build step.
- Native host and MCP server: Node.js + TypeScript, official `@modelcontextprotocol/sdk`.
- Target: current Firefox release (158), Manifest V3.
- All project code and tooling live under `src/`: `src/package.json` is the npm root (`src/extension`, `src/host`); build output goes to `src/dist/`.
- Extension id: `claude-firefox-extension@localhost`. The native messaging host manifest's `allowed_extensions` must match it.
- Permissions and host permissions are added in the feature that first needs them, not up front.
- Firefox MV3 host permissions are opt-in for the user: a feature that needs them must document granting them in `about:addons` or request them at runtime.
- Bridge between the MCP process and the native messaging process: a Unix domain socket `bridge.sock` in the first of `$XDG_RUNTIME_DIR/claude-firefox-extension/`, `/run/user/<uid>/claude-firefox-extension/` (Linux, if that runtime dir exists and is owned by the user), `/tmp/claude-firefox-extension-<uid>/` (literal `/tmp`, never `TMPDIR`). The order does not depend on variables Claude Code may strip from the MCP server's environment. Directory 0700 and socket 0600, no token. Both processes `lstat` the directory and refuse it if it is a symlink, not a directory, not owned by the current uid, or has any group/other permission bits. Windows is not supported yet: the code falls back to a named pipe with the default ACL, which is not restricted to the current user. The native host listens; every MCP server process connects to it. Messages on the socket are newline-delimited JSON; the host multiplexes clients by rewriting request ids to `<clientId>:<id>`.
- Tests: Vitest, run with `npm test` from `src/`. Every feature ships with its own automated tests.
- TDD where it fits: logic with a spec known up front (protocols, framing, multiplexing, parsing, accessibility tree and `ref_N` resolution, argument validation, translating `computer` actions to WebDriver BiDi) gets its tests written first, reviewed, then the implementation. Code whose correctness depends on real Firefox behavior (native messaging lifecycle, event page suspension, `captureVisibleTab`, permissions, BiDi) is written first and covered afterwards, together with a check in a real Firefox.
- Windows support is required: a named pipe restricted to the current user and registry-based native host registration. Delivered by `feature/windows-support`; until then the bridge note above describes the current state.

## Roadmap

Each feature is its own branch from `main`. The feature's last commit marks it `[x]` here.

- [x] `feature/project-setup`: `package.json`, `tsconfig`, `web-ext`, build, folder structure; fill in Repository layout and Commands below.
- [x] `feature/extension-skeleton`: Firefox MV3 `manifest.json` and background script; the extension loads without errors.
- [x] `feature/native-bridge`: native host + MCP server, end-to-end on the first tool `tabs_context`; install/registration of the native messaging manifest.
- [x] `feature/tests`: Vitest setup and `npm test`; tests for the existing host (native messaging framing, JSON lines, client multiplexing, timeouts, socket directory checks, MCP server against a fake extension) and the extension tool registry / `tabs_context` with a mocked `browser.*`.
- [ ] `feature/windows-support`: named pipe restricted to the current user, installer writing `HKCU\Software\Mozilla\NativeMessagingHosts\claude_firefox_extension` and a `.cmd` wrapper, Windows paths in host and scripts.
- [ ] `feature/navigate`: `navigate`, `tabs_create`, `tabs_close`.
- [ ] `feature/screenshot`: screenshots via `tabs.captureVisibleTab`.
- [ ] `feature/accessibility-tree`: DOM-based tree with `ref_N` references; `read_page`, `find`, `get_page_text`.
- [ ] `feature/bidi-input`: `computer` tool (click, type, key, scroll) through WebDriver BiDi; `form_input`.
- [ ] `feature/devtools-tools`: `javascript_tool`, `read_console_messages`, `read_network_requests`, `resize_window`.

## Repository layout

```
CLAUDE.md
.gitignore
src/                   npm package root; every command is run from here
  package.json
  package-lock.json
  tsconfig.base.json   shared strict compiler options (no emit)
  tsconfig.json        type check for build scripts, their tests, web-ext and Vitest config (Node types, no DOM)
  web-ext-config.mjs   web-ext defaults: source dir, artifacts dir, run/lint options
  vitest.config.ts     Vitest projects: extension, host (bundles the host once in a global setup), scripts
  scripts/build.mjs    esbuild bundling of extension/ into dist/extension and host/ into dist/host
  scripts/install-host.mjs  installs/uninstalls the native messaging manifest and host wrapper (Linux, macOS)
  scripts/test/        installer tests (run a copy of the installer against a temp HOME)
  extension/           Firefox extension sources: manifest.json, background script, content scripts, static assets
    tsconfig.json      extension type check (DOM + WebExtension types, no Node), test/ included
    test/              unit tests with a mocked `browser` global (browser-mock.ts); not copied into dist
  host/                native messaging host + MCP server, one entry point
    tsconfig.json      host type check (Node types, no DOM), test/ included
    test/              unit tests, process tests against the bundled host, in-process timeout tests with fake timers;
                       helpers.ts (temp dirs under /tmp, fake extension, bridge client), global-setup.ts
    index.ts           dispatches by flag: --native-host or --mcp
    protocol.ts        message types for both channels, shared constants
    socket-path.ts     bridge socket path resolution and permissions
    json-lines.ts      newline-delimited JSON framing on the bridge socket
    native-messaging.ts  Firefox native messaging stdio framing
    native-host.ts     native host: talks to the extension, listens on the bridge socket, multiplexes clients
    mcp-server.ts      MCP server over stdio: registers tools, forwards calls to the native host
  node_modules/        (not committed)
  dist/extension/      built extension, loaded by web-ext (not committed)
  dist/host/index.js   bundled host for Node, run as `node dist/host/index.js --native-host|--mcp` (not committed)
  web-ext-artifacts/   (not committed)
```

## Commands

Run every command from `src/` (`cd src && npm run build`).

- `npm install`: install dependencies.
- `npm run build`: bundle `extension/` into `dist/extension` and `host/` into `dist/host`.
- `npm run typecheck`: type-check the root project (build scripts, installer tests, Vitest config), `extension/` and `host/` (each with its tests) with `tsc --noEmit`.
- `npm test`: run the Vitest suite once (no build, Firefox or network needed; temp dirs under `/tmp`, never the real bridge socket directory or `~/.mozilla`). `npm run test:watch` runs it in watch mode.
- `npm run lint`: run `web-ext lint` on `dist/extension` (build first).
- `npm run start`: run the built extension in a temporary Firefox profile with `web-ext run` (build first).
- `npm run install-host`: register the native messaging host for Firefox (build first): writes a wrapper script that runs `dist/host/index.js --native-host` with the current Node binary (`~/.local/share/claude-firefox-extension/native-host` on Linux, `~/Library/Application Support/claude-firefox-extension/native-host` on macOS) and the manifest `claude_firefox_extension.json` (`~/.mozilla/native-messaging-hosts/` on Linux, `~/Library/Application Support/Mozilla/NativeMessagingHosts/` on macOS). Prints the `claude mcp add` command. Windows, Snap and Flatpak Firefox are not supported.
- `npm run uninstall-host`: remove the manifest and the wrapper.
- `claude mcp add firefox -- '<node>' '<abs path>/src/dist/host/index.js' --mcp`: register the MCP server with Claude Code, once, using the exact command printed by `npm run install-host`.
