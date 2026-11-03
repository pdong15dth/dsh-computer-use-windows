/**
 * dsh-computer-use-windows
 *
 * Gives the model real control of this Windows desktop. Every action is a Win32
 * call executed by one native helper process:
 *
 * - input: `SendInput` / `SetCursorPos` (absolute virtual-desktop mouse moves,
 *   real button and wheel events, Unicode keyboard injection),
 * - screen: GDI+ capture of the virtual desktop, a monitor or an exact region,
 * - windows: `EnumWindows`, `SetForegroundWindow`, `ShowWindow`, `PostMessage`,
 * - clipboard: the real Win32 clipboard on an STA worker thread,
 * - launch: `Process.Start` with `UseShellExecute`.
 *
 * Nothing here is application scripting: no AppleScript, no UI Automation, no
 * `SendKeys`. The helper is a compiled .NET Framework executable
 * (`helper/ComputerHelper.cs`, built once by `csc.exe` into
 * `%LOCALAPPDATA%\dsh-computer-use\`) that the Host spawns with
 * `windowsHide: true` and drives over JSON lines; see `PROTOCOL.md`.
 *
 * @module dsh-computer-use-windows
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

export const name = 'computer-use-windows'
export const inject = ['tools']

const HERE = dirname(fileURLToPath(import.meta.url))
const HELPER_SOURCE = join(HERE, 'helper', 'ComputerHelper.cs')
const HELPER_SERVE_PS1 = join(HERE, 'helper', 'serve.ps1')

const DEFAULTS = {
  /** Longest edge used when a full-desktop capture is downscaled before it reaches the model. */
  screenshotMaxWidth: 1920,
  /** Default per-command timeout for helper calls. */
  helperTimeoutMs: 30000,
  /** Screen capture is slower than input; give it room. */
  screenshotTimeoutMs: 60000,
}

const MAX_STDERR_TAIL = 4000
const CAPTURE_DIR = join(tmpdir(), 'dsh-computer-use')

/* ------------------------------------------------------------------------- *
 * Helper process
 * ------------------------------------------------------------------------- */

class HelperProcess {
  constructor(ctx, options) {
    this.ctx = ctx
    this.options = options
    this.child = null
    this.reader = null
    this.pending = new Map()
    this.seq = 0
    this.starting = null
    this.stderrTail = ''
    this.exited = true
    this.stopped = false
    this.mode = undefined
  }

