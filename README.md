# Computer Use for DeepSeek Harness (agent-desktop)

DSH bundle that lets an agent **see and operate desktop apps** through
[`agent-desktop`](https://github.com/vercel-labs/agent-desktop), the Vercel Labs
CLI that reads and drives the OS accessibility tree — UI Automation on Windows,
AX on macOS, AT-SPI on Linux.

There is no pixel matching and no private native helper in this repository: the
plugin is a thin, typed wrapper that runs `agent-desktop` commands and hands the
JSON envelope to the model.

```
model → desktop_snapshot (tree + refs) → desktop_act / desktop_type (@ref) → snapshot again to verify
```

## Requirements

1. Install the CLI once (it carries the native binaries for x64/ARM64):

   ```bash
   npm install -g agent-desktop
   agent-desktop status        # platform, permissions, supported surfaces
   ```

   On macOS the Accessibility grant is required:
   `agent-desktop permissions --guide`.

2. Install this bundle:

   ```
   plugin_manager { action: "install_bundle", target: "<absolute path to this repository>" }
   ```

   or add the market index listed in [Plugin market](#plugin-market) and install
   from **Plugins → Discover**.

The plugin resolves the native binary itself (`agent-desktop-<platform>-<arch>`)
from PATH or the npm global root. If it is somewhere else, set the config
`binPath` or the environment variable `DSH_AGENT_DESKTOP_BIN`.

## Tools

| Tool | Purpose |
| --- | --- |
| `desktop_status` | Platform, permissions, surfaces, state root, latest snapshot |
| `desktop_snapshot` | Accessibility tree as JSON with a ref per actionable element (`-i`, `--compact`, `--skeleton`, `--root`, surfaces) |
| `desktop_find` | Find elements by role / name / text / value / native id and get refs without reading the whole tree |
| `desktop_inspect` | `get` a property or `is` test on one ref — the cheap verification step |
| `desktop_act` | `click`, `double_click`, `right_click`, `focus`, `select`, `toggle`, `check`, `uncheck`, `expand`, `collapse`, `scroll`, `scroll_to` on a ref |
| `desktop_type` | Type text into a ref (stdin, UTF-8, interval support) |
| `desktop_set_value` | Set a value directly (headless, no keystrokes) |
| `desktop_press` | Key combination such as `ctrl+s` or `enter`, with `--app`, `--force` |
| `desktop_screenshot` | PNG of an app window or display, returned as an image block |
| `desktop_clipboard` | Read / write / clear the clipboard (text up to 128 KiB) |
| `desktop_apps` | List running apps, launch, close |
| `desktop_windows` | List windows and displays; focus, minimize, maximize, restore, move, resize |
| `desktop_wait` | Wait for a duration, element, text, window, menu, event or notification |
| `desktop_batch` | Run several commands sequentially in one process |

Ref semantics come from agent-desktop: `@<snapshot_id>:eN` is valid for one
snapshot only; a stale ref is refused (`STALE_REF` / `AMBIGUOUS_TARGET`) instead
of acting on the wrong element. Snapshot again after the UI changes.

## Headless and headed

Ref actions are semantic UI Automation calls by default: they do not move the
pointer, take focus or use the clipboard. On Windows a few commands are physical
by nature — `type`, `double-click`, `right-click`, `focus`, `drag`, `hover`,
`mouse-*` — and the CLI refuses them headless. The plugin adds `--headed`
automatically for exactly those commands on Windows; pass `headed: false` to
observe the refusal, or set `preferHeaded: true` in the config to run everything
in headed mode.

## Config

`cordis.patch.yml` row config (all optional):

| Key | Default | Meaning |
| --- | --- | --- |
| `binPath` | auto | Absolute path to the agent-desktop native binary |
| `defaultTimeoutMs` | `60000` | Per-call timeout for ordinary commands |
| `snapshotTimeoutMs` | `120000` | Timeout for `desktop_snapshot` |
| `typeTimeoutMs` | `120000` | Timeout for `desktop_type` |
| `screenshotTimeoutMs` | `60000` | Timeout for `desktop_screenshot` |
| `preferHeaded` | `false` | Add `--headed` to every command that accepts it |

## Security notes

Accessibility snapshots, screenshots, clipboard reads and command output can
contain private desktop content. Keep them out of public logs and uploads.
The CLI refuses destructive shell shortcuts (`alt+f4`, `win+l`, `win+r`, …)
unless a call passes `force: true` to `desktop_press`.

## Platform support

| Platform | Requirement | API |
| --- | --- | --- |
| Windows | Windows 10 1809+ x64/ARM64, interactive session | UI Automation |
| macOS | macOS 13+, Accessibility grant | AX API |
| Linux | Ubuntu 24.04+, X11 or Wayland, AT-SPI | AT-SPI |

A minimized window cannot be driven by ref actions — `desktop_windows restore`
first. Elevation boundaries (UIPI) and the secure desktop are unreachable.

## Verification

Measured on Windows 11 with `agent-desktop` 1.2.0 (`agent-desktop-win32-x64.exe`),
`accessibility: granted`, 14 tools registered. Real effects, not just envelopes:

| Check | Result |
| --- | --- |
| `desktop_status` | platform `windows`, permissions granted, 9 supported surfaces |
| `desktop_apps launch` | `calc.exe`, `charmap.exe` and `powershell_ise.exe` started with pid |
| `desktop_windows list` | 11 top-level windows with id, bounds, pid, focus state |
| `desktop_snapshot` | Calculator tree with 40 refs, `complete: true` |
| `desktop_find` | found `Plus`, `Three`, `Equals`, `Display is 10` refs without a full tree |
| `desktop_act click` | semantic `InvokePattern.Invoke`; 7, +, 3, = produced **`Display is 10`** |
| `desktop_batch` | 5 clicks in 1009 ms, `stop_on_error`, all entries `ok` |
| `desktop_screenshot` | PNG 1920x1032 returned as an image block |
| `desktop_set_value` | `ValuePattern.SetValue`, `delivery: delivered_verified`, value read back |
| `desktop_type` | `SendInput.type_text` (`physical_synthetic`), `delivered_verified`; readback matched the exact text, then cleared with `desktop_press` |
| `desktop_press` | `ctrl+a`, `delete`, `backspace` delivered to the target app |
| `desktop_clipboard` | set → get round-tripped exactly, then restored to the previous value |
| `desktop_windows minimize/restore` | minimized, then `window_restore` `delivered_verified` |
| `desktop_apps close` | `charmap.exe` and `powershell_ise.exe` exited (`delivered_verified`) |

Test artifacts were closed afterwards, the user clipboard was restored and the
user's Notepad document was not touched.

Known platform constraint observed: on Windows the CLI refuses physical delivery
(`type`, `focus`, double/right click) when the target window is not foreground —
`ACTION_FAILED: Target window did not become foreground before headed delivery`.
`desktop_set_value` is the headless way to fill a background field; otherwise the
target window must be focused first.

## Plugin market

```
https://raw.githubusercontent.com/pdong15dth/dsh-computer-use-windows/main/market/index.json
```

Add it as a source of `@deepseek-ai/dsh-plugin-market` (its `indexes` list) and
**Plugins → Discover** lists this bundle. Each release pins its git commit in
`market/index.json`; a published version entry is immutable.

## License

MIT — see [LICENSE](LICENSE). The plugin icon is original artwork covered by the
same license. agent-desktop itself is Apache-2.0 and installed separately.
