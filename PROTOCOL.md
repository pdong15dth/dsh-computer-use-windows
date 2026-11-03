# Computer-use helper protocol (Windows, Win32)

The Host plugin `dsh-computer-use-windows` never automates the desktop through
AppleScript-like scripting or UI-automation frameworks. It drives the desktop
through Win32: `SendInput`/`SetCursorPos` for input, GDI+ for screen capture,
`EnumWindows`/`SetForegroundWindow` for windows, and the Win32 clipboard.

All of that work happens in one native helper process, `dsh-computer-helper.exe`,
which the plugin starts on demand and keeps alive. This file is the contract
between the plugin (`index.js`) and the helper (`helper/ComputerHelper.cs`).

## Transport

* One JSON object per line, UTF-8, no BOM, on the helper's **stdin** / **stdout**.
* Anything diagnostic goes to **stderr** only. stdout carries responses only.
* Requests and responses are matched by `id`.
* The helper exits cleanly when stdin reaches EOF, or on `quit`.

Request:

```json
{"id": 7, "cmd": "click", "args": {"x": 100, "y": 200, "button": "left", "count": 2}}
```

Success:

```json
{"id": 7, "ok": true, "result": {"x": 100, "y": 200, "button": "left", "count": 2}}
```

Failure (never kills the process):

```json
{"id": 7, "ok": false, "error": {"message": "unknown button \"side\"", "code": "E_ARGS"}}
```

A malformed line answers `{"id": -1, "ok": false, "error": {...}}` and keeps serving.

## Environment facts

* Targets .NET Framework 4.x, **C# 5 only** (compiled by
  `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`):
  no string interpolation, no `nameof`, no expression-bodied members, no tuples,
  no null-conditional `?.`.
* References: `System.dll`, `System.Drawing.dll`, `System.Windows.Forms.dll`,
  `System.Web.Extensions.dll` (for `JavaScriptSerializer`).
* Build: `/target:winexe` so no console window ever flashes; stdio redirection
  still works. The plugin passes `windowsHide: true` when spawning.
* Compile line the plugin uses:

  ```
  csc.exe /nologo /target:winexe /optimize+ /platform:anycpu /out:<exe>
          /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll
          /r:System.Web.Extensions.dll <ComputerHelper.cs>
  ```
* On startup the helper raises its DPI awareness before touching any geometry:
  `SetProcessDpiAwarenessContext(-4)` (per-monitor v2), else
  `SetProcessDpiAwareness(2)` (per-monitor), else `SetProcessDpiAwareness(1)`.
  The achieved level is reported in `info.dpiAwareness`.
* **All coordinates are physical pixels in the virtual-screen space.** The virtual
  screen origin is `info.virtualScreen.x/y` (can be negative when a monitor sits
  left of / above the primary one).
* JSON: read/write with a `StreamReader`/`StreamWriter` over
  `Console.OpenStandardInput/Output` using `new UTF8Encoding(false)`, `AutoFlush = true`.

## Commands

### `info`

args `{}`.

```json
{"osVersion": "Microsoft Windows NT 10.0.26100.0",
 "isElevated": false,
 "dpiAwareness": "per-monitor-v2",
 "virtualScreen": {"x": 0, "y": 0, "width": 3840, "height": 1086},
 "monitors": [{"index": 0, "x": 0, "y": 0, "width": 1920, "height": 1080,
               "primary": true, "deviceName": "\\\\.\\DISPLAY1"}],
 "cursor": {"x": 960, "y": 540},
 "clipboard": {"available": true}}
```

### `screenshot`

args `{ "path": "<absolute .png path>", "x"?, "y"?, "width"?, "height"?,
"monitor"?: int, "maxWidth"?: int, "includeCursor"?: bool }`

* Target rect: `monitor` index wins; else the explicit `x/y/width/height` region;
  else the whole virtual screen. The rect is clipped to the virtual screen.
* If `maxWidth > 0` and the capture is wider, downscale proportionally
  (high-quality bicubic). `maxWidth` never upscales.
* Writes a 32-bit PNG to `path` (the plugin creates the directory).
* `includeCursor`: draw the cursor into the image (optional, cheap; default false).

