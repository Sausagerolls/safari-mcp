# Safari MCP

An MCP server that lets Claude Code drive Safari on macOS, in the same way as the Claude in Chrome extension. It controls your real Safari, so your sign-ins and cookies are available.

It has no dependencies and needs no Safari extension. It uses AppleScript/JXA (`do JavaScript`), `screencapture` and AppKit.

## Requirements

- macOS with Safari (tested on macOS 26 / Safari 26)
- Node.js 18 or later
- [Claude Code](https://claude.com/claude-code)

## Setup

1. **Get the code.** Clone the repository, or download and unzip the latest release:
   ```sh
   git clone https://github.com/Sausagerolls/safari-mcp.git ~/safari-mcp
   ```
2. **Allow scripted JavaScript in Safari.**
   - Open Safari > Settings > Advanced and turn on "Show features for web developers".
   - Open the new Developer tab and turn on "Allow JavaScript from Apple Events".
3. **Register the server with Claude Code.** User scope makes it available in every project. Use the absolute path to `server.mjs`:
   ```sh
   claude mcp add safari -s user -- node ~/safari-mcp/server.mjs
   ```
4. **Restart Claude Code.** Then check the connection:
   ```sh
   claude mcp get safari
   ```
5. **Grant macOS permissions to your terminal app** when it asks. You can also set them in System Settings > Privacy & Security:
   - Automation > Safari (required)
   - Screen & System Audio Recording (required for screenshots)
   - Accessibility (only for `native: true` input)

Then ask Claude, for example: "open localhost:3000 in Safari and check the console for errors".

### Optional: use Safari instead of Claude in Chrome

To stop Claude Code from using or setting up the Chrome integration in any project:

1. Run `/chrome` in Claude Code and turn off "Enabled by default".
2. Block the Chrome tools in `~/.claude/settings.json`:
   ```json
   {
     "permissions": {
       "deny": ["mcp__claude-in-chrome"]
     }
   }
   ```
3. Tell Claude to prefer Safari in `~/.claude/CLAUDE.md`:
   ```markdown
   # Browser automation
   - Use the Safari MCP server (`mcp__safari__*` tools) for all browser tasks.
   - Never use Claude in Chrome (`mcp__claude-in-chrome__*`).
   ```

## Tools

| Tool | Purpose |
| --- | --- |
| `tabs_context` | List windows and tabs. Tab ids are `windowId:tabIndex`. |
| `tabs_create`, `tabs_close`, `tabs_select` | Manage tabs. |
| `navigate` | Go to a URL, or `back`, `forward`, `reload`. Waits for load. |
| `read_page` | Accessibility-style tree with element refs (`ref_N`). `filter: "interactive"` lists only controls. |
| `find` | Keyword search for elements. Returns refs and coordinates. |
| `get_page_text` | Readable page text. |
| `javascript` | Run JS in the page. Supports `await`. |
| `computer` | `screenshot`, clicks, `hover`, `left_click_drag`, `type`, `key`, `scroll`, `scroll_to`, `wait`. |
| `form_input` | Set inputs, selects, checkboxes by ref. |
| `wait_for` | Wait for a selector, text or JS condition. |
| `read_console_messages` | Console output, uncaught errors, and auto-dismissed dialogs. |
| `read_network_requests` | Resource Timing entries plus fetch/XHR with method and status. |
| `resize_window` | Resize the Safari window. |

Screenshots are cropped to the page viewport. Image pixel coordinates equal page CSS coordinates (scaled only when the viewport is wider than 1400 px).

## How input works

By default, clicks, typing and keys are synthesized DOM events inside the page. Safari does not need to be in front, and your mouse does not move. This works for most sites and frameworks (React, Vue and others).

Some actions need trusted events: CSS `:hover`, file pickers, native `<select>` popups, and sites that check `event.isTrusted`. For these, pass `native: true`. Safari then comes to the front, and the real mouse or keyboard is used. This needs Accessibility permission.

## Limitations

- Console and network capture start when a tool first touches a page. `navigate` installs capture right after load, so logs during initial page load are missed. Use `navigate` with `reload`, or read the network list, which includes all resources from Resource Timing.
- Safari does not expose HTTP status for non-fetch/XHR resources in Resource Timing, so those show `-`.
- Tab ids use the tab index, which shifts when you close an earlier tab in the same window.
- Cross-origin iframe content is not visible to `read_page` or `find`. Use screenshots and coordinates instead.
- `alert`, `confirm` and `prompt` are replaced after the first tool call on a page, because a blocking dialog would freeze AppleScript. `confirm()` returns `false` unless you set `window.__mcp.confirmResult = true`.
- Page zoom other than 100% breaks the screenshot coordinate mapping.

## Troubleshooting

| Error | Fix |
| --- | --- |
| "Safari blocks scripted JavaScript" | Do setup step 2. |
| "macOS denied Automation access to Safari" | System Settings > Privacy & Security > Automation: allow your terminal app to control Safari. |
| "Screenshot failed" | Grant Screen Recording permission to your terminal app, and make sure the Safari window is not minimized. |
| A tool call hangs, then times out | A page dialog opened before the server touched the page. Dismiss it in Safari. |

## Test

The smoke test opens a fixture page in a new Safari tab and runs every main tool:

```sh
(cd test && python3 -m http.server 8765 --bind 127.0.0.1 &)
node test/smoke.mjs http://127.0.0.1:8765/fixture.html
```

## License

[MIT](LICENSE)
