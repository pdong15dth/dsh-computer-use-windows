# Computer Use (Windows) — DeepSeek Harness plugin

Gives the model **real** control of this Windows desktop. Every action is a Win32
call executed by a compiled helper process — no application scripting, no
AppleScript-style automation, no UI-automation framework, no `SendKeys`.

| Layer | Win32 mechanism |
| --- | --- |
| Mouse | `SendInput` (`MOUSEEVENTF_ABSOLUTE \| VIRTUALDESK`, button down/up, wheel) |
| Keyboard | `SendInput` (`KEYEVENTF_UNICODE`, virtual-key chords with extended flags) |
| Screen | GDI+ `CopyFromScreen` at the team's physical-pixel resolution |
| Windows | `EnumWindows`, `GetWindowTextW`, `GetWindowRect`, `SetForegroundWindow`, `ShowWindow`, `PostMessage(WM_CLOSE)` |
| Clipboard | the real Win32 clipboard on an STA worker thread |
| Launch | `Process.Start` with `UseShellExecute` (same path as Win+R / Start menu) |

## Tools

| Tool | What it does |
| --- | --- |
| `computer_info` | Virtual screen, monitors, cursor, DPI-awareness state, elevation |
| `computer_screenshot` | Capture the desktop, one monitor or an exact region as an image |
| `computer_mouse_move` | Absolute pointer move |
| `computer_click` | Left/right/middle click, single or double, with optional move |
| `computer_drag` | Press, interpolate, release (selection, sliders, window moves) |
| `computer_scroll` | Wheel notches vertically/horizontally at the pointer |
| `computer_type` | Real Unicode typing (`\n` = Enter, `\t` = Tab) |
| `computer_key` | Shortcuts and named keys: `ctrl+shift+t`, `["ctrl+a", "delete"]` |
| `computer_clipboard` | Read, write or clear the clipboard |
| `computer_windows` | List top-level windows with handle, title, pid, rect, state |
| `computer_window_control` | Focus, minimize, maximize, restore or close a window |
| `computer_launch` | Launch an app, open a path/document, or open a URL |

Screenshots answer with the coordinate mapping (`originX`, `originY`, `scale`), so
image pixel `(ix, iy)` maps to screen point
`(originX + ix*scale, originY + iy*scale)`. All tool coordinates are physical
pixels in the virtual-screen space from `computer_info`.

## Install

The bundle is a plain Host package. From a Harness session:

```
plugin_manager { action: "install_bundle", target: "<absolute path to this directory>" }
```

Installation links this directory into the profile and inserts the
`computer-use-windows` row from `cordis.patch.yml`. No build step, no npm
dependency: the plugin is dependency-free ESM and the native helper is compiled
on first use.

## Plugin market

This repository also publishes a format-1 plugin market index, so the bundle can
be discovered and installed from the Harness **Plugins → Discover** tab instead
of a local path:

```
https://raw.githubusercontent.com/pdong15dth/dsh-computer-use-windows/main/market/index.json
```

Add it as a source of `@deepseek-ai/dsh-plugin-market` (its `indexes` list, for
example in the profile patch `cordis.patch.yml`), then the tab lists
`dsh-computer-use-windows`. `plugin_market` reports the same entries to an agent:
`list_indexes`, `list_plugins`, and `list_versions`, whose install target is
commit-pinned, e.g.

```
git+https://github.com/pdong15dth/dsh-computer-use-windows.git#<40-hex-commit>
```

`market/index.json` is validated with the shipped
`@deepseek-ai/dsh-plugin-market-index` `parseMarketIndex` validator before it is
published. Each release needs a new `versions[]` entry pinning that release's
commit; a published entry is immutable (commit-pinned), so editing this file only
affects future releases.

## How the native helper is built

On the first tool call the Host plugin compiles
`helper/ComputerHelper.cs` with the .NET Framework compiler that ships with
Windows:

```
%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
  /nologo /target:winexe /optimize+ /platform:anycpu
  /out:%LOCALAPPDATA%\dsh-computer-use\dsh-computer-helper.exe
  /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll
  helper/ComputerHelper.cs
```

