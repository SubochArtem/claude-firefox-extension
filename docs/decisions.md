# Design decisions

Details behind the one-line decisions in [`CLAUDE.md`](../CLAUDE.md).

## Bridge protocol

The bridge connects the MCP server processes (started by Claude Code over stdio) with the native host (started by Firefox through native messaging). The native host listens; every MCP server process connects to it. Messages are newline-delimited JSON; the host multiplexes clients by rewriting request ids to `<clientId>:<id>`.

### Endpoint on Linux and macOS

- A Unix domain socket `bridge.sock` in the first of:
  1. `$XDG_RUNTIME_DIR/claude-firefox-extension/`
  2. `/run/user/<uid>/claude-firefox-extension/` (Linux, if that runtime dir exists and is owned by the user)
  3. `/tmp/claude-firefox-extension-<uid>/` (literal `/tmp`, never `TMPDIR`)
- The order does not depend on variables Claude Code may strip from the MCP server's environment.
- Directory 0700 and socket 0600. Both processes `lstat` the directory and refuse it if it is a symlink, not a directory, not owned by the current uid, or has any group/other permission bits.

### Endpoint on Windows

- A named pipe with a random name `\\.\pipe\claude-firefox-extension-<32 hex>`, new at every host start (retried on `EADDRINUSE`).
- Node cannot put an ACL on the pipe, so the random name prevents squatting and the handshake keeps other users out.

### `bridge.json`

