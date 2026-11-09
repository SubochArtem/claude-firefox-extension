# Installing

You need Firefox 158 or later and Claude Code. Node.js is not needed. Snap and Flatpak builds of Firefox are not supported: their sandbox blocks native messaging hosts.

## 1. Download

Open the latest release on the repository's Releases page and download the native host for your system and the extension package:

| System | File |
|---|---|
| Linux x64 | `claude-firefox-host-linux-x64` |
| Linux arm64 | `claude-firefox-host-linux-arm64` |
| macOS Apple silicon | `claude-firefox-host-macos-arm64` |
| macOS Intel | `claude-firefox-host-macos-x64` |
| Windows x64 | `claude-firefox-host-windows-x64.exe` |
| Extension (all systems) | `claude-firefox-extension-<version>.xpi` |

Optionally check the downloads against `SHA256SUMS` from the same release (`sha256sum -c SHA256SUMS --ignore-missing` on Linux, `shasum -a 256 -c SHA256SUMS --ignore-missing` on macOS, on Windows in PowerShell `(Get-FileHash <file>).Hash.ToLower()`, which must equal the hash on the file's line in `SHA256SUMS`).

## 2. Allow the binary to run

The binaries are not code-signed.

- Linux: `chmod +x claude-firefox-host-linux-*`.
- macOS: `chmod +x claude-firefox-host-macos-*`, then remove the download quarantine with `xattr -d com.apple.quarantine claude-firefox-host-macos-*`. Alternatively run it once, let macOS block it, open System Settings > Privacy & Security, click Open Anyway next to the message about the file and run it again.
- Windows: SmartScreen may show "Windows protected your PC" on the first start; click More info, then Run anyway. In PowerShell you can clear the download mark first with `Unblock-File .\claude-firefox-host-windows-x64.exe`.

## 3. Install the native host

Run the downloaded binary with `install` from a terminal in the download folder:

```sh
./claude-firefox-host-linux-x64 install          # Linux (macOS: ./claude-firefox-host-macos-arm64 install)
```

```powershell
.\claude-firefox-host-windows-x64.exe install    # Windows
```

It copies itself into your user data directory, registers that copy with Firefox and prints what it did:

```
Installed the native messaging host:
  manifest: /home/you/.mozilla/native-messaging-hosts/claude_firefox_extension.json
  host:     /home/you/.local/share/claude-firefox-extension/claude-firefox-host

Register the MCP server with Claude Code:
  claude mcp add firefox -- '/home/you/.local/share/claude-firefox-extension/claude-firefox-host' --mcp

Clicks and typing need Firefox started with WebDriver BiDi on port 9222. Close every Firefox window, then run:
  firefox --remote-debugging-port=9222
...
```

The install directory is `~/.local/share/claude-firefox-extension/` on Linux (`$XDG_DATA_HOME` if set), `~/Library/Application Support/claude-firefox-extension/` on macOS and `%LOCALAPPDATA%\claude-firefox-extension\` on Windows. The downloaded file is no longer needed afterwards.

## 4. Register the MCP server with Claude Code

Run the `claude mcp add firefox -- ...` command exactly as `install` printed it (it names the installed copy, quoted for your shell). Restart running Claude Code sessions to pick it up.

## 5. Load the extension

The extension package is not signed by Mozilla yet, so release Firefox cannot install it permanently until the extension is signed on addons.mozilla.org (`feature/amo-signing`). Until then:

- Release Firefox: open `about:debugging`, This Firefox, Load Temporary Add-on, and pick the `.xpi`. The extension is removed when Firefox closes and has to be loaded again after every start.
- Firefox Developer Edition or Nightly: set `xpinstall.signatures.required` to `false` in `about:config`, then in `about:addons` use the gear menu > Install Add-on From File and pick the `.xpi`. This install is permanent.

## 6. Start Firefox with remote debugging

Clicks, typing and scrolling go through WebDriver BiDi, so close every Firefox window and start Firefox with the command `install` printed:

- Linux: `firefox --remote-debugging-port=9222`
- macOS: `/Applications/Firefox.app/Contents/MacOS/firefox --remote-debugging-port=9222`
- Windows: `"C:\Program Files\Mozilla Firefox\firefox.exe" --remote-debugging-port=9222`

Firefox then shows a robot icon and a striped address bar. To use another port, start Firefox with it and set `CLAUDE_FIREFOX_BIDI_PORT` to that port in the environment Firefox is started from.

## 7. Grant access to websites

Screenshots and page tools need the extension's access to all websites. In `about:addons`, open the extension, go to the Permissions tab and turn on "Access your data for all websites". Check this for a temporary install from `about:debugging` too and turn it on if it is off.

The extension still asks before acting on each site: Claude Code shows the question, or Firefox opens a small prompt window.

## Using the sidebar with local Claude Code

The "Claude" sidebar (View > Sidebar) can run your installed Claude Code instead of calling the Anthropic API with an API key:

1. Install Claude Code 2.1.302 or newer and log in with your Claude account: run `claude` in a terminal and log in, or run `claude auth login`. Only a Claude subscription login is used; an API key or a cloud provider login is not.
2. In `about:addons`, open the extension's options and choose "Local Claude Code" under "Sidebar chat". The model chosen there applies to this mode too. The status line below shows whether Claude Code was found and is logged in.
3. Open the sidebar and type a prompt. The native host starts Claude Code for the conversation; "New chat" ends it. If Claude Code is not found, set `CLAUDE_FIREFOX_CLAUDE_PATH` to its full path in the environment Firefox is started from.

Site permissions are always asked in a small Firefox prompt window in this mode, not in Claude Code.

## Upgrading

Download the new binary and run its `install` as in steps 2 and 3. It replaces the installed copy, even while Firefox or Claude Code still run the old one; restart Firefox and Claude Code to use the new version. The `claude mcp add` registration stays valid. Load the new extension package as in step 5.

The extension id changed to `claude-sidebar@artem.dev`. If your install predates that change, run `install` again after upgrading: the registered manifest allows only the old id. The new id also gets a new storage area, so stored site permissions, the sidebar chat API key, model and backend, and the agent tabs setting are not carried over: set them again in the options page.

## Uninstalling

Close Firefox and Claude Code, then run `uninstall` with the installed or a downloaded binary, for example:

```sh
~/.local/share/claude-firefox-extension/claude-firefox-host uninstall
```

It removes the Firefox registration and the installed files. Then remove the MCP server with `claude mcp remove firefox` and the extension in `about:addons`.
