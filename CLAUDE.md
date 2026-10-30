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

Browser tools follow the shape Claude already works well with: `computer`, `navigate`, `read_page`, `find`, `form_input`, `get_page_text`, `javascript_tool`, `tabs_*`, `read_console_messages`, `read_network_requests`, `resize_window`. Names are plain, without an `_mcp` suffix (`tabs_context`, `navigate`, `tabs_create`, `tabs_close`).

The native host is a local program on the user's machine, not a hosted server: Claude Code starts the MCP side over stdio, Firefox starts the native messaging side, and the two talk over a local channel.

## Decisions

Details: [`docs/decisions.md`](docs/decisions.md).

- Extension: TypeScript with a build step.
- Native host and MCP server: Node.js + TypeScript, official `@modelcontextprotocol/sdk`.
- Target: current Firefox release (158), Manifest V3.
- All project code and tooling live under `src/`: `src/package.json` is the npm root (`src/extension`, `src/host`); build output goes to `src/dist/`.
- Extension id: `claude-firefox-extension@localhost`; the native messaging manifest's `allowed_extensions` must match it.
- Permissions and host permissions are added in the feature that first needs them, not up front.
- Firefox MV3 host permissions are opt-in: a feature that needs them must document granting them in `about:addons` or request them at runtime.
- Bridge: the native host listens on a private Unix socket (Linux, macOS) or a random named pipe (Windows), publishes `bridge.json` with a per-start secret, runs a mutual HMAC handshake with every MCP server process, then multiplexes newline-delimited JSON by rewriting ids to `<clientId>:<id>`; see [Bridge protocol](docs/decisions.md#bridge-protocol) for endpoints, `bridge.json`, the Windows second-host check, limits and startup buffering/backoff.
- tabs_create opens a background tab in the last focused normal window; tabs_close refuses the last tab of the last normal window.
- Tab scope: until `feature/permissions`, the agent may navigate and close any tab in any normal window (user decision); revisited there together with per-site permissions and the agent container.
- Tests: Vitest, `npm test` from `src/`; every feature ships with its own automated tests.
- TDD where it fits: tests first for logic with a spec known up front, tests after for code that depends on real Firefox behavior; see [Testing approach](docs/decisions.md#testing-approach).
- Windows support is required: hardened `%LOCALAPPDATA%` directory, `.bat` wrapper and `HKCU` registration with rollback; see [Windows installer](docs/decisions.md#windows-installer).

## Threat model

Full text: [Threat model](docs/decisions.md#threat-model).

- Protected: other OS users and the network cannot use or impersonate the bridge; the browser to host link is protected by native messaging `allowed_extensions`.
- Trusted: any process of the same OS user, Administrators, SYSTEM and root.
- Before distribution: the extension id is not reserved on AMO; fixed by `feature/amo-signing`.
- Next major risk: prompt injection from page content; `feature/permissions` must land before `feature/accessibility-tree` and `feature/devtools-tools`.
- Accepted for now: `navigate` and `tabs_close` work on any tab, including the user's, until `feature/permissions` scopes the agent's tabs.

## Roadmap

Each feature is delivered as a series of small pull requests, one coherent part each, on branches `feature/<feature>-<part>` from the updated `main`. The feature's last pull request marks it `[x]` here.

- [x] `feature/project-setup`: `package.json`, `tsconfig`, `web-ext`, build, folder structure; fill in Repository layout and Commands below.
- [x] `feature/extension-skeleton`: Firefox MV3 `manifest.json` and background script; the extension loads without errors.
- [x] `feature/native-bridge`: native host + MCP server, end-to-end on the first tool `tabs_context`; install/registration of the native messaging manifest.
- [x] `feature/tests`: Vitest setup and `npm test`; tests for the existing host (native messaging framing, JSON lines, client multiplexing, timeouts, socket directory checks, MCP server against a fake extension) and the extension tool registry / `tabs_context` with a mocked `browser.*`.
- [x] `feature/windows-support`: named pipe with a random name per host start plus the authenticated bridge handshake, installer writing `HKCU\Software\Mozilla\NativeMessagingHosts\claude_firefox_extension` and a `.bat` wrapper, Windows paths in host and scripts.
- [ ] `feature/amo-signing`: reserve a real extension id on AMO, sign with `web-ext sign` (unlisted), permanent install in release Firefox, verify `runtime.onStartup` reconnect. Needs the user's AMO account and API keys; timing decided separately.
- [x] `feature/navigate`: `navigate`, `tabs_create`, `tabs_close`.
- [ ] `feature/screenshot`: screenshots via `tabs.captureVisibleTab`.
- [ ] `feature/permissions`: permission layer against prompt injection (per-site approval, confirmation of sensitive actions); user choice between a dedicated agent container (`contextualIdentities`, isolated cookies and logins) and the normal profile, with default, switch location and per-domain mixing decided at the start; design after researching how Claude in Chrome does it.
- [ ] `feature/accessibility-tree`: DOM-based tree with `ref_N` references; `read_page`, `find`, `get_page_text`.
- [ ] `feature/bidi-input`: `computer` tool (click, type, key, scroll) through WebDriver BiDi; `form_input`.
- [ ] `feature/devtools-tools`: `javascript_tool`, `read_console_messages`, `read_network_requests`, `resize_window`.
- [ ] `feature/sidebar-chat`: chat in a Firefox sidebar; options decided at its start after checking Anthropic's terms: a sidebar that talks to the user's local Claude Code through the native host (user signs in to Claude Code as usual), or direct Anthropic API calls with the user's API key. Signing in to claude.ai from the extension like Claude in Chrome is not available to third parties.
- [ ] `feature/packaging`: installation without Node.js for end users: a native host executable and an installer per OS.

## Repository layout

```
CLAUDE.md
.gitignore
.github/workflows/ci.yml  CI on Linux, Windows, macOS: typecheck, build, lint, test, then e2e in real Firefox (docs/decisions.md#ci)
docs/
  decisions.md         design details: bridge protocol, Windows installer, threat model, tests, CI, e2e
src/                   npm package root; every command is run from here
  package.json
  package-lock.json
  tsconfig.base.json   shared strict compiler options (no emit)
  tsconfig.json        type check for build scripts, their tests, web-ext and Vitest config (Node types, no DOM)
  web-ext-config.mjs   web-ext defaults: source dir, artifacts dir, run/lint options
  vitest.config.ts     Vitest projects: extension, host (bundles the host once in a global setup), scripts
  scripts/build.mjs    esbuild bundling of extension/ into dist/extension and host/ into dist/host
  scripts/install-host.mjs  installs/uninstalls the native messaging manifest and host wrapper (Linux, macOS, Windows)
  scripts/install-host-lib.mjs  Windows installer logic: paths, .bat wrapper, icacls/reg/whoami arguments and flows
  scripts/e2e.mjs      end-to-end check in a real headless Firefox (npm run e2e)
  scripts/e2e-safety.mjs  checks that confine a local e2e run to a temporary HOME (pure, tested)
  scripts/test/        installer tests (against a temp HOME), e2e safety tests
  extension/           Firefox extension sources: manifest.json, background script, content scripts, static assets
    tsconfig.json      extension type check (DOM + WebExtension types, no Node), test/ included
    test/              unit tests with a mocked `browser` global (browser-mock.ts), manifest permission checks
    tools/             tool handlers and registry (index.ts)
      navigation-input.ts  pure argument validation for navigate, tabs_create, tabs_close
      navigate.ts      navigate tool: tabs.update/goBack/goForward, waits on webNavigation events
      tabs.ts          tabs_create and tabs_close tools
      tool-error.ts    ToolError: expected failure whose message reaches the agent without the generic prefix
  host/                native messaging host + MCP server, one entry point
    tsconfig.json      host type check (Node types, no DOM), test/ included
    test/              unit, process and fake-timer tests; helpers.ts (temp dirs, endpoints, fake extension), global-setup.ts
    index.ts           dispatches by flag: --native-host or --mcp
    protocol.ts        message types for both channels, shared constants
    socket-path.ts     bridge socket path resolution and permissions; random pipe names on Windows
    bridge-info.ts     bridge.json location, atomic write, validated read, removal on exit
    handshake.ts       bridge handshake: nonces, HMAC proofs, message parsers, limits, client side on a socket
    host-probe.ts      authenticated liveness probe of the host named in bridge.json (Windows second-host check)
    listen.ts          listen on an endpoint, retrying fresh endpoints on EADDRINUSE
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
- `npm run typecheck`: `tsc --noEmit` for the root project (build scripts, installer tests, Vitest config), `extension/` and `host/` (each with its tests).
- `npm test`: run the Vitest suite once (no build, Firefox or network; temp dirs under `/tmp` only). `npm run test:watch` for watch mode.
- `npm run lint`: run `web-ext lint` on `dist/extension` (build first).
- `npm run start`: run the built extension in a temporary Firefox profile with `web-ext run` (build first).
- `npm run install-host`: register the native messaging host for Firefox (build first) and print the `claude mcp add` command; paths per OS in [docs/decisions.md](docs/decisions.md#native-host-installation-paths). Snap and Flatpak Firefox are not supported.
- `npm run uninstall-host`: remove the manifest and the wrapper (and the registry key on Windows).
- `npm run e2e`: end-to-end check in a real headless Firefox (build first); changes the host registration, so it runs only with `CI=true|1` or `--force`, and a local `--force` run is Linux only inside a temporary `HOME` and `XDG_RUNTIME_DIR` under `/tmp` ([E2E](docs/decisions.md#e2e)). `E2E_FIREFOX` overrides the Firefox binary. Example: `RT=$(mktemp -d /tmp/cfe-rt-XXXX); H=$(mktemp -d /tmp/cfe-home-XXXX); HOME=$H XDG_RUNTIME_DIR=$RT npm run e2e -- --force`.
- `claude mcp add firefox -- '<node>' '<abs path>/src/dist/host/index.js' --mcp` (double quotes on Windows): register the MCP server with Claude Code, once, using the exact command printed by `npm run install-host`.
