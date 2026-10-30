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

Tool names are plain, without an `_mcp` suffix: `tabs_context`, `navigate`, `tabs_create`, `tabs_close`.

The native host is a local program installed on the user's machine, not a hosted server. Claude Code starts the MCP side over stdio, Firefox starts the native messaging side; the two processes talk over a local channel.

## Decisions

- Extension: TypeScript with a build step.
- Native host and MCP server: Node.js + TypeScript, official `@modelcontextprotocol/sdk`.
- Target: current Firefox release (158), Manifest V3.
- All project code and tooling live under `src/`: `src/package.json` is the npm root (`src/extension`, `src/host`); build output goes to `src/dist/`.
- Extension id: `claude-firefox-extension@localhost`. The native messaging host manifest's `allowed_extensions` must match it.
- Permissions and host permissions are added in the feature that first needs them, not up front.
- Firefox MV3 host permissions are opt-in for the user: a feature that needs them must document granting them in `about:addons` or request them at runtime.
- Bridge between the MCP process and the native messaging process: the native host listens; every MCP server process connects to it. Messages are newline-delimited JSON; the host multiplexes clients by rewriting request ids to `<clientId>:<id>`.
  - Endpoint on Linux and macOS: a Unix domain socket `bridge.sock` in the first of `$XDG_RUNTIME_DIR/claude-firefox-extension/`, `/run/user/<uid>/claude-firefox-extension/` (Linux, if that runtime dir exists and is owned by the user), `/tmp/claude-firefox-extension-<uid>/` (literal `/tmp`, never `TMPDIR`). The order does not depend on variables Claude Code may strip from the MCP server's environment. Directory 0700 and socket 0600. Both processes `lstat` the directory and refuse it if it is a symlink, not a directory, not owned by the current uid, or has any group/other permission bits.
  - Endpoint on Windows: a named pipe with a random name `\\.\pipe\claude-firefox-extension-<32 hex>`, new at every host start (retried on `EADDRINUSE`). Node cannot put an ACL on the pipe, so the random name prevents squatting and the handshake keeps other users out.
  - `bridge.json` (`{version: 1, endpoint, secret, pid}`, mode 0600) is written by the host after it listens, next to the socket on Linux and macOS and in `%LOCALAPPDATA%\claude-firefox-extension\` on Windows. The secret is 32 random bytes, new at every start. The file is replaced atomically (temp file + rename, retried on `EPERM`/`EBUSY` on Windows) and removed on exit only while it still describes this host; leftover temp files of the exiting host are removed too. The MCP server re-reads it on every (re)connect. `pid` is informational only and never used for liveness: on Linux and macOS liveness is a connect probe on the fixed socket path, on Windows it is the authenticated probe below.
  - Second host on Windows: random pipe names never collide, so before writing `bridge.json` a new host reads the existing file and runs the full client handshake against its endpoint with its secret (1 s timeout, 4 KiB line cap, no proof sent before the host proof checks out, disconnect right after `ready`). If that host answers, the new one closes its pipe and exits 1 without touching `bridge.json`; a missing, invalid or unanswered file is replaced. Two hosts starting at the same instant can both pass the check; the last writer of `bridge.json` wins and the other host stays running but unreachable (narrow window; Firefox starts one host per extension connection).
  - Every connection, on all platforms, runs a mutual HMAC-SHA256 handshake before any tool traffic: client `hello` with a nonce, host `hello` with its nonce and host proof, client `auth` with its proof, host `ready`. Proofs are HMAC over `label:clientNonce:serverNonce` keyed with the secret; the client checks the host proof before revealing its own. Either side closes on any other message before `ready`.
  - Limits before `ready`: 2 s from connect, at most 8 unauthenticated connections on the host, 4 KiB per line on the host; after `ready`, 64 MB per line.
  - The native host processes no native message before it has decided to serve (listening, second-host check passed, `bridge.json` written); earlier messages are buffered and replayed in order, and a host that exits before that writes nothing to stdout. The extension resets its reconnect backoff only after a connection has stayed up for 10 s after its pong, so a host that answers and exits right away cannot make it retry every second.
- Tab scope: until `feature/permissions`, the agent may navigate and close any tab in any normal window (user decision). Tab scoping is revisited in `feature/permissions` together with per-site permissions and the agent container.
- Tests: Vitest, run with `npm test` from `src/`. Every feature ships with its own automated tests.
- TDD where it fits: logic with a spec known up front (protocols, framing, multiplexing, parsing, accessibility tree and `ref_N` resolution, argument validation, translating `computer` actions to WebDriver BiDi) gets its tests written first, reviewed, then the implementation. Code whose correctness depends on real Firefox behavior (native messaging lifecycle, event page suspension, `captureVisibleTab`, permissions, BiDi) is written first and covered afterwards, together with a check in a real Firefox.
- Windows support is required. `feature/windows-support` delivers the authenticated bridge above and the Windows installer. The installer creates `%LOCALAPPDATA%\claude-firefox-extension\`, hardens it with `icacls` (inheritance removed, full control for the current user's SID, SYSTEM and Administrators only) while it is still empty, then writes `native-host.bat` (CRLF; `@echo off`, `setlocal DisableDelayedExpansion`, `chcp 65001`, then the quoted Node binary and host entry with `--native-host %*`) and `claude_firefox_extension.json`, both UTF-8, and registers the manifest last as the default value of `HKCU\Software\Mozilla\NativeMessagingHosts\claude_firefox_extension` with `reg.exe /reg:64`. If writing or registration fails, files that existed before the run get their previous content back (an older registry entry may still point at them) and new ones are removed. Uninstall deletes the key first and keeps the files if `reg.exe` fails or cannot run; it keeps the directory while it still holds `bridge.json` or a running host holds it open (`EBUSY`). `whoami.exe`, `icacls.exe` and `reg.exe` are run by their absolute `%SystemRoot%\System32` path without a shell. Accepted edge cases, checked manually on Windows: with delayed expansion enabled globally in the registry, cmd leaves a single `!` in the `.bat` path alone and only mangles it when two `!` enclose the name of a defined variable, which practically never happens in a profile path; Firefox starts `cmd.exe /s/c "<bat> <manifest> <id>"` without quoting the `.bat` path when it has no spaces, so an install path with `&` or `^` and no space cannot be started (confirmed), and the installer prints a warning for it. Only `&` and `^` were verified for the unquoted `.bat` path; other cmd metacharacters (`,`, `;`, `=`, `%name%`) are untested.

## Threat model

- Protected: other OS users on the same machine and the network cannot use or impersonate the bridge (private socket directory or user-only `%LOCALAPPDATA%`, random pipe name on Windows, per-start secret, mutual HMAC handshake, caps and timeouts). The browser to native host link is protected by Firefox native messaging (`allowed_extensions`).
- Trusted: any process running as the same OS user (it can read `bridge.json` and drive the browser); Administrators, SYSTEM and root. Same as other local browser-automation bridges.
- Windows pipe access: pipe names are enumerable by any user, but the default pipe DACL (verified: Everyone and ANONYMOUS LOGON read only; SYSTEM, Administrators and the owner full control) keeps another standard user from opening the pipe for read/write or adding an instance (verified with a second account). Keeping all unauthenticated connection slots busy is therefore only possible for processes that can already open the pipe; it would be denial of service only, nothing can be read or forged. Remote clients are not tested; they would need write access too.
- Before distribution: the extension id `claude-firefox-extension@localhost` is not reserved; another add-on with the same id signed on addons.mozilla.org could reach the native host if installed. Fixed by `feature/amo-signing`.
- Next major risk: prompt injection from page content once page-reading and JavaScript tools exist. Addressed by `feature/permissions` (per-site approval, confirmation of sensitive actions, optional agent container so the agent is not signed in to the user's accounts), which must land before `feature/accessibility-tree` and `feature/devtools-tools`.
- Known, accepted for now: `navigate` and `tabs_close` work on any tab, including tabs the user is working in; a misled agent can navigate them away or close them. Accepted until `feature/permissions` scopes the agent's tabs.

## Roadmap

Each feature is delivered as a series of small pull requests, one coherent part each, on branches `feature/<feature>-<part>` from the updated `main`. The feature's last pull request marks it `[x]` here.

- [x] `feature/project-setup`: `package.json`, `tsconfig`, `web-ext`, build, folder structure; fill in Repository layout and Commands below.
- [x] `feature/extension-skeleton`: Firefox MV3 `manifest.json` and background script; the extension loads without errors.
- [x] `feature/native-bridge`: native host + MCP server, end-to-end on the first tool `tabs_context`; install/registration of the native messaging manifest.
- [x] `feature/tests`: Vitest setup and `npm test`; tests for the existing host (native messaging framing, JSON lines, client multiplexing, timeouts, socket directory checks, MCP server against a fake extension) and the extension tool registry / `tabs_context` with a mocked `browser.*`.
- [x] `feature/windows-support`: named pipe with a random name per host start plus the authenticated bridge handshake, installer writing `HKCU\Software\Mozilla\NativeMessagingHosts\claude_firefox_extension` and a `.bat` wrapper, Windows paths in host and scripts.
- [ ] `feature/amo-signing`: reserve a real extension id on AMO, sign with `web-ext sign` (unlisted), permanent install in release Firefox, verify `runtime.onStartup` reconnect. Needs the user's AMO account and API keys; timing decided separately.
- [ ] `feature/navigate`: `navigate`, `tabs_create`, `tabs_close`.
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
.github/workflows/ci.yml  GitHub Actions on Linux, Windows, macOS (Node 24): npm ci, typecheck, build, lint, test;
                          then an e2e job per OS (needs test): installs the current Firefox release from Mozilla's
                          official downloads into RUNNER_TEMP, prints its version, npm ci, build, npm run e2e with E2E_FIREFOX
src/                   npm package root; every command is run from here
  package.json
  package-lock.json
  tsconfig.base.json   shared strict compiler options (no emit)
  tsconfig.json        type check for build scripts, their tests, web-ext and Vitest config (Node types, no DOM)
  web-ext-config.mjs   web-ext defaults: source dir, artifacts dir, run/lint options
  vitest.config.ts     Vitest projects: extension, host (bundles the host once in a global setup), scripts
  scripts/build.mjs    esbuild bundling of extension/ into dist/extension and host/ into dist/host
  scripts/install-host.mjs  installs/uninstalls the native messaging manifest and host wrapper (Linux, macOS, Windows)
  scripts/install-host-lib.mjs  Windows installer logic: paths, .bat wrapper, icacls/reg/whoami arguments and flows (self-contained)
  scripts/e2e.mjs      end-to-end check in a real headless Firefox (npm run e2e)
  scripts/e2e-safety.mjs  checks that confine a local e2e run to a temporary HOME (pure, tested)
  scripts/test/        installer tests (run a copy of the installer against a temp HOME), e2e safety tests
  extension/           Firefox extension sources: manifest.json, background script, content scripts, static assets
    tsconfig.json      extension type check (DOM + WebExtension types, no Node), test/ included
    test/              unit tests with a mocked `browser` global (browser-mock.ts); not copied into dist
    tools/             tool handlers and registry (index.ts)
      navigation-input.ts  pure argument validation for navigate, tabs_create, tabs_close: http(s)-only URL
                           normalization, no userinfo or control characters, back/forward, positive tabId
  host/                native messaging host + MCP server, one entry point
    tsconfig.json      host type check (Node types, no DOM), test/ included
    test/              unit tests, process tests against the bundled host, in-process timeout tests with fake timers;
                       helpers.ts (temp dirs under /tmp, endpoints as Unix sockets or Windows pipes from bridge.json,
                       fake extension, bridge client), global-setup.ts
    index.ts           dispatches by flag: --native-host or --mcp
    protocol.ts        message types for both channels, shared constants
    socket-path.ts     bridge socket path resolution and permissions; random pipe names on Windows
    bridge-info.ts     bridge.json location, atomic write, validated read, removal of the file and own temp files on exit
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
- `npm run typecheck`: type-check the root project (build scripts, installer tests, Vitest config), `extension/` and `host/` (each with its tests) with `tsc --noEmit`.
- `npm test`: run the Vitest suite once (no build, Firefox or network needed; temp dirs under `/tmp`, never the real bridge socket directory or `~/.mozilla`). `npm run test:watch` runs it in watch mode.
- `npm run lint`: run `web-ext lint` on `dist/extension` (build first).
- `npm run start`: run the built extension in a temporary Firefox profile with `web-ext run` (build first).
- `npm run install-host`: register the native messaging host for Firefox (build first): writes a wrapper script that runs `dist/host/index.js --native-host` with the current Node binary (`~/.local/share/claude-firefox-extension/native-host` on Linux, `~/Library/Application Support/claude-firefox-extension/native-host` on macOS) and the manifest `claude_firefox_extension.json` (`~/.mozilla/native-messaging-hosts/` on Linux, `~/Library/Application Support/Mozilla/NativeMessagingHosts/` on macOS). On Windows it writes `native-host.bat` and `claude_firefox_extension.json` into `%LOCALAPPDATA%\claude-firefox-extension\` (restricted with `icacls` to the current user, SYSTEM and Administrators) and registers the manifest under `HKCU\Software\Mozilla\NativeMessagingHosts\claude_firefox_extension`. Prints the `claude mcp add` command. Snap and Flatpak Firefox are not supported.
- `npm run uninstall-host`: remove the manifest and the wrapper; on Windows also the registry key (the directory is kept while it still holds `bridge.json` or a running host holds it open).
- `npm run e2e`: end-to-end check against a real headless Firefox (build first). Installs the native host, loads the extension with the `web-ext` Node API in a temporary profile, waits for `bridge.json`, calls `tabs_context` through the MCP server (SDK default environment), checks that a tool request without the handshake is closed unanswered, runs a second Firefox for 40 s and requires 2 to 10 native host starts from it (counted by a `NODE_OPTIONS` preload) with `bridge.json` unchanged, stops the first Firefox and expects `bridge.json` removed and the not-connected error, then uninstalls. Prints a PASS/FAIL summary and exits non-zero on failure. It changes the native host registration of the environment it runs in, so it refuses to run unless `CI` is `true` or `1` or `--force` is passed (`npm run e2e -- --force`). A local `--force` run (no `CI`) is Linux only (refused on Windows and macOS, where the installer or the bridge uses locations outside `HOME`) and exits 2 unless `HOME` and `XDG_RUNTIME_DIR` are existing temporary directories strictly under `/tmp` (after resolving symlinks; `HOME` must not be, contain or lie inside the real home). It then sets `TMPDIR=/tmp` and `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and `XDG_STATE_HOME` inside the temporary `HOME` for itself, the installer, Firefox and the MCP server (whatever the shell sets is ignored), passes them and `XDG_RUNTIME_DIR` to the MCP server explicitly, asks the installer for its paths (`install-host.mjs --print-paths`, Linux and macOS only; it exits 1 on Windows), prints them and aborts before installing if any is outside the temporary `HOME` or reached through a symlink. Example: `RT=$(mktemp -d /tmp/cfe-rt-XXXX); H=$(mktemp -d /tmp/cfe-home-XXXX); HOME=$H XDG_RUNTIME_DIR=$RT npm run e2e -- --force`. `E2E_FIREFOX` overrides the Firefox binary.
- `claude mcp add firefox -- '<node>' '<abs path>/src/dist/host/index.js' --mcp` (double quotes on Windows): register the MCP server with Claude Code, once, using the exact command printed by `npm run install-host`.