  async start() {
    if (this.stopped) throw new Error('the computer-use helper has already been disposed')
    if (this.child !== null && !this.exited) return
    if (this.starting !== null) return this.starting
    this.starting = this.launch().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  async launch() {
    const plan = this.resolvePlan()
    this.mode = plan.mode
    const env = { ...process.env }
    env.ELECTRON_RUN_AS_NODE = undefined
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(plan.command, plan.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env,
    })
    this.child = child
    this.exited = false
    this.stderrTail = ''

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.stderrTail = appendTail(this.stderrTail, chunk)
    })
    child.on('error', (error) => {
      this.stderrTail = appendTail(this.stderrTail, `spawn error: ${error.message}`)
    })
    this.reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.reader.on('line', (line) => this.onLine(line))
    child.on('exit', (code, signal) => this.onExit(code, signal))
    child.on('close', (code, signal) => this.onExit(code, signal))

    try {
      await this.send('info', {}, 20000, undefined)
    } catch (error) {
      this.killChild()
      throw new Error(
        `the computer-use helper (${plan.mode} mode) did not answer its handshake: ${errorMessage(error)}` +
          (this.stderrTail ? `\nhelper stderr:\n${this.stderrTail}` : ''),
      )
    }
  }

  resolvePlan() {
    const override = process.env.DSH_COMPUTER_USE_HELPER
    if (typeof override === 'string' && override.trim().length > 0) {
      if (!existsSync(override)) throw new Error(`DSH_COMPUTER_USE_HELPER points at a missing file: ${override}`)
      return { mode: 'exe', command: override, args: [] }
    }
    let buildError
    try {
      return { mode: 'exe', command: ensureHelperBuilt(), args: [] }
    } catch (error) {
      buildError = error
    }
    if (existsSync(HELPER_SERVE_PS1) && existsSync(HELPER_SOURCE)) {
      return {
        mode: 'powershell',
        command: powershellPath(),
        args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER_SERVE_PS1, '-Source', HELPER_SOURCE],
      }
    }
    throw new Error(`the native helper could not be built (${errorMessage(buildError)}) and no PowerShell fallback is available`)
  }

  onLine(line) {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      return
    }
    if (message === null || typeof message !== 'object') return
    const entry = this.pending.get(message.id)
    if (entry === undefined) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (entry.onAbort !== undefined) entry.signal?.removeEventListener?.('abort', entry.onAbort)
    if (message.ok === true) entry.resolve(message.result ?? {})
    else entry.reject(new Error(describeFailure(message.error)))
  }

  onExit(code, signal) {
    if (this.exited) return
    this.exited = true
    this.child = null
    const detail = this.stderrTail.trim()
    this.rejectAll(
      helperDownError(
        `the computer-use helper exited (${signal ?? `code ${code}`})` + (detail ? `: ${detail}` : ''),
      ),
    )
  }

  async call(cmd, args = {}, callOptions = {}) {
    const timeoutMs = callOptions.timeoutMs ?? this.options.helperTimeoutMs
    const signal = callOptions.signal
    let lastError
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (this.child === null || this.exited) await this.start()
        return await this.send(cmd, args, timeoutMs, signal)
      } catch (error) {
        lastError = error
        if (!isHelperDown(error) || attempt === 1) throw error
        await this.restart()
      }
    }
    throw lastError
  }

  send(cmd, args, timeoutMs, signal) {
    const child = this.child
    if (child === null || this.exited) return Promise.reject(helperDownError('the computer-use helper is not running'))
    if (signal?.aborted) return Promise.reject(abortError())
    const id = ++this.seq
    const line = `${JSON.stringify({ id, cmd, args })}\n`
    return new Promise((resolve, reject) => {
      const fail = (error) => {
        this.pending.delete(id)
        clearTimeout(entry.timer)
        if (entry.onAbort !== undefined && entry.signal !== undefined) entry.signal.removeEventListener?.('abort', entry.onAbort)
        reject(error)
      }
      const entry = { resolve, reject, timer: undefined, onAbort: undefined, signal }
      entry.timer = setTimeout(() => {
        fail(new Error(`computer-use helper command "${cmd}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      if (typeof entry.timer.unref === 'function') entry.timer.unref()
      if (signal !== undefined) {
        entry.onAbort = () => fail(abortError())
        signal.addEventListener('abort', entry.onAbort, { once: true })
      }
      this.pending.set(id, entry)
      try {
        child.stdin.write(line)
      } catch (error) {
        fail(helperDownError(`could not write to the computer-use helper: ${errorMessage(error)}`))
      }
    })
  }

  async restart() {
    const child = this.child
    this.child = null
    this.exited = true
    this.rejectAll(helperDownError('the computer-use helper is restarting'))
    if (child !== null) {
      try {
        child.kill()
      } catch {
        /* the process is already gone */
      }
    }
    this.stderrTail = ''
  }

  rejectAll(error) {
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
  }

  killChild() {
    const child = this.child
    this.child = null
    this.exited = true
    if (child !== null) {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }
  }

  dispose() {
    if (this.stopped) return
    this.stopped = true
    const child = this.child
    this.child = null
    this.exited = true
    this.rejectAll(helperDownError('the computer-use plugin was unloaded'))
    if (child === null) return
    try {
      child.stdin.write('{"id":0,"cmd":"quit","args":{}}\n')
      child.stdin.end()
    } catch {
      /* the pipe is already closed */
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }, 500)
    if (typeof killTimer.unref === 'function') killTimer.unref()
    try {
      child.once('exit', () => clearTimeout(killTimer))
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Helper build
 * ------------------------------------------------------------------------- */

let cachedExe

function ensureHelperBuilt() {
  const override = process.env.DSH_COMPUTER_USE_HELPER
  if (typeof override === 'string' && override.trim().length > 0) return override
  if (cachedExe !== undefined && existsSync(cachedExe)) return cachedExe
  if (!existsSync(HELPER_SOURCE)) throw new Error(`missing helper source: ${HELPER_SOURCE}`)

  const cacheDir = join(process.env.LOCALAPPDATA ?? tmpdir(), 'dsh-computer-use')
  mkdirSync(cacheDir, { recursive: true })
  const exe = join(cacheDir, 'dsh-computer-helper.exe')
  const stampPath = join(cacheDir, 'helper.stamp')
  const stamp = helperSourceStamp()

  if (existsSync(exe) && existsSync(stampPath)) {
    try {
      if (readFileSync(stampPath, 'utf8').trim() === stamp) {
        cachedExe = exe
        return exe
      }
    } catch {
      /* rebuild below */
    }
  }

  const csc = findCsc()
  if (csc === undefined) throw new Error('csc.exe from .NET Framework 4.x was not found on this machine')
  const args = [
    '/nologo',
    '/target:winexe',
    '/optimize+',
    '/platform:anycpu',
    `/out:${exe}`,
    '/r:System.dll',
    '/r:System.Drawing.dll',
    '/r:System.Windows.Forms.dll',
    '/r:System.Web.Extensions.dll',
    HELPER_SOURCE,
  ]
  try {
    execFileSync(csc, args, { windowsHide: true, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const detail = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() || errorMessage(error)
    throw new Error(`csc.exe failed to compile the native helper: ${detail.slice(0, 1200)}`)
  }
  writeFileSync(stampPath, stamp)
  cachedExe = exe
  return exe
}

function helperSourceStamp() {
  return createHash('sha256').update(readFileSync(HELPER_SOURCE)).digest('hex')
}

function findCsc() {
  const explicit = process.env.DSH_COMPUTER_USE_CSC
  if (typeof explicit === 'string' && explicit.trim().length > 0) return existsSync(explicit) ? explicit : undefined
  const winDir = process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows'
  const candidates = [
    join(winDir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(winDir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ]
  return candidates.find((candidate) => existsSync(candidate))
}

function powershellPath() {
  const winDir = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows'
  const candidate = join(winDir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(candidate) ? candidate : 'powershell.exe'
}

/* ------------------------------------------------------------------------- *
 * Small helpers
 * ------------------------------------------------------------------------- */

function appendTail(current, chunk) {
  const next = `${current}${String(chunk)}`
  return next.length > MAX_STDERR_TAIL ? next.slice(next.length - MAX_STDERR_TAIL) : next
}

function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function helperDownError(message) {
  const error = new Error(message)
  error.code = 'E_HELPER_DOWN'
  return error
}

function isHelperDown(error) {
  return error !== null && typeof error === 'object' && error.code === 'E_HELPER_DOWN'
}

function abortError() {
  const error = new Error('the computer-use action was cancelled')
  error.name = 'AbortError'
  return error
}

function describeFailure(failure) {
  if (failure === null || typeof failure !== 'object') return 'the computer-use helper reported an unknown failure'
  const message = typeof failure.message === 'string' ? failure.message : 'the computer-use helper reported a failure'
  return typeof failure.code === 'string' ? `${message} (${failure.code})` : message
}

function textBlock(text) {
  return { type: 'text', text }
}

function jsonBlock(value) {
  return textBlock(JSON.stringify(value, null, 2))
}

function formatMonitors(monitors) {
  if (!Array.isArray(monitors) || monitors.length === 0) return 'unknown'
  return monitors
    .map((monitor) => {
      const label = `#${monitor.index} ${monitor.width}x${monitor.height} at (${monitor.x},${monitor.y})`
      return monitor.primary ? `${label} primary` : label
    })
    .join(' | ')
}

function formatCursor(cursor) {
  if (cursor === null || typeof cursor !== 'object') return 'unknown'
  return `${cursor.x},${cursor.y}`
}

function textLines(lines) {
  return lines.filter((line) => typeof line === 'string' && line.length > 0).join('\n')
}

/* ------------------------------------------------------------------------- *
 * Image return
 * ------------------------------------------------------------------------- */

async function resolveImageInput(ctx, exec) {
  try {
    const llm = ctx.get('llm')
    const routed = exec.agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? exec.agent?.options?.provider
    const model = routed?.model ?? exec.agent?.options?.model
    if (llm === undefined || llm === null || provider === undefined || model === undefined) {
      return { ok: false, reason: 'the current model route could not be resolved' }
    }
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    const modalities = info?.inputModalities
    if (!Array.isArray(modalities) || !modalities.includes('image')) {
      return { ok: false, reason: `model "${model}" does not declare image input` }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: errorMessage(error) }
  }
}

async function commitCapture(ctx, data, name) {
  const attachments = ctx.get('attachments')
  if (attachments === undefined || attachments === null) {
    return { ok: false, reason: 'no attachment service is mounted on this Host' }
  }
  try {
    const ref = await attachments.saveImage({ data, mediaType: 'image/png', name })
    const image = {
      attachmentId: String(ref.attachmentId),
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
    }
    if (typeof ref.name === 'string') image.name = ref.name
    return { ok: true, image }
  } catch (error) {
    return { ok: false, reason: errorMessage(error) }
  }
}

/* ------------------------------------------------------------------------- *
 * Tools
 * ------------------------------------------------------------------------- */

const COORDINATE_DESCRIPTION =
  'Physical-pixel coordinates in the virtual-screen space reported by computer_info (the primary monitor starts at virtualScreen.x/y).'

function buildToolDefinitions(ctx, helper, options) {
  let captureCounter = 0

  const infoTool = {
    name: 'computer_info',
    description:
      'Report the live Windows desktop: the virtual-screen rect, every monitor with its physical pixel rect, the current cursor position, the helper DPI-awareness and elevation state. Call this before coordinate-based actions and reuse the geometry it returns.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          osVersion: { type: 'string' },
          isElevated: { type: 'boolean' },
          dpiAwareness: { type: 'string' },
          virtualScreen: {
            type: 'object',
            additionalProperties: false,
            properties: {
              x: { type: 'integer' },
              y: { type: 'integer' },
              width: { type: 'integer' },
              height: { type: 'integer' },
            },
            required: ['x', 'y', 'width', 'height'],
          },
          monitors: { type: 'array', items: MONITOR_SCHEMA },
          cursor: { type: 'object', additionalProperties: false, properties: { x: { type: 'integer' }, y: { type: 'integer' } }, required: ['x', 'y'] },
          clipboardAvailable: { type: 'boolean' },
        },
        required: ['osVersion', 'isElevated', 'dpiAwareness', 'virtualScreen', 'monitors', 'cursor', 'clipboardAvailable'],
      },
      render: (_args, value) =>
        [jsonBlock(value)],
    },
    isConcurrencySafe: () => true,
    timeoutMs: options.helperTimeoutMs,
    async execute(_args, exec) {
      const raw = await helper.call('info', {}, { signal: exec.signal, timeoutMs: options.helperTimeoutMs })
      return normalizeInfo(raw)
    },
    presentCall: () => ({ card: 'generic', title: 'Inspect desktop', kind: 'read' }),
  }

  const screenshotTool = {
    name: 'computer_screenshot',
    description:
      'Capture the screen and return it as an image: the whole virtual desktop, one monitor, or an exact region. The reply states originX/originY and scale, so image pixel (ix, iy) maps to screen point (originX + ix*scale, originY + iy*scale). Capture a small region to read fine UI text at native resolution.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        monitor: {
          type: 'integer',
          description: '0-based monitor index from computer_info. Omit to capture the whole virtual desktop.',
        },
        region: {
          type: 'object',
          additionalProperties: false,
          properties: {
            x: { type: 'integer' },
            y: { type: 'integer' },
            width: { type: 'integer' },
            height: { type: 'integer' },
          },
          required: ['x', 'y', 'width', 'height'],
          description: `Exact capture region. ${COORDINATE_DESCRIPTION}`,
        },
        maxWidth: {
          type: 'integer',
          description:
            'Downscale the capture to at most this width before it is returned. Omit for the configured full-desktop limit; monitor and region captures default to native resolution (0 = no downscale).',
        },
        includeCursor: { type: 'boolean', description: 'Draw the mouse cursor into the image.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          width: { type: 'integer' },
          height: { type: 'integer' },
          originX: { type: 'integer' },
          originY: { type: 'integer' },
          scale: { type: 'number' },
          nativeWidth: { type: 'integer' },
          nativeHeight: { type: 'integer' },
          monitors: { type: 'array', items: MONITOR_SCHEMA },
          cursor: { type: 'object', additionalProperties: false, properties: { x: { type: 'integer' }, y: { type: 'integer' } }, required: ['x', 'y'] },
          image: { type: 'object', additionalProperties: false, properties: IMAGE_PROPERTIES, required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'] },
          capturePath: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['width', 'height', 'originX', 'originY', 'scale', 'nativeWidth', 'nativeHeight', 'monitors', 'cursor'],
      },
      render: (_args, value) => {
        const blocks = [textBlock(formatScreenshotText(value))]
        if (value.image !== undefined) blocks.push({ type: 'image', attachment: { ...value.image } })
        return blocks
      },
    },
    isConcurrencySafe: () => false,
    timeoutMs: options.screenshotTimeoutMs,
    async execute(args, exec) {
      const shotArgs = {}
      if (args.monitor !== undefined) shotArgs.monitor = args.monitor
      let regionGiven = false
      if (args.region !== undefined) {
        const region = args.region
        if (!Number.isInteger(region?.x) || !Number.isInteger(region?.y) || !Number.isInteger(region?.width) || !Number.isInteger(region?.height)) {
          throw new Error('region requires integer x, y, width and height')
        }
        if (region.width <= 0 || region.height <= 0) throw new Error('region width and height must be positive')
        shotArgs.x = region.x
        shotArgs.y = region.y
        shotArgs.width = region.width
        shotArgs.height = region.height
        regionGiven = true
      }
      const explicitMax = Number.isInteger(args.maxWidth) ? args.maxWidth : undefined
      const maxWidth = explicitMax ?? (regionGiven || args.monitor !== undefined ? 0 : options.screenshotMaxWidth)
      if (maxWidth > 0) shotArgs.maxWidth = maxWidth
      if (args.includeCursor === true) shotArgs.includeCursor = true

      mkdirSync(CAPTURE_DIR, { recursive: true })
      captureCounter += 1
      const capturePath = join(CAPTURE_DIR, `screen-${Date.now()}-${captureCounter}.png`)
      shotArgs.path = capturePath

      const [shot, info] = await Promise.all([
        helper.call('screenshot', shotArgs, { signal: exec.signal, timeoutMs: options.screenshotTimeoutMs }),
        helper.call('info', {}, { signal: exec.signal, timeoutMs: options.helperTimeoutMs }),
      ])

      const data = readFileSync(shot.path)
      const { capabilities, image } = await screenshotImage(ctx, exec, data, capturePath)
      let note
      let keptPath
      if (image === undefined) {
        keptPath = shot.path
        note = `the image could not be attached to this reply (${capabilities.reason}); the PNG is still on disk at ${shot.path}`
      } else {
        rmSync(shot.path, { force: true })
      }

      const scale = Number(shot.scale) > 0 ? Number(shot.scale) : 1
      const value = {
        width: Math.round(Number(shot.width)),
        height: Math.round(Number(shot.height)),
        originX: Math.round(Number(shot.originX)),
        originY: Math.round(Number(shot.originY)),
        scale,
        nativeWidth: Math.round(Number(shot.width) * scale),
        nativeHeight: Math.round(Number(shot.height) * scale),
        monitors: normalizeMonitors(info?.monitors),
        cursor: normalizeCursor(info?.cursor),
      }
      if (image !== undefined) value.image = image
      if (keptPath !== undefined) value.capturePath = keptPath
      if (note !== undefined) value.note = note
      return value
    },
    presentCall: (args) => ({
      card: 'generic',
      title:
        args.region !== undefined
          ? `Capture screen region ${args.region.width}x${args.region.height} at (${args.region.x},${args.region.y})`
          : args.monitor !== undefined
            ? `Capture monitor ${args.monitor}`
            : 'Capture screen',
      kind: 'read',
    }),
  }

  const moveTool = {
    name: 'computer_mouse_move',
    description: `Move the mouse pointer with an absolute virtual-desktop move. ${COORDINATE_DESCRIPTION}`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        x: { type: 'integer', description: 'Target screen x in physical pixels.' },
        y: { type: 'integer', description: 'Target screen y in physical pixels.' },
      },
      required: ['x', 'y'],
    },
    output: { schema: POINT_SCHEMA, render: (_args, value) => [textBlock(`Pointer moved to (${value.x}, ${value.y}).`)] },
    isConcurrencySafe: () => false,
    timeoutMs: options.helperTimeoutMs,
    async execute(args, exec) {
      const result = await helper.call('move', { x: requireInt(args, 'x'), y: requireInt(args, 'y') }, { signal: exec.signal })
      return { x: Math.round(Number(result.x)), y: Math.round(Number(result.y)) }
    },
    presentCall: (args) => ({ card: 'generic', title: `Move pointer to (${args.x}, ${args.y})`, kind: 'other' }),
  }

  const clickTool = {
    name: 'computer_click',
    description:
      'Click a mouse button for real. Give x/y to move first, or omit them to click wherever the pointer already is (for example after computer_mouse_move). count=2 is a double click.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        x: { type: 'integer', description: `Optional click x. ${COORDINATE_DESCRIPTION}` },
        y: { type: 'integer', description: 'Optional click y.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button; default left.' },
        count: { type: 'integer', description: 'Number of clicks; default 1, 2 for a double click.' },
        intervalMs: { type: 'integer', description: 'Gap between repeated clicks; default 40.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          x: { type: 'integer' },
          y: { type: 'integer' },
          button: { type: 'string' },
          count: { type: 'integer' },
        },
        required: ['x', 'y', 'button', 'count'],
      },
      render: (_args, value) => [textBlock(`${value.button} click x${value.count} at (${value.x}, ${value.y}).`)],
    },
    isConcurrencySafe: () => false,
    timeoutMs: options.helperTimeoutMs,
    async execute(args, exec) {
      const payload = {
        button: args.button ?? 'left',
        count: Number.isInteger(args.count) ? args.count : 1,
      }
      if (Number.isInteger(args.intervalMs)) payload.intervalMs = args.intervalMs
      if (args.x !== undefined || args.y !== undefined) {
        payload.x = requireInt(args, 'x')
        payload.y = requireInt(args, 'y')
      }
      const result = await helper.call('click', payload, { signal: exec.signal })
      return {
        x: Math.round(Number(result.x)),
        y: Math.round(Number(result.y)),
        button: String(result.button),
        count: Math.round(Number(result.count)),
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `${args.button ?? 'left'} click${args.count !== undefined && args.count > 1 ? ` x${args.count}` : ''}${args.x !== undefined ? ` at (${args.x}, ${args.y})` : ''}`,
      kind: 'other',
    }),
  }

  const dragTool = {
    name: 'computer_drag',
    description: `Press, move and release with the mouse — text selection, slider drags, window moves. ${COORDINATE_DESCRIPTION}`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fromX: { type: 'integer', description: 'Start x.' },
        fromY: { type: 'integer', description: 'Start y.' },
        toX: { type: 'integer', description: 'End x.' },
        toY: { type: 'integer', description: 'End y.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button; default left.' },
        durationMs: { type: 'integer', description: 'Drag duration; default 300.' },
      },
      required: ['fromX', 'fromY', 'toX', 'toY'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fromX: { type: 'integer' },
          fromY: { type: 'integer' },
          toX: { type: 'integer' },
          toY: { type: 'integer' },
          button: { type: 'string' },
        },
        required: ['fromX', 'fromY', 'toX', 'toY'],
      },
      render: (_args, value) => [textBlock(`Dragged from (${value.fromX}, ${value.fromY}) to (${value.toX}, ${value.toY}).`)],
    },
    isConcurrencySafe: () => false,
    timeoutMs: options.helperTimeoutMs,
    async execute(args, exec) {
      const payload = {
        fromX: requireInt(args, 'fromX'),
        fromY: requireInt(args, 'fromY'),
        toX: requireInt(args, 'toX'),
        toY: requireInt(args, 'toY'),
        button: args.button ?? 'left',
      }
      if (Number.isInteger(args.durationMs)) payload.durationMs = args.durationMs
      const result = await helper.call('drag', payload, { signal: exec.signal })
      return {
        fromX: Math.round(Number(result.fromX)),
        fromY: Math.round(Number(result.fromY)),
        toX: Math.round(Number(result.toX)),
        toY: Math.round(Number(result.toY)),
        button: String(result.button ?? payload.button),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `Drag (${args.fromX}, ${args.fromY}) → (${args.toX}, ${args.toY})`, kind: 'other' }),
  }

  const scrollTool = {
    name: 'computer_scroll',
    description:
      'Scroll with the mouse wheel at the pointer (or at x/y after moving there). dy is in wheel notches: positive scrolls down, negative up. dx scrolls horizontally.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        x: { type: 'integer', description: 'Optional x to move the pointer to before scrolling.' },
        y: { type: 'integer', description: 'Optional y to move the pointer to before scrolling.' },
        dy: { type: 'integer', description: 'Vertical notches; positive = down.' },
        dx: { type: 'integer', description: 'Horizontal notches; positive = right.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          x: { type: 'integer' },
          y: { type: 'integer' },
          dy: { type: 'integer' },
          dx: { type: 'integer' },
        },
        required: ['x', 'y', 'dy', 'dx'],
      },
      render: (_args, value) => [textBlock(`Scrolled dy=${value.dy} dx=${value.dx} at (${value.x}, ${value.y}).`)],
    },
    isConcurrencySafe: () => false,
    timeoutMs: options.helperTimeoutMs,
    async execute(args, exec) {
      const payload = { dy: Number.isInteger(args.dy) ? args.dy : 0, dx: Number.isInteger(args.dx) ? args.dx : 0 }
      if (payload.dy === 0 && payload.dx === 0) throw new Error('scroll needs a non-zero dy or dx')
      if (args.x !== undefined || args.y !== undefined) {
        payload.x = requireInt(args, 'x')
        payload.y = requireInt(args, 'y')
      }
      const result = await helper.call('scroll', payload, { signal: exec.signal })
      return {
        x: Math.round(Number(result.x)),
        y: Math.round(Number(result.y)),
        dy: Math.round(Number(result.dy ?? payload.dy)),
        dx: Math.round(Number(result.dx ?? payload.dx)),
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Scroll dy=${args.dy ?? 0} dx=${args.dx ?? 0}${args.x !== undefined ? ` at (${args.x}, ${args.y})` : ''}`,
      kind: 'other',
    }),
  }

  const typeTool = {
    name: 'computer_type',
    description:
      'Type text into the focused control as real Unicode keystrokes. Use it for prose and data entry; send "\\n" for Enter and "\\t" for Tab, and use computer_key for shortcuts and special keys. Click the target field first when focus is uncertain.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'Text to type. Newlines are Enter, tabs are Tab.' },
        intervalMs: { type: 'integer', description: 'Delay between characters; default 0, raise it for slow apps.' },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          characters: { type: 'integer' },
          method: { type: 'string' },
        },
        required: ['characters'],
      },
      render: (_args, value) => [textBlock(`Typed ${value.characters} character(s) with ${value.method ?? 'unicode'} input.`)],
    },
    isConcurrencySafe: () => false,
    timeoutMs: options.screenshotTimeoutMs,
    async execute(args, exec) {
      if (typeof args.text !== 'string') throw new Error('text must be a string')
      const payload = { text: args.text }
      if (Number.isInteger(args.intervalMs)) payload.intervalMs = args.intervalMs
      const result = await helper.call('type', payload, { signal: exec.signal, timeoutMs: options.screenshotTimeoutMs })
      return {
        characters: Math.round(Number(result.characters ?? args.text.length)),
        method: typeof result.method === 'string' ? result.method : 'unicode',
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Type ${typeof args.text === 'string' ? args.text.length : 0} character(s)`,
      kind: 'other',
    }),
  }

  const keyTool = {
    name: 'computer_key',
    description:
      'Press keys and shortcuts as real key events. A single string is one chord ("ctrl+shift+t"); an array is a sequence of chords (["ctrl+a", "delete"]). Modifiers: ctrl, shift, alt, win. Named keys: enter, tab, escape, space, backspace, delete, insert, home, end, pageup, pagedown, up, down, left, right, f1..f24, and punctuation names such as minus, period, slash. A single printable character also works.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        keys: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
          description: 'One chord as a string, or an array of chords to press in order.',
        },
        action: { type: 'string', enum: ['press', 'down', 'up'], description: 'press (default), or hold/release for cooperating with other input.' },
        repeat: { type: 'integer', description: 'Times to repeat each chord; default 1.' },
      },
      required: ['keys'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          keys: { type: 'array', items: { type: 'string' } },
          action: { type: 'string' },
        },
        required: ['keys', 'action'],
      },
      render: (_args, value) => [textBlock(`Sent ${value.action} for ${value.keys.join(', ')}.`)],
    },
    isConcurrencySafe: () => false,
    timeoutMs: options.helperTimeoutMs,
    async execute(args, exec) {
      const payload = { keys: args.keys }
      if (typeof args.action === 'string') payload.action = args.action
      if (Number.isInteger(args.repeat)) payload.repeat = args.repeat
      const result = await helper.call('key', payload, { signal: exec.signal })
      return {
        keys: Array.isArray(result.keys) ? result.keys.map((key) => String(key)) : [String(args.keys)],
        action: typeof result.action === 'string' ? result.action : 'press',
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Press ${Array.isArray(args.keys) ? args.keys.join(' then ') : args.keys}`,
      kind: 'other',
    }),
  }

  const clipboardTool = {
    name: 'computer_clipboard',
    description:
      'Read or write the real Windows clipboard. action=get returns the text, set replaces it with text, clear empties it. Useful for moving large text in and out of applications.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'clear'], description: 'Clipboard operation.' },
        text: { type: 'string', description: 'Text for action=set.' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          text: { type: 'string' },
          length: { type: 'integer' },
        },
        required: ['action'],
      },
      render: (_args, value) => {
        if (value.action === 'get') return [textBlock(`Clipboard text (${value.length ?? 0} characters):\n${value.text ?? ''}`)]
        return [textBlock(`Clipboard ${value.action} completed${value.length !== undefined ? ` (${value.length} characters)` : ''}.`)]
      },
    },
    isConcurrencySafe: () => false,
    timeoutMs: options.helperTimeoutMs,
    async execute(args, exec) {
      const payload = { action: args.action }
      if (args.action === 'set') {
        if (typeof args.text !== 'string') throw new Error('action=set requires text')
        payload.text = args.text
      }
      const result = await helper.call('clipboard', payload, { signal: exec.signal })
      const value = { action: String(args.action) }
      if (typeof result.text === 'string') value.text = result.text
      if (result.text !== undefined || args.action === 'get') {
        value.length = typeof result.text === 'string' ? result.text.length : 0
      }
      if (args.action === 'set' && Number.isInteger(result.length)) value.length = result.length
      return value
    },
    presentCall: (args) => ({ card: 'generic', title: `Clipboard ${args.action}`, kind: 'other' }),
  }

  const windowsTool = {
    name: 'computer_windows',
    description:
      'List top-level windows with handle, title, class, owning process, rect and state. Use it to find the window to focus or close, or to check what is currently on screen.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        includeHidden: { type: 'boolean', description: 'Include hidden/tool windows; default false.' },
        titleContains: { type: 'string', description: 'Only windows whose title contains this text (case-insensitive).' },
        limit: { type: 'integer', description: 'Maximum windows to return; default 200.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer' },
          windows: { type: 'array', items: WINDOW_SCHEMA },
        },
        required: ['count', 'windows'],
      },
      render: (_args, value) => [textBlock(formatWindows(value))],
    },
    isConcurrencySafe: () => true,
    timeoutMs: options.helperTimeoutMs,
    async execute(args, exec) {
      const payload = {}
      if (args.includeHidden === true) payload.includeHidden = true
      if (typeof args.titleContains === 'string' && args.titleContains.length > 0) payload.titleContains = args.titleContains
      if (Number.isInteger(args.limit)) payload.limit = args.limit
      const result = await helper.call('windows', payload, { signal: exec.signal })
      const windows = Array.isArray(result.windows) ? result.windows : []
      return { count: windows.length, windows }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.titleContains !== undefined ? `List windows matching "${args.titleContains}"` : 'List windows',
      kind: 'read',
    }),
  }

  const windowControlTool = {
    name: 'computer_window_control',
    description:
      'Manipulate one top-level window: focus, minimize, maximize, restore or close. Select it by handle from computer_windows, or by the first visible window whose title contains titleContains.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['focus', 'minimize', 'maximize', 'restore', 'close'], description: 'Operation to perform.' },
        handle: { type: 'integer', description: 'Window handle from computer_windows.' },
        titleContains: { type: 'string', description: 'Case-insensitive title fragment when handle is unknown.' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          handle: { type: 'integer' },
          title: { type: 'string' },
          action: { type: 'string' },
        },
        required: ['handle', 'title', 'action'],
      },
      render: (_args, value) => [textBlock(`${value.action}: "${value.title}" (handle ${value.handle}).`)],
    },
    isConcurrencySafe: () => false,
    timeoutMs: options.helperTimeoutMs,
    async execute(args, exec) {
      const payload = { action: args.action }
      if (Number.isInteger(args.handle)) payload.handle = args.handle
      if (typeof args.titleContains === 'string' && args.titleContains.length > 0) payload.titleContains = args.titleContains
      if (payload.handle === undefined && payload.titleContains === undefined) {
        throw new Error('window control needs handle or titleContains')
      }
      const result = await helper.call('window', payload, { signal: exec.signal })
      return {
        handle: Math.round(Number(result.handle)),
        title: String(result.title ?? ''),
        action: String(result.action ?? args.action),
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `${args.action} window${args.handle !== undefined ? ` ${args.handle}` : ` "${args.titleContains ?? ''}"`}`,
      kind: 'other',
    }),
  }

  const launchTool = {
    name: 'computer_launch',
    description:
      'Launch an application, open a file/path with its default handler, or open a URL, through the Windows shell (like Win+R / Start menu). Use computer_windows afterwards to find and focus the new window.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string', description: 'Executable name ("notepad"), absolute path, document path or URL.' },
        arguments: { type: 'string', description: 'Optional command-line arguments.' },
        waitMs: { type: 'integer', description: 'Milliseconds to wait after launch so the window can appear; default 900.' },
      },
      required: ['target'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string' },
          launched: { type: 'boolean' },
          processId: { type: 'integer' },
        },
        required: ['target', 'launched'],
      },
      render: (_args, value) => [
        textBlock(`Launched ${value.target}${value.processId !== undefined ? ` (pid ${value.processId})` : ''}.`),
      ],
    },
    isConcurrencySafe: () => false,
    timeoutMs: options.helperTimeoutMs,
    async execute(args, exec) {
      if (typeof args.target !== 'string' || args.target.trim().length === 0) throw new Error('target must be a non-empty string')
      const payload = { target: args.target.trim() }
      if (typeof args.arguments === 'string' && args.arguments.length > 0) payload.arguments = args.arguments
      payload.waitMs = Number.isInteger(args.waitMs) ? args.waitMs : 900
      const result = await helper.call('launch', payload, { signal: exec.signal, timeoutMs: options.helperTimeoutMs })
      const value = { target: payload.target, launched: result.launched !== false }
      if (Number.isInteger(result.processId)) value.processId = result.processId
      return value
    },
    presentCall: (args) => ({ card: 'generic', title: `Launch ${args.target}`, kind: 'execute' }),
  }

  return [
    infoTool,
    screenshotTool,
    moveTool,
    clickTool,
    dragTool,
    scrollTool,
    typeTool,
    keyTool,
    clipboardTool,
    windowsTool,
    windowControlTool,
    launchTool,
  ]
}

/* ------------------------------------------------------------------------- *
 * Schemas and formatting
 * ------------------------------------------------------------------------- */

const MONITOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    index: { type: 'integer' },
    x: { type: 'integer' },
    y: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    primary: { type: 'boolean' },
    deviceName: { type: 'string' },
  },
  required: ['index', 'x', 'y', 'width', 'height', 'primary'],
}

const POINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { x: { type: 'integer' }, y: { type: 'integer' } },
  required: ['x', 'y'],
}

const IMAGE_PROPERTIES = {
  attachmentId: { type: 'string' },
  mediaType: { type: 'string' },
  bytes: { type: 'integer' },
  width: { type: 'integer' },
  height: { type: 'integer' },
  name: { type: 'string' },
}

const WINDOW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    handle: { type: 'integer' },
    title: { type: 'string' },
    className: { type: 'string' },
    processId: { type: 'integer' },
    processName: { type: 'string' },
    rect: {
      type: 'object',
      additionalProperties: false,
      properties: {
        x: { type: 'integer' },
        y: { type: 'integer' },
        width: { type: 'integer' },
        height: { type: 'integer' },
      },
      required: ['x', 'y', 'width', 'height'],
    },
    minimized: { type: 'boolean' },
    maximized: { type: 'boolean' },
    foreground: { type: 'boolean' },
    monitorIndex: { type: 'integer' },
  },
  required: ['handle', 'title', 'className', 'processId', 'rect', 'minimized', 'maximized', 'foreground'],
}

function normalizeMonitors(monitors) {
  if (!Array.isArray(monitors)) return []
  return monitors.map((monitor, index) => ({
    index: Number.isFinite(Number(monitor?.index)) ? Math.round(Number(monitor.index)) : index,
    x: Math.round(Number(monitor?.x ?? 0)),
    y: Math.round(Number(monitor?.y ?? 0)),
    width: Math.round(Number(monitor?.width ?? 0)),
    height: Math.round(Number(monitor?.height ?? 0)),
    primary: monitor?.primary === true,
    ...(typeof monitor?.deviceName === 'string' ? { deviceName: monitor.deviceName } : {}),
  }))
}

function normalizeCursor(cursor) {
  return { x: Math.round(Number(cursor?.x ?? 0)), y: Math.round(Number(cursor?.y ?? 0)) }
}

function normalizeInfo(raw) {
  const virtualScreen = raw?.virtualScreen ?? {}
  return {
    osVersion: String(raw?.osVersion ?? 'unknown'),
    isElevated: raw?.isElevated === true,
    dpiAwareness: String(raw?.dpiAwareness ?? 'unknown'),
    virtualScreen: {
      x: Math.round(Number(virtualScreen.x ?? 0)),
      y: Math.round(Number(virtualScreen.y ?? 0)),
      width: Math.round(Number(virtualScreen.width ?? 0)),
      height: Math.round(Number(virtualScreen.height ?? 0)),
    },
    monitors: normalizeMonitors(raw?.monitors),
    cursor: normalizeCursor(raw?.cursor),
    clipboardAvailable: raw?.clipboard?.available !== false,
  }
}

function formatScreenshotText(value) {
  const lines = [
    `<capture ${value.width}x${value.height} px from origin (${value.originX},${value.originY}), scale ${value.scale}>`,
    `screen_x = ${value.originX} + image_x * ${value.scale}; screen_y = ${value.originY} + image_y * ${value.scale} (native ${value.nativeWidth}x${value.nativeHeight})`,
    `monitors: ${formatMonitors(value.monitors)}`,
    `cursor: ${formatCursor(value.cursor)}`,
  ]
  if (value.capturePath !== undefined) lines.push(`png: ${value.capturePath}`)
  if (value.note !== undefined) lines.push(`note: ${value.note}`)
  return lines.join('\n')
}

function formatWindows(value) {
  const rows = value.windows.map((window) => {
    const state = window.foreground ? 'focused' : window.minimized ? 'minimized' : window.maximized ? 'maximized' : 'normal'
    const title = window.title.length > 90 ? `${window.title.slice(0, 87)}...` : window.title
    return `handle=${window.handle} [${state}] pid=${window.processId}${window.processName ? ` ${window.processName}` : ''} rect=${window.rect.x},${window.rect.y} ${window.rect.width}x${window.rect.height} :: ${title || '(untitled)'}`
  })
  return [`${value.count} window(s)`, ...rows].join('\n')
}

async function screenshotImage(ctx, exec, data, capturePath) {
  const capabilities = await resolveImageInput(ctx, exec)
  if (!capabilities.ok) return { capabilities, image: undefined }
  const committed = await commitCapture(ctx, data, basename(capturePath))
  if (!committed.ok) return { capabilities: committed, image: undefined }
  return { capabilities, image: committed.image }
}

/* ------------------------------------------------------------------------- *
 * Argument validation
 * ------------------------------------------------------------------------- */

function requireInt(args, key) {
  const value = args?.[key]
  if (!Number.isInteger(value)) throw new Error(`${key} must be an integer`)
  return value
}

function normalizeConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const options = { ...DEFAULTS }
  if (Number.isInteger(source.screenshotMaxWidth) && source.screenshotMaxWidth >= 0) {
    options.screenshotMaxWidth = source.screenshotMaxWidth
  }
  if (Number.isInteger(source.helperTimeoutMs) && source.helperTimeoutMs > 0) {
    options.helperTimeoutMs = source.helperTimeoutMs
  }
  if (Number.isInteger(source.screenshotTimeoutMs) && source.screenshotTimeoutMs > 0) {
    options.screenshotTimeoutMs = source.screenshotTimeoutMs
  }
  return options
}

/* ------------------------------------------------------------------------- *
 * Optional computer-use provider slot
 * ------------------------------------------------------------------------- */

/**
 * Claim the deployment's single computer-use provider slot when the optional
 * `computerUse` service is mounted, so a second provider cannot also drive the
 * desktop. Absence of the service is normal and not an error.
 */
function claimProviderSlot(ctx, helper) {
  ctx.effect(() => {
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('computerUse') : undefined
      if (service === undefined || service === null || typeof service.register !== 'function') return () => {}
      const disposer = service.register('windows-win32')
      return () => {
        void Promise.resolve(typeof disposer === 'function' ? disposer() : undefined).catch(() => {})
        helper.dispose()
      }
    } catch (error) {
      ctx.logger?.debug?.(`computer-use provider slot not claimed: ${errorMessage(error)}`)
      return () => {}
    }
  })
}

/* ------------------------------------------------------------------------- *
 * Plugin entry
 * ------------------------------------------------------------------------- */

export function apply(ctx, config) {
  if (process.platform !== 'win32') {
    ctx.logger?.info?.('dsh-computer-use-windows: this plugin only drives Windows desktops')
    return
  }
  const options = normalizeConfig(config)
  const helper = new HelperProcess(ctx, options)
  ctx.effect(() => () => helper.dispose())
  claimProviderSlot(ctx, helper)
  for (const definition of buildToolDefinitions(ctx, helper, options)) {
    ctx.effect(() => ctx.tools.register(definition))
  }
}