- Content `{version: 1, endpoint, secret, pid}`, mode 0600, written by the host after it listens: next to the socket on Linux and macOS, in `%LOCALAPPDATA%\claude-firefox-extension\` on Windows.
- The secret is 32 random bytes, new at every start.
- The file is replaced atomically (temp file + rename, retried on `EPERM`/`EBUSY` on Windows) and removed on exit only while it still describes this host; leftover temp files of the exiting host are removed too.
- The MCP server re-reads it on every (re)connect.
- `pid` is informational only and never used for liveness: on Linux and macOS liveness is a connect probe on the fixed socket path, on Windows it is the authenticated probe below.

### Second host on Windows

- Random pipe names never collide, so before writing `bridge.json` a new host reads the existing file and runs the full client handshake against its endpoint with its secret (1 s timeout, 4 KiB line cap, no proof sent before the host proof checks out, disconnect right after `ready`).
- If that host answers, the new one closes its pipe and exits 1 without touching `bridge.json`; a missing, invalid or unanswered file is replaced.
- Two hosts starting at the same instant can both pass the check; the last writer of `bridge.json` wins and the other host stays running but unreachable (narrow window; Firefox starts one host per extension connection).

### Handshake

- Every connection, on all platforms, runs a mutual HMAC-SHA256 handshake before any tool traffic: client `hello` with a nonce, host `hello` with its nonce and host proof, client `auth` with its proof, host `ready`.
- Proofs are HMAC over `label:clientNonce:serverNonce` keyed with the secret; the client checks the host proof before revealing its own.
- Either side closes on any other message before `ready`.

### Messages

- Extension and host: `ping` / `pong`; `tool_request` `{ id, tool, args, approvalViaClient? }` and `tool_response` `{ id, result | error }`; `permission_request` `{ requestId, callId, host, tool, action, canIncludeSubdomains }` from the extension and `permission_response` `{ requestId, answer, includeSubdomains }` back (`host/protocol.ts`, `extension/protocol.ts`).
- MCP server and host after `ready`: the same `tool_request`, `tool_response`, `permission_request` and `permission_response`, with ids rewritten to `<clientId>:<id>` on the extension side. The host sends a `permission_request` only to the client whose pending call is `callId` (with the client's own id); with no such call it answers deny at once, it drops answers from any other client and answers deny for the open requests of a client that disconnects. String fields of a permission request are limited to 1024 characters; a malformed request is dropped, a malformed answer to a known request is passed on as a deny.

### Limits

- Before `ready`: 2 s from connect, at most 8 unauthenticated connections on the host, 4 KiB per line on the host.
- After `ready`: 64 MB per line.
- Tool calls: the MCP server answers with a timeout after 150 s (`TOOL_REQUEST_TIMEOUT_MS` in `host/protocol.ts`: the 120 s permission prompt timeout plus 30 s for the action after it); the native host frees a request the extension never answers 5 s later, so the MCP side reports first. The host keeps its own copy of the prompt timeout, and an extension test checks that it matches.

### Startup buffering and reconnect backoff

- The native host processes no native message before it has decided to serve (listening, second-host check passed, `bridge.json` written); earlier messages are buffered and replayed in order, and a host that exits before that writes nothing to stdout.
- The extension resets its reconnect backoff only after a connection has stayed up for 10 s after its pong, so a host that answers and exits right away cannot make it retry every second.

## Windows installer

Windows support is required. `feature/windows-support` delivered the authenticated bridge above and the Windows installer (`scripts/install-host.mjs`, logic in `scripts/install-host-lib.mjs`).

### Install

1. Create `%LOCALAPPDATA%\claude-firefox-extension\` and harden it with `icacls` while it is still empty: inheritance removed, full control for the current user's SID, SYSTEM and Administrators only.
2. Write `native-host.bat` (CRLF; `@echo off`, `setlocal DisableDelayedExpansion`, `chcp 65001`, then the quoted Node binary and host entry with `--native-host %*`) and `claude_firefox_extension.json`, both UTF-8.
3. Register the manifest last as the default value of `HKCU\Software\Mozilla\NativeMessagingHosts\claude_firefox_extension` with `reg.exe /reg:64`.

If writing or registration fails, files that existed before the run get their previous content back (an older registry entry may still point at them) and new ones are removed.

### Uninstall

- Deletes the registry key first and keeps the files if `reg.exe` fails or cannot run.
- Keeps the directory while it still holds `bridge.json` or a running host holds it open (`EBUSY`).

### System tools

`whoami.exe`, `icacls.exe` and `reg.exe` are run by their absolute `%SystemRoot%\System32` path without a shell.

### Accepted edge cases (checked manually on Windows)

- With delayed expansion enabled globally in the registry, cmd leaves a single `!` in the `.bat` path alone and only mangles it when two `!` enclose the name of a defined variable, which practically never happens in a profile path.
- Firefox starts `cmd.exe /s/c "<bat> <manifest> <id>"` without quoting the `.bat` path when it has no spaces, so an install path with `&` or `^` and no space cannot be started (confirmed); the installer prints a warning for it.
- Only `&` and `^` were verified for the unquoted `.bat` path; other cmd metacharacters (`,`, `;`, `=`, `%name%`) are untested.

## Threat model

- **Protected**: other OS users on the same machine and the network cannot use or impersonate the bridge (private socket directory or user-only `%LOCALAPPDATA%`, random pipe name on Windows, per-start secret, mutual HMAC handshake, caps and timeouts). The browser to native host link is protected by Firefox native messaging (`allowed_extensions`).
- **Trusted**: any process running as the same OS user (it can read `bridge.json` and drive the browser); Administrators, SYSTEM and root. Same as other local browser-automation bridges.
- **Windows pipe access**: pipe names are enumerable by any user, but the default pipe DACL (verified: Everyone and ANONYMOUS LOGON read only; SYSTEM, Administrators and the owner full control) keeps another standard user from opening the pipe for read/write or adding an instance (verified with a second account). Keeping all unauthenticated connection slots busy is therefore only possible for processes that can already open the pipe; it would be denial of service only, nothing can be read or forged. Remote clients are not tested; they would need write access too.
- **Before distribution**: the extension id `claude-firefox-extension@localhost` is not reserved; another add-on with the same id signed on addons.mozilla.org could reach the native host if installed. Fixed by `feature/amo-signing`.
- **Next major risk**: prompt injection from page content once page-reading and JavaScript tools exist. Addressed by `feature/permissions` ([Permissions](#permissions): per-site approval of every action, agent tabs in a dedicated container by default so the agent is not signed in to the user's accounts), which must land before `feature/accessibility-tree` and `feature/devtools-tools`. Enforcement in the tools, the approval prompts (MCP elicitation, popup fallback) and the agent container are in place.
- **Known, accepted for now**: `navigate` and `tabs_close` work on any tab, including tabs the user is working in; a misled agent can navigate them away or close them. This stays by design: the agent may act on any tab, but once `feature/permissions` is enforced, every action on a site needs that site's permission. Until then no check is made.

## Tool behavior

- `navigation-input.ts`: pure argument validation for `navigate`, `tabs_create`, `tabs_close`: http(s)-only URL normalization, no userinfo or control characters, `back`/`forward`, positive `tabId`.
- `navigate.ts`: uses `tabs.update`/`goBack`/`goForward` and waits on `webNavigation` events for load, same-document change, download, network error, closed tab or timeout (2 s for the navigation to start, 20 s total).
- `navigate.ts` ignores `about:blank` events while waiting for an http(s) url: Firefox reports the `about:blank` load of a tab created by `tabs.create` after the call has resolved.
- `tabs.ts`: `tabs_create` opens a background tab (`about:blank`, `active: false`) in the last focused window, which must be a normal one (Firefox ignores the `windowTypes` filter of `windows.getLastFocused`, so its type is checked); with a url it loads it through navigate's waiting and keeps the tab open if the load fails.
- `tabs.ts`: `tabs_close` closes only tabs of normal windows, refuses the last tab of the last normal window (closing it would close the window and may quit Firefox), and reports success only after the tab is gone (`tabs.onRemoved` or `tabs.get` failing, 5 s timeout, e.g. for a `beforeunload` prompt).
- `windows.get` and `windows.getLastFocused` need no manifest permission.
- `tool-error.ts`: `ToolError` marks an expected failure whose message reaches the agent without the generic prefix.

## Screenshots

- One `computer` tool carries all page interaction; its `action` enum grows per feature (`screenshot` and `zoom` now, click, type, key and scroll with `feature/bidi-input`), and the host schema and the extension parser offer the same actions.
- `computer.ts` captures with `tabs.captureTab`, which renders a background tab without activating it, so the user's view is not switched; `captureVisibleTab` would need the tab in front. The viewport (`innerWidth`, `innerHeight`, `devicePixelRatio`) is read with `scripting.executeScript`, and `captureTab`'s `scale` (image pixels per CSS pixel) is set so the capture comes out at about the output size.
- Token budget: about 28 px per token per side, at most 1568 px on a side and 1568 tokens per image. The viewport is fitted into that frame (`screenshot-size.ts`); the agent's `scale` shrinks only the returned image, and coordinates always refer to the frame, which is recorded per tab (`coordinate-frame.ts`) and forgotten on `tabs.onRemoved`.
- JPEG: captured at quality 0.75; if the capture is not the output size or its base64 is longer than 1,398,100 characters (about 1 MB), it is redrawn on an `OffscreenCanvas` and re-encoded, stepping the quality down by 0.05 to a floor of 0.1. The bridge limits (64 MB per line and native message from the extension) need no change.
- Permissions: `scripting` and `host_permissions: ["<all_urls>"]` (`captureTab` requires `<all_urls>`). Firefox MV3 host permissions are opt-in: until `feature/permissions`, the user grants them in about:addons (extension, Permissions, "Access your data for all websites"); without them the tool says so. A temporary install (web-ext, e2e) gets them granted.
- Zoom: `action: "zoom"` takes `region` [x0, y0, x1, y1] in the tab's last screenshot frame (a screenshot is required first). The region is mapped to viewport CSS pixels with the same 2 px edge tolerance as other coordinates and checked against the viewport read again at zoom time; a region outside it asks for a new screenshot. `captureTab` renders only that area through `rect`, which is relative to the document, so the current `scrollX`/`scrollY` are added. The output is the region at device pixels fitted into the same token budget, then multiplied by `scale`, with the same JPEG quality stepping. Zoom does not change the recorded frame, so later coordinates still refer to the last screenshot.
- Only http(s) pages are captured: `file:`, `about:`, other extensions' pages and every other scheme are refused by the site permission gate, since site permissions only cover http(s) ([Permissions](#permissions)).
- Mozilla's restricted domains (addons.mozilla.org and the others in `extensions.webextensions.restrictedDomains`) are refused before the site permission check, so the user is not asked about a page that cannot be captured; reader view, the PDF viewer and other pages Firefox refuses at capture time are reported with the same message.

## Permissions

- Scope: the agent may act on any tab, but every action on a page is checked against a per-site permission first. Permissions are host-level (port ignored, lowercase, trailing dot and a leading `www.` stripped), optionally with a wildcard covering all subdomains. One record covers every action type on its host; the prompt names the action type (`navigate`, `read_page_content`, `click`, `type`, `execute_javascript`, `read_console_messages`, `read_network_requests`). Current tools map as `navigate`, `tabs_create` with a url and `tabs_close` to `navigate`, `computer` screenshot and zoom to `read_page_content` (`permissions/actions.ts`).
- Only `http:` and `https:` URLs are subject to site permissions; every other scheme (`about:`, `moz-extension:`, `file:`, `view-source:`, `resource:`, `data:`, `javascript:`, `chrome:`) and invalid URLs are refused with an "unsupported URL" outcome (`permissions/site.ts`).
- Records (`permissions/permission-model.ts`): `{ id, host, wildcard, decision: allow | deny, duration: once | always, toolUseId (once only), createdAt, lastUsed }`, stored as an array under the `browser.storage.local` key `permissionStorage` (`permissions/permission-store.ts`); data read from storage is validated and malformed records are dropped. Changes are serialized so concurrent checks and grants do not overwrite each other.
- Check order: unsupported URL is refused; a matching deny record denies (deny wins over any allow); an allow-once record for the same tool call (`toolUseId`) and host allows and is consumed; a matching allow-always record allows and updates `lastUsed`; otherwise the user is prompted. Deny-once is never stored. Checks have no time-based expiry.
- Wildcards are refused on single-label hosts (`com`, `localhost`) and IP addresses; exact records on them are allowed. A leading `www.` is only stripped when the rest still contains a dot, so `www.com` stays `www.com`.
- Allow-once records are normally consumed by their own tool call; one that never matched would stay forever, so adding a record prunes allow-once records older than 10 minutes.
- Approval prompt: MCP elicitation in Claude Code when the client declared the `elicitation` capability (form mode), otherwise an extension popup window (`windows.create` with `type: "popup"`). Closing the popup or a timeout of about 120 s counts as deny. Prompts are serialized, one at a time.
- Elicitation: the MCP server sets `approvalViaClient: true` on a tool request only when its client supports form elicitation; the extension picks the prompt per call by that flag (`approvalPromptFor` in `permissions/site-access.ts`), with no fallback to the popup after a failed elicitation. The extension's client prompt (`permissions/client-prompt.ts`) sends a `permission_request` with a random `requestId` and the call id over the native port; 120 s without an answer, a closed port, an unsendable request or an invalid answer is deny once, and unknown or late answers are dropped. The MCP server answers only requests for calls pending in its own process and flagged for the client, by `elicitInput` with a form: `decision` (`allow_once`, `allow_always`, `deny`, `deny_always`) and `includeSubdomains` (only when the host can have a wildcard), 120 s timeout. Decline, cancel, an error, a timeout or an unknown decision is deny once. When the tool call ends first the question is withdrawn (`notifications/cancelled`) and a late answer is ignored. The SDK ignores cancellation of request id 0, so the server sends a `ping` after initialization to use that id up.
- Agent container: tabs opened by `tabs_create` go into a dedicated "Claude" container (separate cookies and logins) by default; the setting `{ agentTabs: "container" | "default" }` under the `storage.local` key `settings` (`settings.ts`, invalid or missing data reads as `container`) switches to the normal profile. No per-domain mixing; `navigate`, `tabs_close` and `computer` act on any tab whatever its container. `permissions/agent-container.ts` reuses the container whose `cookieStoreId` is stored under `agentContainer` while `contextualIdentities.get` still finds it (even if renamed), else adopts one named "Claude", else creates it (orange, `circle` icon); concurrent resolutions share one promise, so parallel calls create one container. The container is resolved before the permission prompt. When the `contextualIdentities` API is missing or rejects (the user turned off `privacy.userContext.enabled`; installing the extension turns it on), `tabs_create` fails with a message asking the user to enable container tabs or switch to the normal profile; there is no silent fallback. Containers do not exist in private windows, so a container tab skips private windows when picking its window and fails with a message (open a regular window or switch to the normal profile) when only private windows are open. Manifest permissions: `contextualIdentities`, and `cookies`, which `tabs.create` requires for `cookieStoreId`.
- Options page (`options/options.html`, `options_ui`, shown in about:addons): the agent tabs switch (container or normal profile) and the stored site permissions (site with `*.` for a wildcard, allow or deny, once or always, created, last used) with a Revoke button each, refreshed on `storage.local.onChanged`. Stored data is rendered with `textContent` only. Revoke is a `runtime` message to the background (accepted only from this extension's options page URL), so it goes through the same serialized store as checks and grants and cannot be undone by a concurrent write.
- No semantic detection of sensitive actions (purchases, sending messages, deleting data), same as Claude in Chrome; may be revisited with click and type in `feature/bidi-input`.
- Enforcement (`permissions/site-access.ts`): every tool calls `requireSiteAccess` before it acts on a site. `navigate` with a url and `tabs_create` with a url check the destination (before a tab is created); `computer` screenshot and zoom check the target tab's current URL; `tabs_close` checks http(s) tabs and closes tabs without a site (new tab page, `about:blank`) without a check. Non-http(s) URLs are refused. `navigate` back and forward cannot know the destination up front and are checked after landing.
- Redirects: after `navigate` or `tabs_create` completes, the final URL is checked again without prompting (the host approved for this call or a stored allow). On any other host the result carries no title, URL or tabs context, only a note that the tab landed on an unapproved host; the next action on that tab prompts.
- Prompt (`permissions/popup-prompt.ts`, page `permissions/prompt.html`): behind the `ApprovalPrompt` interface (`requestApproval(request) -> decision`, `permissions/approval.ts`), shared with the client prompt. A focused `type: "popup"` window of 480x420 shows the host, the action type and the tool, with Allow once, Always allow this site, Deny, Always deny this site, and an "include subdomains" checkbox only when the host can have a wildcard. The page asks the background for the pending request by a random id in its URL and answers by `runtime.sendMessage`; the background accepts both only from its own extension and from the exact page URL it opened. Allow once lets the current call proceed and stores nothing; the always answers store a record. Closing the window denies, 120 s without an answer denies with its own message, and a window that cannot be opened is an error. Prompts are serialized in the gate, and a queued request checks the stored records again when its turn comes.
- Agent-facing refusals: denied by the user (do not look for workarounds, ask the user how to proceed), no answer within 120 s (ask the user to answer the prompt window in Firefox), blocked by the user's site settings (a stored deny).
- The host's tool request timeout (150 s, [Limits](#limits)) exceeds the prompt timeout plus the longest tool wait after it (20 s navigation), so the agent receives the tool's own answer. Prompts are serialized, so a call queued behind another open prompt can still hit the host timeout; an answer given after that still applies (an always answer is stored and the action runs).
- Re-checks after the prompt: `computer` screenshot and zoom read the tab again after the permission check and after the capture, and refuse (discarding the image) when the tab's host is no longer the approved one, since the tab may navigate while the prompt is open or during the capture.
- `tabs_context` (also appended to `navigate`, `tabs_create` and `tabs_close` results) reads the stored records without prompting: an http(s) tab whose host has no allow (and is not the host approved for the current call) is listed with its origin only and `unapproved: true`, without title or path; tabs outside http(s) are listed as they are. A `navigate` or `tabs_create` download result likewise shows the page the tab stays on by its origin, marked as an unapproved host, when that host is not approved.
- Status: enforcement, the `storage` permission, the popup prompt, MCP elicitation, the agent container and the options page are wired.

## Native host installation paths

`npm run install-host` writes a wrapper script that runs `dist/host/index.js --native-host` with the current Node binary, and the manifest `claude_firefox_extension.json`:

| OS | Wrapper | Manifest |
|---|---|---|
| Linux | `~/.local/share/claude-firefox-extension/native-host` | `~/.mozilla/native-messaging-hosts/` |
| macOS | `~/Library/Application Support/claude-firefox-extension/native-host` | `~/Library/Application Support/Mozilla/NativeMessagingHosts/` |
| Windows | `%LOCALAPPDATA%\claude-firefox-extension\native-host.bat` | `%LOCALAPPDATA%\claude-firefox-extension\claude_firefox_extension.json`, registered under `HKCU\Software\Mozilla\NativeMessagingHosts\claude_firefox_extension` |

On Windows the directory is restricted with `icacls` (see Windows installer). The installer prints the `claude mcp add` command. Snap and Flatpak Firefox are not supported.

`npm run uninstall-host` removes the manifest and the wrapper; on Windows also the registry key (the directory is kept while it still holds `bridge.json` or a running host holds it open).

## Testing approach

TDD where it fits: logic with a spec known up front (protocols, framing, multiplexing, parsing, accessibility tree and `ref_N` resolution, argument validation, `computer` to BiDi translation) gets tests first, reviewed, then the implementation; code that depends on real Firefox behavior (native messaging lifecycle, event page suspension, `captureVisibleTab`, permissions, BiDi) is written first, then covered by tests and a check in a real Firefox.

## Tests

- `npm test` needs no build, Firefox or network; it uses temp dirs under `/tmp`, never the real bridge socket directory or `~/.mozilla`.
- Vitest projects: extension, host (bundles the host once in a global setup), scripts.
- `extension/test/`: unit tests with a mocked `browser` global (`browser-mock.ts`); not copied into `dist`. `manifest.test.ts` checks the permissions the tools need.
- `host/test/`: unit tests, process tests against the bundled host, in-process timeout tests with fake timers. `helpers.ts` provides temp dirs under `/tmp`, endpoints as Unix sockets or Windows pipes from `bridge.json`, a fake extension and a bridge client; `global-setup.ts` bundles the host.
- `scripts/test/`: installer tests (run a copy of the installer against a temp `HOME`) and e2e safety tests.

## CI

`.github/workflows/ci.yml` runs GitHub Actions on Linux, Windows and macOS (Node 24): `npm ci`, typecheck, build, lint, test. Then an e2e job per OS (needs test): installs the current Firefox release from Mozilla's official downloads into `RUNNER_TEMP`, prints its version, `npm ci`, build, `npm run e2e` with `E2E_FIREFOX`.

## E2E

### What it checks

`npm run e2e` (build first) runs against a real headless Firefox:

1. Installs the native host.
2. Loads a temporary copy of the built extension with the `web-ext` Node API in a temporary profile and waits for `bridge.json`. Nobody can answer a permission prompt in headless CI, so the copy gets an extra first background script that stores an always-allow record for `127.0.0.1` and an always-deny record for `localhost`; the built extension itself has no other way to grant a permission than the user's answer.
3. Calls `tabs_context` through the MCP server (SDK default environment).
4. Opens a tab with `tabs_create` on a page served by the script on `127.0.0.1` and a blank one, checks each appears in `tabs_context`, closes it with `tabs_close` and checks it is gone; then checks that `tabs_create` on the denied `localhost` is refused without opening a tab.
5. Takes a `computer` screenshot of a background tab on that page, checks the JPEG image block and that the tab stayed inactive.
6. Checks that a tool request without the handshake is closed unanswered.
7. Runs a second Firefox for 40 s and requires 2 to 10 native host starts from it (counted by a `NODE_OPTIONS` preload) with `bridge.json` unchanged.
8. Stops the first Firefox and expects `bridge.json` removed and the not-connected error.
9. Uninstalls.

It prints a PASS/FAIL summary and exits non-zero on failure. `E2E_FIREFOX` overrides the Firefox binary.

### Isolation of local runs

- The e2e run changes the native host registration of the environment it runs in, so it refuses to run unless `CI` is `true` or `1` or `--force` is passed (`npm run e2e -- --force`).
- A local `--force` run (no `CI`) is Linux only: refused on Windows and macOS, where the installer or the bridge uses locations outside `HOME`.
- It exits 2 unless `HOME` and `XDG_RUNTIME_DIR` are existing temporary directories strictly under `/tmp` (after resolving symlinks; `HOME` must not be, contain or lie inside the real home). These checks live in `scripts/e2e-safety.mjs` (pure, tested).
- It then sets `TMPDIR=/tmp` and `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and `XDG_STATE_HOME` inside the temporary `HOME` for itself, the installer, Firefox and the MCP server (whatever the shell sets is ignored), and passes them and `XDG_RUNTIME_DIR` to the MCP server explicitly.
- It asks the installer for its paths (`install-host.mjs --print-paths`, Linux and macOS only; it exits 1 on Windows), prints them and aborts before installing if any is outside the temporary `HOME` or reached through a symlink.

Example:

```sh
RT=$(mktemp -d /tmp/cfe-rt-XXXX); H=$(mktemp -d /tmp/cfe-home-XXXX); HOME=$H XDG_RUNTIME_DIR=$RT npm run e2e -- --force
```
