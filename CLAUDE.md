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
- **Extension**: tabs, screenshots (`tabs.captureTab`), script execution (`scripting.executeScript`), network (`webRequest`), console capture, accessibility tree built from the DOM with `ref_N` element references.
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
- Screenshots: one `computer` tool whose action enum grows per feature; `tabs.captureTab` without activating the tab, fitted to 1568 px / 1568 tokens, JPEG quality stepped down to fit about 1 MB; `<all_urls>` granted manually in about:addons until `feature/permissions`; see [Screenshots](docs/decisions.md#screenshots).
- Tab scope: the agent may navigate and close any tab in any normal window (user decision); with `feature/permissions` every action on a site is checked against that site's permission.
- Permissions: per-site (host, optional subdomain wildcard) allow/deny once/always records in `storage.local`, deny wins, only http(s) URLs; agent tabs in a "Claude" container by default; see [Permissions](docs/decisions.md#permissions).
- Input: WebDriver BiDi `input.performActions` run by the native host, with a fallback to synthetic DOM events (`isTrusted=false`, the result carries a warning) only when the host reports BiDi itself unavailable (closed or non-BiDi port, refused `session.new`, tab's context not found), never for other input errors or a lost native port; the user starts Firefox with `--remote-debugging-port` (9222, override with `CLAUDE_FIREFOX_BIDI_PORT` in Firefox's environment); one BiDi session per request with `session.end` always sent; tab to context through a random marker set in the page's main world; background tabs are not activated, except by `scroll` (Firefox ignores wheel scrolling in background tabs); see [Input](docs/decisions.md#input-webdriver-bidi).
- Accessibility tree: DOM heuristics (extensions have no accessibility API), top frame only, open shadow roots walked, hidden elements always excluded, `ref_N` refs in an isolated-world WeakRef registry that lives until the document unloads, `find` searches the tree locally, happy-dom for DOM tests; see [Accessibility tree](docs/decisions.md#accessibility-tree).
- DevTools tools: `resize_window` resizes normal windows only, with no site permission, resets the window state to normal and reports the actual size; `javascript_tool` runs through BiDi `script.evaluate` in the page's main realm (bypasses page CSP), falling back to `scripting.executeScript` in the MAIN world only when BiDi is unavailable, behind an `execute_javascript` site permission; console and network capture start per tab on the first read call; see [DevTools tools](docs/decisions.md#devtools-tools).
- Tests: Vitest, `npm test` from `src/`; every feature ships with its own automated tests.
- TDD where it fits: tests first for logic with a spec known up front, tests after for code that depends on real Firefox behavior; see [Testing approach](docs/decisions.md#testing-approach).
- Windows support is required: hardened `%LOCALAPPDATA%` directory, `.bat` wrapper and `HKCU` registration with rollback; see [Windows installer](docs/decisions.md#windows-installer).

## Threat model

Full text: [Threat model](docs/decisions.md#threat-model).

- Protected: other OS users and the network cannot use or impersonate the bridge; the browser to host link is protected by native messaging `allowed_extensions`.
- Trusted: any process of the same OS user, Administrators, SYSTEM and root.
- Before distribution: the extension id is not reserved on AMO; fixed by `feature/amo-signing`.
- Next major risk: prompt injection from page content; `feature/permissions` must land before `feature/accessibility-tree` and `feature/devtools-tools`.
- Accepted: the `--remote-debugging-port` endpoint is unauthenticated and reachable by any local process, including other OS users; with the flag Firefox shows the robot icon and striped URL bar and sets `navigator.webdriver=true` on every page even without a session.
- Accepted by design: `navigate` and `tabs_close` work on any tab, including the user's; every action on a site needs that site's permission (enforced since `feature/permissions-prompt`).

## Roadmap

Each feature is delivered as a series of small pull requests, one coherent part each, on branches `feature/<feature>-<part>` from the updated `main`. The feature's last pull request marks it `[x]` here.

- [x] `feature/project-setup`: `package.json`, `tsconfig`, `web-ext`, build, folder structure; fill in Repository layout and Commands below.
- [x] `feature/extension-skeleton`: Firefox MV3 `manifest.json` and background script; the extension loads without errors.
- [x] `feature/native-bridge`: native host + MCP server, end-to-end on the first tool `tabs_context`; install/registration of the native messaging manifest.
- [x] `feature/tests`: Vitest setup and `npm test`; tests for the existing host (native messaging framing, JSON lines, client multiplexing, timeouts, socket directory checks, MCP server against a fake extension) and the extension tool registry / `tabs_context` with a mocked `browser.*`.
- [x] `feature/windows-support`: named pipe with a random name per host start plus the authenticated bridge handshake, installer writing `HKCU\Software\Mozilla\NativeMessagingHosts\claude_firefox_extension` and a `.bat` wrapper, Windows paths in host and scripts.
- [ ] `feature/amo-signing`: reserve a real extension id on AMO, sign with `web-ext sign` (unlisted), permanent install in release Firefox, verify `runtime.onStartup` reconnect. Needs the user's AMO account and API keys; timing decided separately.
- [x] `feature/navigate`: `navigate`, `tabs_create`, `tabs_close`.
- [x] `feature/screenshot`: screenshots and zoom via `tabs.captureTab`.
- [x] `feature/permissions`: permission layer against prompt injection (per-site approval, confirmation of sensitive actions); user choice between a dedicated agent container (`contextualIdentities`, isolated cookies and logins) and the normal profile, with default, switch location and per-domain mixing decided at the start; design after researching how Claude in Chrome does it.
- [x] `feature/accessibility-tree`: DOM-based tree with `ref_N` references; `read_page`, `find`, `get_page_text`.
- [x] `feature/bidi-input`: `computer` tool (click, type, key, scroll) through WebDriver BiDi; `form_input`.
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
  scripts/build.mjs    esbuild bundling of extension/ (background, pages, injected page/read-page.js and page/page-text.js) into dist/extension and host/ into dist/host
  scripts/install-host.mjs  installs/uninstalls the native messaging manifest and host wrapper (Linux, macOS, Windows)
  scripts/install-host-lib.mjs  Windows installer logic: paths, .bat wrapper, icacls/reg/whoami arguments and flows; remote debugging start note
  scripts/e2e.mjs      end-to-end check in a real headless Firefox (npm run e2e), loads a copy of the extension with seeded site permissions
  scripts/e2e-safety.mjs  checks that confine a local e2e run to a temporary HOME (pure, tested)
  scripts/test/        installer tests (against a temp HOME), e2e safety tests
  extension/           Firefox extension sources: manifest.json, background script, content scripts, static assets
    tsconfig.json      extension type check (DOM + WebExtension types, no Node), test/ included
    test/              unit tests with a mocked `browser` global (browser-mock.ts), manifest permission checks, happy-dom tests for page/
    settings.ts        extension settings in storage.local (agent tabs: Claude container or normal profile), validated loader
    options/           options page (about:addons): agent tabs switch, stored site permissions with Revoke
      options.html, options.ts  the page: renders with textContent, live refresh on storage changes
      options-view.ts  pure rows for the permission list
      options-messages.ts  background handler for revoke requests from the options page
    page/              code that runs inside the page, in the isolated world of the top frame (no browser.* calls)
      ref-registry.ts  ref_N ids: WeakRef per ref, element -> ref WeakMap, sweep, resolve (found, not found, gone)
      element-role.ts  role from the role attribute or the tag, interactive check, heading level
      accessible-name.ts  accessible name, visible text, sensitive field check, text clipping and quote escaping
      accessibility-tree.ts  tree builder: visibility, filters, depth, element cap, max chars, ref_id subtree; walker of the tree's elements for find
      find-elements.ts  find search: query words and role words, scoring tiers, top 20 lines with refs
      find-api.ts      find entry point name and result types shared with the tool
      form-input.ts    form_input in the page: resolves the ref, validates the value per element type, sets it through native setters, fires input/change, redacts sensitive fields
      form-input-api.ts  form_input entry point name, value and result types shared with the tool
      element-point.ts  ref target for pointer actions: resolves the ref, scrolls it into view (centered, instant), returns its center in viewport CSS pixels
      element-point-api.ts  element point entry point name, options and result types shared with the computer tool
      synthetic-input.ts  fallback input in the page: synthetic pointer, mouse, wheel, keyboard and input events with the default actions that matter (focus, scrolling, text insertion, Enter submit, Backspace/Delete, Tab focus, select all)
      synthetic-input-api.ts  synthetic input entry point name, options and result types shared with the computer tool
      read-page.ts     entry of the injected bundle dist/extension/page/read-page.js: installs the read_page, find, form_input, element point and synthetic input entry points once per document, sharing one ref registry
      read-page-api.ts  entry point name, script path and result types shared with the tool
      main-text.ts     page text: content root selection, whitespace normalisation, truncation
      page-text.ts     entry of the injected bundle dist/extension/page/page-text.js: installs the get_page_text entry point once per document
      page-text-api.ts  entry point name, script path and result types shared with the tool
      main-world-eval.ts  javascript_tool fallback injected as a func in the page's MAIN world: CSP check, indirect eval with an async rerun for top-level await/return, result serialized to the BiDi RemoteValue shape
    permissions/       site permissions: model, storage, enforcement gate, approval prompt
      actions.ts       permission action types and the mapping from tool calls
      site.ts          http(s)-only URL to host normalization, host and wildcard matching
      permission-model.ts  permission records, pure check (deny wins, allow-once consumed), stored data validation
      permission-store.ts  records in storage.local under permissionStorage: load, add, revoke, clear, check
      agent-container.ts  finds, adopts or creates the "Claude" container for agent tabs, one resolution at a time
      site-access.ts   gate used by the tools: requireSiteAccess (check, prompt, store), landedSite (redirect re-check), approvalPromptFor
      approval.ts      ApprovalPrompt interface (requestApproval -> decision), prompt messages and answer parsing
      popup-prompt.ts  popup window prompt: windows.create, pending requests, runtime messages, close and 120 s timeout
      client-prompt.ts  prompt answered in the MCP client (elicitation) over the native port, used for flagged calls; deny on timeout or disconnect
      prompt.html, prompt.ts  the prompt page: host, action, tool, code preview, allow/deny once/always, include subdomains
    tools/             tool handlers and registry (index.ts)
      navigation-input.ts  pure argument validation for navigate, tabs_create, tabs_close
      computer-input.ts  pure argument validation for the computer tool (screenshot, zoom, clicks, hover, drag, scroll, scroll_to, type, key, wait)
      screenshot-size.ts  screenshot frame and output sizes within the image token budget
      coordinate-frame.ts  per-tab last screenshot frame (shared screenshotFrames), maps frame coordinates to viewport CSS pixels
      navigate.ts      navigate tool: tabs.update/goBack/goForward, waits on webNavigation events
      tabs.ts          tabs_create and tabs_close tools
      computer.ts      computer tool: screenshot and zoom (tabs.captureTab, JPEG resize and quality stepping, coordinate frames), wait, dispatch of pointer and keyboard actions, screenshot after scroll
      computer-pointer.ts  pointer actions of the computer tool: site gate, frame or ref targets, BiDi input with the synthetic fallback when BiDi is unavailable, landed-site re-check after the input
      computer-keys.ts  type and key actions of the computer tool: zoom shortcuts refused, reload shortcuts through tabs.reload, other keys and typed text as BiDi input behind the type permission
      input-keys.ts    key text parsing: WebDriver key values, chords and modifier aliases, typed text to key values, page zoom and reload shortcut detection
      input-actions.ts  WebDriver BiDi input.performActions sources for key, type, click, hover, drag and scroll, modifiers held tick-aligned with the pointer
      bidi-input.ts    performInput: marks the tab in the page's main world (withTabMarker), asks the native host to run BiDi input, removes the marker, throws BidiUnavailableError when the host reports BiDi unavailable; generic request channel over the native port and the input channel
      bidi-evaluate.ts  evaluateInTab and the evaluate channel: marks the tab, asks the native host to run script.evaluate, returns the formatted value or exception
      synthetic-input.ts  synthetic input fallback: runs the page entry after the same-site check, DOM key names and modifier flags, the fallback warning
      read-page-input.ts  pure argument validation for read_page
      read-page.ts     read_page tool: options, result check and output on top of page-script.ts
      page-script.ts   shared runner for page bundles: site gate for the tool's action (openTabPage), landed-site re-checks, injects the bundle only when missing (runOnTabPage; changeTabPage for input, checked by the caller), restricted page and timeout errors
      page-text-input.ts  pure argument validation for get_page_text
      page-text.ts     get_page_text tool: title, URL, source element and text of the page
      find-input.ts    pure argument validation for find
      find.ts          find tool: runs the find entry point of the read_page bundle on top of page-script.ts
      form-input-input.ts  pure argument validation for form_input
      form-input.ts    form_input tool: runs the form_input entry point of the read_page bundle behind the type permission
      resize-window-input.ts  pure argument validation for resize_window: sizes floored, 1 to 7680x4320
      resize-window.ts  resize_window tool: windows.update of the tab's normal window (state reset to normal), reports requested and actual size
      javascript-input.ts  pure argument validation for javascript_tool: action javascript_exec, code up to 100,000 characters
      javascript.ts    javascript_tool: execute_javascript gate with a code preview, BiDi evaluate, MAIN-world eval fallback only when BiDi is unavailable (formatted with host/remote-value-format.ts), result withheld when the tab left for an unapproved site
      tab-access.ts    shared tab helpers for page tools: resolve the target tab, restricted domains, permission and restricted page messages
      tool-error.ts    ToolError: expected failure whose message reaches the agent without the generic prefix
  host/                native messaging host + MCP server, one entry point
    tsconfig.json      host type check (Node types, no DOM), test/ included
    test/              unit, process and fake-timer tests; helpers.ts (temp dirs, endpoints, fake extension), fake-bidi.ts (WebDriver BiDi WebSocket server), global-setup.ts
    index.ts           dispatches by flag: --native-host or --mcp
    protocol.ts        message types for both channels, shared constants
    socket-path.ts     bridge socket path resolution and permissions; random pipe names on Windows
    bridge-info.ts     bridge.json location, atomic write, validated read, removal on exit
    handshake.ts       bridge handshake: nonces, HMAC proofs, message parsers, limits, client side on a socket
    host-probe.ts      authenticated liveness probe of the host named in bridge.json (Windows second-host check)
    bidi-client.ts     WebDriver BiDi WebSocket client: port from CLAUDE_FIREFOX_BIDI_PORT, commands with timeouts, connection error messages
    bidi-session.ts    one BiDi session per request: finds the marked tab's context, runs the request, optional release and session.end in finally; serial queue shared by input and evaluate
    bidi-input.ts      input requests: input.performActions in the marked context, input.releaseActions after it
    bidi-evaluate.ts   evaluate requests: script.evaluate in the marked context's main realm, async re-run for top-level await/return, 30 s script deadline, exception text with stack
    remote-value-format.ts  BiDi RemoteValue to readable text: containers, nodes, references, depth cut-offs, best-effort redaction, 50 KB cap
    listen.ts          listen on an endpoint, retrying fresh endpoints on EADDRINUSE
    json-lines.ts      newline-delimited JSON framing on the bridge socket
    native-messaging.ts  Firefox native messaging stdio framing
    native-host.ts     native host: talks to the extension, listens on the bridge socket, multiplexes clients, routes permission requests, runs BiDi input requests
    mcp-server.ts      MCP server over stdio: registers tools, forwards calls to the native host, asks permissions by elicitation
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