The output is cached in `%LOCALAPPDATA%\dsh-computer-use\` and rebuilt when the
source changes (SHA-256 stamp). It is a `/target:winexe` process, so no console
window ever flashes, and the Host spawns it with `windowsHide: true`.

If `csc.exe` is unavailable, the plugin falls back to
`helper/serve.ps1` (`Add-Type` + the same JSON-line loop). That path works but
starts slower.

Environment overrides:

| Variable | Effect |
| --- | --- |
| `DSH_COMPUTER_USE_HELPER` | Use this prebuilt helper `.exe` instead of compiling |
| `DSH_COMPUTER_USE_CSC` | Use this `csc.exe` to compile the helper |

## Safety

These tools inject input into whatever window currently has focus. A model
driving them can click, type and close windows on this machine; review actions
before granting a session that can reach them, and keep unrelated work saved.

Known limits:

- Elevation boundary: a non-elevated helper cannot inject input into elevated
  windows, and neither can anything reach the UAC secure desktop.
- Some exclusive-fullscreen games and anti-cheat protected windows ignore
  synthetic input; that is a platform restriction, not a plugin bug.
- Screen capture returns the visible desktop composition; content protected by
  DRM may appear black.
- The helper runs with the invoking user's rights; it does not elevate itself.
- Focus is global state: `computer_type` and `computer_key` go to whatever window
  is foreground at that instant. If a human is also using the machine, focus can
  change between two tool calls, so a typing sequence can land in the wrong
  window. Run computer-use work when the desktop is idle, or confirm with
  `computer_windows` that the intended window reports `[focused]` immediately
  before typing.
- Every successful `ctrl+c` overwrites the user's clipboard.

## Verification

Measured on this machine (Windows 11 build 26100, 2 x 1920x1080, per-monitor-v2):

**Helper level** — 22/22 checks against `helper/build/dsh-computer-helper.exe`
driven over stdio (see `helper/REPORT-HELPER.md`). The decisive ones were real
effects, not return values: a unique string typed into Notepad came back
byte-identical through `ctrl+a` / `ctrl+c` / clipboard read; before/after region
screenshots differed; the cursor read back at the exact requested coordinate;
Notepad was focused, minimized, restored and closed through window messages.

**Plugin level** — after `plugin_manager install_bundle` reported
`application: applied`, the registered tools ran against the live desktop:
`computer_info` (2 monitors, per-monitor-v2, not elevated),
`computer_screenshot` (returned a real image block plus origin/scale mapping),
`computer_windows`, `computer_window_control` (focus/minimize/restore/close),
`computer_launch` (Notepad), `computer_type` (window title changed to
`*DSH-CU plugin proof 2026-11-03 abcd - Notepad`, proving the characters reached
the focused control), `computer_key`, `computer_clipboard`, `computer_mouse_move`.

Not exercised through the plugin wrapper on the live desktop: `computer_click`,
`computer_drag` and `computer_scroll` — the same helper commands were exercised
by the helper-level test, and the wrappers only forward validated arguments. They
were skipped at plugin level because this desktop was being used concurrently and
a synthesized click at absolute coordinates could land on the user's window.

## Files

```
computer-use/
  index.js               Host plugin: 12 tools + helper client
  cordis.patch.yml       bundle patch (inserts the computer-use-windows row)
  package.json           bundle manifest (dsh.bundle.patch)
  locale/en.json         Plugin Manager title/description (en)
  locale/vi.json         Plugin Manager title/description (vi)
  icon.svg               Plugin artwork
  PROTOCOL.md            JSON-line contract between plugin and helper
  helper/ComputerHelper.cs   native Win32 helper source
  helper/serve.ps1           PowerShell fallback launcher
  helper/REPORT-HELPER.md    build command and measured verification
  LICENSE                    MIT
```

## License

MIT — see [LICENSE](LICENSE). The icon in `icon.svg` is original artwork for this
plugin and covered by the same license.
