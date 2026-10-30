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

### Limits

- Before `ready`: 2 s from connect, at most 8 unauthenticated connections on the host, 4 KiB per line on the host.
- After `ready`: 64 MB per line.

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
- **Next major risk**: prompt injection from page content once page-reading and JavaScript tools exist. Addressed by `feature/permissions` (per-site approval, confirmation of sensitive actions, optional agent container so the agent is not signed in to the user's accounts), which must land before `feature/accessibility-tree` and `feature/devtools-tools`.
- **Known, accepted for now**: `navigate` and `tabs_close` work on any tab, including tabs the user is working in; a misled agent can navigate them away or close them. Accepted until `feature/permissions` scopes the agent's tabs.

## Tool behavior

- `navigation-input.ts`: pure argument validation for `navigate`, `tabs_create`, `tabs_close`: http(s)-only URL normalization, no userinfo or control characters, `back`/`forward`, positive `tabId`.
- `navigate.ts`: uses `tabs.update`/`goBack`/`goForward` and waits on `webNavigation` events for load, same-document change, download, network error, closed tab or timeout (2 s for the navigation to start, 20 s total).
- `navigate.ts` ignores `about:blank` events while waiting for an http(s) url: Firefox reports the `about:blank` load of a tab created by `tabs.create` after the call has resolved.
- `tabs.ts`: `tabs_create` opens a background tab (`about:blank`, `active: false`) in the last focused window, which must be a normal one (Firefox ignores the `windowTypes` filter of `windows.getLastFocused`, so its type is checked); with a url it loads it through navigate's waiting and keeps the tab open if the load fails.
- `tabs.ts`: `tabs_close` closes only tabs of normal windows, refuses the last tab of the last normal window (closing it would close the window and may quit Firefox), and reports success only after the tab is gone (`tabs.onRemoved` or `tabs.get` failing, 5 s timeout, e.g. for a `beforeunload` prompt).
- `windows.get` and `windows.getLastFocused` need no manifest permission.
- `tool-error.ts`: `ToolError` marks an expected failure whose message reaches the agent without the generic prefix.

## Screenshots

- One `computer` tool carries all page interaction; its `action` enum grows per feature (`screenshot` now, click, type, key and scroll with `feature/bidi-input`), and the host schema and the extension parser offer the same actions.
- `computer.ts` captures with `tabs.captureTab`, which renders a background tab without activating it, so the user's view is not switched; `captureVisibleTab` would need the tab in front. The viewport (`innerWidth`, `innerHeight`, `devicePixelRatio`) is read with `scripting.executeScript`, and `captureTab`'s `scale` (image pixels per CSS pixel) is set so the capture comes out at about the output size.
- Token budget: about 28 px per token per side, at most 1568 px on a side and 1568 tokens per image. The viewport is fitted into that frame (`screenshot-size.ts`); the agent's `scale` shrinks only the returned image, and coordinates always refer to the frame, which is recorded per tab (`coordinate-frame.ts`) and forgotten on `tabs.onRemoved`.
- JPEG: captured at quality 0.75; if the capture is not the output size or its base64 is longer than 1,398,100 characters (about 1 MB), it is redrawn on an `OffscreenCanvas` and re-encoded, stepping the quality down by 0.05 to a floor of 0.1. The bridge limits (64 MB per line and native message from the extension) need no change.
- Permissions: `scripting` and `host_permissions: ["<all_urls>"]` (`captureTab` requires `<all_urls>`). Firefox MV3 host permissions are opt-in: until `feature/permissions`, the user grants them in about:addons (extension, Permissions, "Access your data for all websites"); without them the tool says so. A temporary install (web-ext, e2e) gets them granted.
- Restricted pages (non-http(s)/file URLs such as about: pages, Mozilla's restricted domains like addons.mozilla.org, other extensions' pages, reader view, the PDF viewer) are refused with a clear message.

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
2. Loads the extension with the `web-ext` Node API in a temporary profile and waits for `bridge.json`.
3. Calls `tabs_context` through the MCP server (SDK default environment).
4. Opens a tab with `tabs_create` on a page served by the script on `127.0.0.1` and a blank one, checks each appears in `tabs_context`, closes it with `tabs_close` and checks it is gone.
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
