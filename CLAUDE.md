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
- Open: how the MCP process and the native messaging process connect (local Unix socket vs. localhost WebSocket with a token). Decide at the start of `feature/native-bridge`, after the researcher explains how Claude in Chrome does it.

## Roadmap

Each feature is its own branch from `main`. The feature's last commit marks it `[x]` here.

- [ ] `feature/project-setup`: `package.json`, `tsconfig`, `web-ext`, build, folder structure; fill in Repository layout and Commands below.
- [ ] `feature/extension-skeleton`: Firefox MV3 `manifest.json` and background script; the extension loads without errors.
- [ ] `feature/native-bridge`: native host + MCP server, end-to-end on the first tool `tabs_context`; install/registration of the native messaging manifest.
- [ ] `feature/navigate`: `navigate`, `tabs_create`, `tabs_close`.
- [ ] `feature/screenshot`: screenshots via `tabs.captureVisibleTab`.
- [ ] `feature/accessibility-tree`: DOM-based tree with `ref_N` references; `read_page`, `find`, `get_page_text`.
- [ ] `feature/bidi-input`: `computer` tool (click, type, key, scroll) through WebDriver BiDi; `form_input`.
- [ ] `feature/devtools-tools`: `javascript_tool`, `read_console_messages`, `read_network_requests`, `resize_window`.

## Repository layout

Not created yet.

## Commands

Not defined yet.