```json
{"path": "C:\\...\\shot.png", "width": 1600, "height": 452,
 "originX": 0, "originY": 0, "scale": 2.4}
```

`scale = nativeCaptureWidth / width`, so a pixel `(ix, iy)` in the returned image
maps to screen point `(originX + ix*scale, originY + iy*scale)`.

### `move`

args `{"x": int, "y": int}` → `{"x":.., "y":..}` (uses `SendInput`
`MOUSEEVENTF_MOVE|ABSOLUTE|VIRTUALDESK`, never a virtualized replay).

### `click`

args `{"x"?,"y"?,"button"?:"left"|"right"|"middle","count"?:1..5,"intervalMs"?:"int"}`
→ `{"x","y","button","count"}`.

Moves first when `x`/`y` are given. `intervalMs` is the gap between repeated
presses (default 40; a double click stays under the shell double-click time).

### `drag`

args `{"fromX","fromY","toX","toY","button"?,"durationMs"?}` → echoes the points.

Presses at the start point, interpolates roughly every 8–16 ms, releases at the
end. `durationMs` default 300, clamped to 20..10000.

### `scroll`

args `{"x"?,"y"?,"dy"?:int,"dx"?:int}` → `{"x","y","dy","dx"}`.

`dy` is in wheel notches: positive scrolls **down**, negative up. `dx` positive
scrolls right. One notch = `WHEEL_DELTA` (120).

### `type`

args `{"text": string, "intervalMs"?: int}` → `{"characters": int, "method": "unicode"}`.

Per UTF-16 code unit `SendInput` with `KEYEVENTF_UNICODE` (down+up). `\n`/`\r`
become `VK_RETURN`, `\t` becomes `VK_TAB`. `intervalMs` default 0, clamped 0..50.

### `key`

args `{"keys": string | string[], "action"?:"press"|"down"|"up", "repeat"?: int}`
→ `{"keys": ["ctrl","shift","t"], "action": "press"}`.

* A string is one chord: `"ctrl+shift+t"`. An array is a sequence of chords, each
  executed in order: `["ctrl+a", "delete"]`.
* Modifiers: `ctrl`, `shift`, `alt`, `win`.
* Named keys: `enter tab escape space backspace delete insert home end pageup
  pagedown up down left right capslock numlock scrolllock printscreen pause apps
  f1..f24 minus equals comma period slash backslash semicolon quote backquote
  leftbracket rightbracket`.
* Anything else that is a single character is resolved with `VkKeyScanW` (so `"!"`
  and `"$"` work). Unknown names fail with `E_ARGS`.
* `action: "down"`/`"up"` holds or releases without the matching half (used for
  shift-click style sequences); default `press`.

### `clipboard`

args `{"action": "get"|"set"|"clear", "text"?}` → `{"text"?..., "length"?}`.

Uses the real Win32 clipboard (STA worker thread + `System.Windows.Forms.Clipboard`).

### `windows`

args `{"includeHidden"?: bool, "titleContains"?: string, "limit"?: int}` →
`{"windows": [{"handle": 131252, "title": "Untitled - Notepad", "className": "Notepad",
"processId": 4242, "processName": "notepad", "rect": {"x":..,"y":..,"width":..,"height":..},
"minimized": false, "maximized": false, "foreground": true, "monitorIndex": 0}]}`.

Only top-level windows; default skips invisible ones and untitled shells that have
`WS_EX_TOOLWINDOW`. `limit` default 200, max 1000.

### `window`

args `{"action": "focus"|"minimize"|"maximize"|"restore"|"close", "handle"?: int,
"titleContains"?: string}` → `{"handle", "title", "action"}`.

Resolves by `handle` first, else the first visible window whose title contains the
case-insensitive `titleContains`. `focus` restores then `SetForegroundWindow`
(with the `AttachThreadInput` fallback). `close` posts `WM_CLOSE`.

### `launch`

args `{"target": string, "arguments"?: string, "waitMs"?: int}` →
`{"launched": true, "processId"?: int}`.

`Process.Start` with `UseShellExecute = true`, so app names (`notepad`), absolute
paths and URLs work.

### `quit`

args `{}` → `{"ok": true}`, then the process exits 0.
