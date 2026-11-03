# Native helper report — dsh-computer-helper

Built by the Lead after the delegated helper task produced no files (the
teammate exhausted its context before writing anything). This report records what
was implemented and the measured verification.

## Deliverables

| File | Purpose |
| --- | --- |
| `helper/ComputerHelper.cs` | C# 5 single-file Win32 service, all protocol commands |
| `helper/serve.ps1` | PowerShell/Add-Type fallback transport (same JSON-line loop) |
| `helper/build/dsh-computer-helper.exe` | Local test build (the plugin builds its own into `%LOCALAPPDATA%\dsh-computer-use\`) |

## Compile command

```
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
  /nologo /target:winexe /optimize+ /platform:anycpu
  /out:helper\build\dsh-computer-helper.exe
  /r:System.dll /r:System.Core.dll /r:System.Drawing.dll
  /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll
  helper\ComputerHelper.cs
```

Exit 0, no warnings. `/target:winexe` means no console window ever flashes;
`System.Core.dll` is already in the compiler's default response file, so the
plugin's reference list works without it.

## Real-effect verification (desktop, not mocks)

`helper/build` was driven over stdio by a Node harness; 22/22 checks passed:

| Check | Evidence |
| --- | --- |
| `info` | 2 monitors: `0:1920x1080@0,0*`, `1:1920x1080@1920,6`; `dpiAwareness=per-monitor-v2`; `isElevated=false` |
| `screenshot` full desktop | PNG 1280x362, `scale=3.000`, origin `0,0`, 422683 bytes |
| `move` + readback | cursor read back as exactly `120,140` |
| `launch` | `notepad.exe` → pid 10280 |
| `windows` | 3 Notepad windows enumerated with handle/title/pid/rect |
| `window focus` | `foreground=true` after attach-thread + title-bar-click fallback |
| `window close` | handle disappears from enumeration |
| `window minimize` / `restore` | `minimized=true` then `false` |
| `click` | cursor lands within 1 px of target |
| `drag` | press/interpolate/release echoed endpoints |
| `scroll` | `dy=-2` accepted and delivered |
| `type` | 53 characters injected |
| keyboard proof | `ctrl+a`, `ctrl+c` then `clipboard get` returned **exactly** the typed string `"DSH computer-use smoke test ...\r\nsecond line"` — real key events reached the focused control |
| screen proof | before/after screenshots of the same region differ (9967 B → 12502 B), so typing visibly changed the desktop |
| robustness | malformed line kept the process serving; unknown command and unknown key name returned `ok:false` without exiting |
| `quit` | acknowledged, process exited 0 |
| cleanup | cursor restored to its original position |

## Implementation notes and limits

- Foreground lock: `SetForegroundWindow` alone is refused by Windows when a
  background process owns no foreground rights. The helper first retries through
  `AttachThreadInput` to the foreground thread plus `BringWindowToTop`; if that
  still fails it clicks the window's title bar, which is an ordinary user action.
- Clipboard calls run on a dedicated STA thread; `E_CLIPBOARD` carries the last
  OLE error after five retries.
- `SendInput` returns 0 when a higher-integrity window (UAC secure desktop,
  elevated app) owns input; the helper reports `E_INPUT_BLOCKED` instead of
  pretending success.
- Single-character keys are resolved with `VkKeyScanW`, which uses the helper
  process keyboard layout; named keys and multi-character chords are
  layout-independent virtual-key codes.
- `screenshot` clips the requested rectangle to the virtual screen and refuses a
  region that does not intersect it.
- Crash safety: stdin EOF ends the process, so an orphan cannot outlive the
  Host; the plugin also sends `quit` and kills on unload.
