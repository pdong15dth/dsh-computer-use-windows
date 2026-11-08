/**
 * dsh-computer-use-windows — now powered by agent-desktop.
 *
 * The plugin no longer ships its own native input helper. Every observation and
 * action is an `agent-desktop` CLI call: the official Vercel Labs binary that
 * reads and drives desktop apps through the OS accessibility tree
 * (UI Automation on Windows, AX on macOS, AT-SPI on Linux).
 *
 * The model-facing loop is agent-desktop's own: `desktop_snapshot` returns a
 * tree with qualified refs (`@<snapshot_id>:eN`), `desktop_act` / `desktop_type`
 * act on those refs, and a fresh snapshot verifies the result. Refs belong to
 * one snapshot; a stale ref is refused instead of acting blindly.
 *
 * Requirements: `agent-desktop` installed and on PATH (`npm install -g agent-desktop`),
 * or point `binPath` / `DSH_AGENT_DESKTOP_BIN` at the native binary.
 *
 * @module dsh-computer-use-windows
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'

export const name = 'computer-use-windows'
export const inject = ['tools']

const CAPTURE_DIR = join(tmpdir(), 'dsh-agent-desktop')

const DEFAULTS = {
  binPath: '',
  defaultTimeoutMs: 60000,
  snapshotTimeoutMs: 120000,
  typeTimeoutMs: 120000,
  screenshotTimeoutMs: 60000,
}

/** Commands that need physical delivery on Windows; the CLI refuses them headless. */
const WINDOWS_HEADED_COMMANDS = new Set([
  'type',
  'right-click',
  'double-click',
  'triple-click',
  'focus',
  'drag',
  'hover',
  'mouse-click',
  'mouse-move',
  'mouse-wheel',
])

/* ------------------------------------------------------------------------- *
 * CLI resolution
 * ------------------------------------------------------------------------- */

let cachedCli

function binaryName() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'win32') return `agent-desktop-win32-${arch}.exe`
  return `agent-desktop-${process.platform}-${arch}`
}

function npmGlobalRoots() {
  const roots = []
  const appData = process.env.APPDATA
  if (appData) roots.push(join(appData, 'npm', 'node_modules'))
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (home) {
    roots.push(join(home, '.npm-global', 'lib', 'node_modules'))
    roots.push(join(home, '.local', 'lib', 'node_modules'))
  }
  roots.push('/usr/local/lib/node_modules')
  roots.push('/opt/homebrew/lib/node_modules')
  roots.push('/usr/lib/node_modules')
  return roots
}

function candidateRoots() {
  const roots = []
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir.length === 0) continue
    roots.push(join(dir, 'node_modules'))
  }
  roots.push(...npmGlobalRoots())
  return roots
}

function findBinary(explicit) {
  if (explicit) return existsSync(explicit) ? explicit : undefined
  const pkg = join('agent-desktop', 'bin', binaryName())
  for (const root of candidateRoots()) {
    const candidate = join(root, pkg)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function findLauncher() {
  const launcher = join('agent-desktop', 'bin', 'agent-desktop')
  for (const root of candidateRoots()) {
    const candidate = join(root, launcher)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function resolveCli(options) {
  if (cachedCli !== undefined) return cachedCli
  const explicit = options.binPath || process.env.DSH_AGENT_DESKTOP_BIN || ''
  const binary = findBinary(explicit)
  if (binary !== undefined) {
    cachedCli = { command: binary, args: [], label: binary }
    return cachedCli
  }
  if (explicit) throw new Error(`DSH_AGENT_DESKTOP_BIN/binPath points at a missing file: ${explicit}`)
  const launcher = findLauncher()
  if (launcher !== undefined) {
    const node = process.env.DSH_NODE_EXECUTABLE || 'node'
    cachedCli = { command: node, args: [launcher], label: `${node} ${launcher}` }
    return cachedCli
  }
  throw new Error(
    'agent-desktop was not found. Install it with `npm install -g agent-desktop`, or set the plugin\'s `binPath` config (or DSH_AGENT_DESKTOP_BIN) to the native binary, e.g. %APPDATA%\\npm\\node_modules\\agent-desktop\\bin\\agent-desktop-win32-x64.exe',
  )
}

/* ------------------------------------------------------------------------- *
 * CLI execution
 * ------------------------------------------------------------------------- */

function parseEnvelope(stdout, stderr, label) {
  const text = (stdout ?? '').trim()
  if (text.length === 0) {
    const detail = (stderr ?? '').trim()
    throw new Error(`agent-desktop ${label} produced no stdout${detail ? `: ${detail.slice(0, 500)}` : ''}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    /* fall through to line scan */
  }
  const lines = text.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (line.startsWith('{') && line.endsWith('}')) {
      try {
        return JSON.parse(line)
      } catch {
        continue
      }
    }
  }
  throw new Error(`agent-desktop ${label} returned non-JSON output: ${text.slice(0, 500)}`)
}

function failure(envelope, label) {
  const error = envelope?.error ?? {}
  const code = typeof error.code === 'string' ? error.code : 'UNKNOWN'
  const message = typeof error.message === 'string' ? error.message : 'command failed'
  const suggestion = typeof error.suggestion === 'string' ? ` — ${error.suggestion}` : ''
  const disposition = error.disposition ?? {}
  const retry = typeof disposition.retry === 'string' ? ` [retry: ${disposition.retry}, delivery: ${String(disposition.delivery)}]` : ''
  const wrapped = new Error(`agent-desktop ${label} failed: ${code}: ${message}${suggestion}${retry}`)
  wrapped.code = code
  wrapped.details = error.details
  wrapped.disposition = disposition
  return wrapped
}

function runCli(cli, argv, { input, timeoutMs, signal, label }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli.command, [...cli.args, ...argv], {
      windowsHide: true,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const chunks = []
    const errChunks = []
    let size = 0
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      reject(new Error(`agent-desktop ${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    const onAbort = () => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      reject(new Error(`agent-desktop ${label} was cancelled`))
    }
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024 * 1024) {
        try {
          child.kill()
        } catch {
          /* ignore */
        }
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on('data', (chunk) => errChunks.push(chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener?.('abort', onAbort)
      reject(new Error(`could not start agent-desktop (${cli.label}): ${error.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener?.('abort', onAbort)
      const stdout = Buffer.concat(chunks).toString('utf8')
      const stderr = Buffer.concat(errChunks).toString('utf8')
      let envelope
      try {
        envelope = parseEnvelope(stdout, stderr, label)
      } catch (error) {
        reject(error)
        return
      }
      if (envelope.ok === false) {
        reject(failure(envelope, label))
        return
      }
      resolve({ envelope, stderr, code })
    })
    if (input !== undefined) {
      child.stdin.end(input, 'utf8')
    } else {
      child.stdin.end()
    }
  })
}

/* ------------------------------------------------------------------------- *
 * Command helpers
 * ------------------------------------------------------------------------- */

function flag(name, value) {
  return value === undefined || value === null ? [] : [name, String(value)]
}

function boolFlag(name, enabled) {
  return enabled === true ? [name] : []
}

function needsHeaded(command, options, args) {
  if (args?.headed === false) return false
  if (args?.headed === true) return true
  if (options.preferHeaded === true) return true
  return process.platform === 'win32' && WINDOWS_HEADED_COMMANDS.has(command)
}

function headedArgs(command, options, args) {
  return needsHeaded(command, options, args) ? ['--headed'] : []
}

async function invoke(cli, options, command, argv, { input, timeoutMs, signal, label } = {}) {
  const { envelope } = await runCli(cli, [command, ...argv], {
    input,
    timeoutMs: timeoutMs ?? options.defaultTimeoutMs,
    signal,
    label: label ?? command,
  })
  return envelope
}

/* ------------------------------------------------------------------------- *
 * Tools
 * ------------------------------------------------------------------------- */

const REF_DESCRIPTION =
  'Qualified ref from the latest snapshot, e.g. "@s8f3k2p9:e1". Refs belong to one snapshot; after the UI changes the CLI refuses a stale ref, so take a new snapshot.'

const APP_DESCRIPTION = 'Application name or image, e.g. "notepad.exe" (see desktop_apps list).'

const SURFACES = [
  'window', 'focused', 'menu', 'menubar', 'sheet', 'popover', 'alert', 'desktop', 'taskbar',
  'system-tray', 'quick-settings', 'notification-center', 'toolbar', 'dock', 'spotlight',
  'menu-bar-extras', 'system-tray-overflow', 'start-menu', 'action-center',
]

function textBlock(text) {
  return { type: 'text', text }
}

function jsonText(value) {
  return JSON.stringify(value, null, 2)
}

/**
 * Tool results must be object-rooted. agent-desktop `data` is usually an
 * object, but list commands can return an array; keep the fields flat when
 * possible and fall back to `{ command, data }` otherwise.
 */
function toolValue(envelope, extra = {}) {
  const data = envelope?.data
  const base = data !== null && typeof data === 'object' && !Array.isArray(data)
    ? { command: envelope.command, ...data }
    : { command: envelope.command, data: data ?? null }
  return { ...base, ...extra }
}

const LOOSE_OUTPUT = {
  type: 'object',
  additionalProperties: true,
}

function buildTools(ctx, cli, options) {
  let captureCounter = 0

  const statusTool = {
    name: 'desktop_status',
    description:
      'Report agent-desktop health for this machine: platform, permissions, supported surfaces, state root, session and the latest snapshot. Call it once before the first observation.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: LOOSE_OUTPUT, render: (_args, value) => [textBlock(jsonText(value))] },
    isConcurrencySafe: () => true,
    timeoutMs: 30000,
    async execute(_args, exec) {
      const envelope = await invoke(cli, options, 'status', [], { signal: exec.signal, timeoutMs: 30000 })
      return toolValue(envelope)
    },
    presentCall: () => ({ card: 'generic', title: 'Desktop status', kind: 'read' }),
  }

  const snapshotTool = {
    name: 'desktop_snapshot',
    description:
      'Read an application accessibility tree as JSON with a ref on every actionable element. This is the primary observation: act on refs, then snapshot again to verify. Use interactive_only + compact for a readable tree, skeleton to map a dense app first and root to drill into one region.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        app: { type: 'string', description: APP_DESCRIPTION },
        window_id: { type: 'string', description: 'Window id from desktop_windows list, to scope one window.' },
        root: { type: 'string', description: 'Drill from this ref instead of the window root; the same snapshot id keeps the existing refs.' },
        surface: { type: 'string', enum: SURFACES, description: 'Surface to read instead of a window (focused, menu, sheet, alert, desktop, taskbar, …).' },
        interactive_only: { type: 'boolean', description: 'Keep interactive elements only (drops static text).' },
        compact: { type: 'boolean', description: 'Collapse single-child unnamed nodes to reduce depth.' },
        skeleton: { type: 'boolean', description: 'Shallow overview with children_count on truncated containers; then drill with root.' },
        max_depth: { type: 'integer', description: 'Maximum tree depth (default 10).' },
        include_bounds: { type: 'boolean', description: 'Include element bounds (x, y, width, height).' },
        wait_for: { type: 'string', description: 'Poll until an element matching the role:text selector appears.' },
        wait_for_gone: { type: 'string', description: 'Poll until no element matches the role:text selector.' },
        timeout_ms: { type: 'integer', description: 'Observation deadline in milliseconds (default 3000; raise for slow Chromium/Electron settles).' },
      },
    },
    output: { schema: LOOSE_OUTPUT, render: (_args, value) => [textBlock(jsonText(value))] },
    isConcurrencySafe: () => false,
    timeoutMs: options.snapshotTimeoutMs,
    async execute(args, exec) {
      const argv = [
        ...flag('--app', args.app),
        ...flag('--window-id', args.window_id),
        ...flag('--root', args.root),
        ...flag('--surface', args.surface),
        ...boolFlag('-i', args.interactive_only),
        ...boolFlag('--compact', args.compact),
        ...boolFlag('--skeleton', args.skeleton),
        ...flag('--max-depth', args.max_depth),
        ...boolFlag('--include-bounds', args.include_bounds),
        ...flag('-w', args.wait_for),
        ...flag('--wait-for-gone', args.wait_for_gone),
        ...flag('--timeout-ms', args.timeout_ms),
      ]
      const envelope = await invoke(cli, options, 'snapshot', argv, {
        signal: exec.signal,
        timeoutMs: options.snapshotTimeoutMs,
      })
      return toolValue(envelope)
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.app !== undefined ? `Snapshot ${args.app}` : args.surface !== undefined ? `Snapshot ${args.surface}` : 'Snapshot desktop',
      kind: 'read',
    }),
  }

  const findTool = {
    name: 'desktop_find',
    description:
      'Search one app or window for elements by role, name, value, text, description or native id, and get refs without reading the whole tree. Cheaper than a snapshot when the role or exact label is known.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        app: { type: 'string', description: APP_DESCRIPTION },
        window_id: { type: 'string', description: 'Window id to scope the search.' },
        role: { type: 'string', description: 'Accessibility role, e.g. button, textfield, checkbox, menuitem.' },
        name: { type: 'string', description: 'Accessible name or label.' },
        text: { type: 'string', description: 'Text found in name, value, title or description.' },
        value: { type: 'string', description: 'Current value.' },
        description: { type: 'string', description: 'Accessible description.' },
        native_id: { type: 'string', description: 'Native automation id.' },
        exact: { type: 'boolean', description: 'Require exact case-insensitive matches.' },
        state: { type: 'string', description: 'State token filter, e.g. "focused" or "enabled=false".' },
        surface: { type: 'string', enum: SURFACES, description: 'Search this surface instead of the window.' },
        count: { type: 'boolean', description: 'Return the match count only.' },
        first: { type: 'boolean', description: 'Return the first match only.' },
        last: { type: 'boolean', description: 'Return the last match only.' },
        nth: { type: 'integer', description: 'Return the Nth match (0-indexed).' },
        limit: { type: 'integer', description: 'Return at most N matches (default 50, 0 = all).' },
        timeout_ms: { type: 'integer', description: 'Traversal deadline in milliseconds (default 5000).' },
      },
    },
    output: { schema: LOOSE_OUTPUT, render: (_args, value) => [textBlock(jsonText(value))] },
    isConcurrencySafe: () => true,
    timeoutMs: options.defaultTimeoutMs,
    async execute(args, exec) {
      const argv = [
        ...flag('--app', args.app),
        ...flag('--window-id', args.window_id),
        ...flag('--role', args.role),
        ...flag('--name', args.name),
        ...flag('--text', args.text),
        ...flag('--value', args.value),
        ...flag('--description', args.description),
        ...flag('--native-id', args.native_id),
        ...boolFlag('--exact', args.exact),
        ...flag('--state', args.state),
        ...flag('--surface', args.surface),
        ...boolFlag('--count', args.count),
        ...boolFlag('--first', args.first),
        ...boolFlag('--last', args.last),
        ...flag('--nth', args.nth),
        ...flag('--limit', args.limit),
        ...flag('--timeout-ms', args.timeout_ms),
      ]
      const envelope = await invoke(cli, options, 'find', argv, { signal: exec.signal })
      return toolValue(envelope)
    },
    presentCall: (args) => ({ card: 'generic', title: `Find ${args.role ?? args.text ?? args.name ?? 'element'}`, kind: 'read' }),
  }

  const inspectTool = {
    name: 'desktop_inspect',
    description:
      'Read one property (or the whole element) behind a ref with `get`, or test a state with `is`. Use it to verify an action right after it ran.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ref: { type: 'string', description: REF_DESCRIPTION },
        action: { type: 'string', enum: ['get', 'is'], description: 'get a property or test a state; default get.' },
        property: { type: 'string', description: 'Property or state name, e.g. value, name, enabled, focused, checked.' },
      },
      required: ['ref'],
    },
    output: { schema: LOOSE_OUTPUT, render: (_args, value) => [textBlock(jsonText(value))] },
    isConcurrencySafe: () => true,
    timeoutMs: options.defaultTimeoutMs,
    async execute(args, exec) {
      const command = args.action === 'is' ? 'is' : 'get'
      const argv = [args.ref, ...flag('--property', args.property)]
      const envelope = await invoke(cli, options, command, argv, { signal: exec.signal })
      return toolValue(envelope)
    },
    presentCall: (args) => ({ card: 'generic', title: `${args.action === 'is' ? 'Test' : 'Read'} ${args.property ?? 'element'}`, kind: 'read' }),
  }

  const actTool = {
    name: 'desktop_act',
    description:
      'Act on a ref: click, double_click, right_click, focus, select, toggle, check, uncheck, expand, collapse, scroll or scroll_to. Semantic accessibility calls by default; the physical variants (double/right click, focus) are delivered with --headed on Windows. After acting, take a fresh snapshot or desktop_inspect to verify.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['click', 'double_click', 'right_click', 'focus', 'select', 'toggle', 'check', 'uncheck', 'expand', 'collapse', 'scroll', 'scroll_to'],
          description: 'Operation to perform.',
        },
        ref: { type: 'string', description: REF_DESCRIPTION },
        value: { type: 'string', description: 'Value for action=select.' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction; default down.' },
        amount: { type: 'integer', description: 'Scroll units; default 3.' },
        headed: { type: 'boolean', description: 'Force or forbid physical delivery instead of the per-command default.' },
        timeout_ms: { type: 'integer', description: 'Ref-resolution and actionability deadline in milliseconds (default 5000).' },
      },
      required: ['action', 'ref'],
    },
    output: { schema: LOOSE_OUTPUT, render: (_args, value) => [textBlock(jsonText(value))] },
    isConcurrencySafe: () => false,
    timeoutMs: options.defaultTimeoutMs,
    async execute(args, exec) {
      const ref = args.ref
      const common = [...flag('--timeout-ms', args.timeout_ms)]
      let command
      let argv
      switch (args.action) {
        case 'click':
          command = 'click'
          argv = [ref, ...common]
          break
        case 'double_click':
          command = 'double-click'
          argv = [ref, ...common]
          break
        case 'right_click':
          command = 'right-click'
          argv = [ref, ...common]
          break
        case 'focus':
          command = 'focus'
          argv = [ref]
          break
        case 'select':
          if (typeof args.value !== 'string') throw new Error('action=select needs value')
          command = 'select'
          argv = [ref, args.value, ...common]
          break
        case 'toggle':
        case 'check':
        case 'uncheck':
        case 'expand':
        case 'collapse':
          command = args.action.replace('_', '-')
          argv = [ref, ...common]
          break
        case 'scroll':
          command = 'scroll'
          argv = [ref, ...flag('--direction', args.direction ?? 'down'), ...flag('--amount', args.amount), ...common]
          break
        case 'scroll_to':
          command = 'scroll-to'
          argv = [ref, ...common]
          break
        default:
          throw new Error(`unsupported action ${String(args.action)}`)
      }
      argv.push(...headedArgs(command, options, args))
      const envelope = await invoke(cli, options, command, argv, { signal: exec.signal })
      return toolValue(envelope)
    },
    presentCall: (args) => ({ card: 'generic', title: `${String(args.action).replace('_', ' ')} ${args.ref}`, kind: 'other' }),
  }

  const typeTool = {
    name: 'desktop_type',
    description:
      'Type text into a ref (textfield or editable element). Text travels over stdin, so it is safe for long or non-ASCII input. On Windows this is physical keystroke synthesis and the plugin adds --headed automatically.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ref: { type: 'string', description: REF_DESCRIPTION },
        text: { type: 'string', description: 'Text to insert.' },
        interval_ms: { type: 'integer', description: 'Type one keystroke every N ms (1-2000) instead of inserting at once.' },
        timeout_ms: { type: 'integer', description: 'Delivery deadline in milliseconds.' },
        headed: { type: 'boolean', description: 'Force or forbid physical delivery.' },
      },
      required: ['ref', 'text'],
    },
    output: { schema: LOOSE_OUTPUT, render: (_args, value) => [textBlock(jsonText(value))] },
    isConcurrencySafe: () => false,
    timeoutMs: options.typeTimeoutMs,
    async execute(args, exec) {
      if (typeof args.text !== 'string') throw new Error('text must be a string')
      const argv = [
        args.ref,
        '--stdin',
        ...flag('--interval-ms', args.interval_ms),
        ...flag('--timeout-ms', args.timeout_ms),
        ...headedArgs('type', options, args),
      ]
      const envelope = await invoke(cli, options, 'type', argv, {
        input: args.text,
        signal: exec.signal,
        timeoutMs: options.typeTimeoutMs,
      })
      return toolValue(envelope)
    },
    presentCall: (args) => ({ card: 'generic', title: `Type ${typeof args.text === 'string' ? args.text.length : 0} character(s)`, kind: 'other' }),
  }

  const setValueTool = {
    name: 'desktop_set_value',
    description:
      'Set an element value directly without keystrokes (works headless and does not take focus). Prefer it over desktop_type when the target exposes SetValue; fall back to desktop_type when the app reformats or refuses the value.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ref: { type: 'string', description: REF_DESCRIPTION },
        value: { type: 'string', description: 'New value.' },
        timeout_ms: { type: 'integer', description: 'Action deadline in milliseconds.' },
      },
      required: ['ref', 'value'],
    },
    output: { schema: LOOSE_OUTPUT, render: (_args, value) => [textBlock(jsonText(value))] },
    isConcurrencySafe: () => false,
    timeoutMs: options.defaultTimeoutMs,
    async execute(args, exec) {
      if (typeof args.value !== 'string') throw new Error('value must be a string')
      const argv = [args.ref, '--stdin', ...flag('--timeout-ms', args.timeout_ms)]
      const envelope = await invoke(cli, options, 'set-value', argv, {
        input: args.value,
        signal: exec.signal,
      })
      return toolValue(envelope)
    },
    presentCall: () => ({ card: 'generic', title: 'Set value', kind: 'other' }),
  }

  const pressTool = {
    name: 'desktop_press',
    description:
      'Press a key combination, e.g. "ctrl+s", "enter", "meta+c" (meta/cmd is the Windows key on Windows). Shell and destructive combos such as alt+f4 or win+l are refused unless force is true.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        combo: { type: 'string', description: 'Key combination, e.g. "ctrl+s".' },
        app: { type: 'string', description: 'Target app whose foreground queue receives the keys.' },
        force: { type: 'boolean', description: 'Allow combos the platform refuses by default.' },
        headed: { type: 'boolean', description: 'Force or forbid physical delivery.' },
      },
      required: ['combo'],
    },
    output: { schema: LOOSE_OUTPUT, render: (_args, value) => [textBlock(jsonText(value))] },
    isConcurrencySafe: () => false,
    timeoutMs: options.defaultTimeoutMs,
    async execute(args, exec) {
      const argv = [
        args.combo,
        ...flag('--app', args.app),
        ...boolFlag('--force', args.force),
        ...headedArgs('press', options, args),
      ]
      const envelope = await invoke(cli, options, 'press', argv, { signal: exec.signal })
      return toolValue(envelope)
    },
    presentCall: (args) => ({ card: 'generic', title: `Press ${args.combo}`, kind: 'other' }),
  }

  const screenshotTool = {
    name: 'desktop_screenshot',
    description:
      'Capture a PNG of one app window or a display and return it as an image. Prefer accessibility snapshots for reading UI; screenshots are for visual layout, charts, canvas content or when the tree is empty.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        app: { type: 'string', description: APP_DESCRIPTION },
        window_id: { type: 'string', description: 'Window id to capture.' },
        screen: { type: 'integer', description: 'Display index from desktop_windows list_displays (0 = primary).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          image: {
            type: 'object',
            additionalProperties: true,
            properties: {
              attachmentId: { type: 'string' },
              mediaType: { type: 'string' },
              bytes: { type: 'integer' },
              width: { type: 'integer' },
              height: { type: 'integer' },
              name: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => {
        const blocks = [textBlock(JSON.stringify({ path: value.path, width: value.width, height: value.height, scale_factor: value.scale_factor, image: value.image === undefined ? 'not attached' : 'attached' }))]
        if (value.image !== undefined) blocks.push({ type: 'image', attachment: { ...value.image } })
        return blocks
      },
    },
    isConcurrencySafe: () => false,
    timeoutMs: options.screenshotTimeoutMs,
    async execute(args, exec) {
      mkdirSync(CAPTURE_DIR, { recursive: true })
      captureCounter += 1
      const path = join(CAPTURE_DIR, `shot-${Date.now()}-${captureCounter}.png`)
      const argv = [
        path,
        ...flag('--app', args.app),
        ...flag('--window-id', args.window_id),
        ...flag('--screen', args.screen),
      ]
      const envelope = await invoke(cli, options, 'screenshot', argv, {
        signal: exec.signal,
        timeoutMs: options.screenshotTimeoutMs,
      })
      const value = toolValue(envelope, { path })
      const dataBytes = readFileSync(path)
      const committed = await commitCapture(ctx, exec, dataBytes, basename(path))
      if (committed.ok) {
        value.image = committed.image
        rmSync(path, { force: true })
      } else {
        value.note = `the image could not be attached (${committed.reason}); the PNG stays at ${path}`
      }
      return value
    },
    presentCall: (args) => ({ card: 'generic', title: args.app !== undefined ? `Screenshot ${args.app}` : 'Screenshot display', kind: 'read' }),
  }

  const clipboardTool = {
    name: 'desktop_clipboard',
    description: 'Read, write or clear the system clipboard. Writing text uses stdin and accepts up to 128 KiB. Note that it replaces the user clipboard.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'clear'], description: 'Clipboard operation.' },
        text: { type: 'string', description: 'Text for action=set.' },
        format: { type: 'string', description: 'Read format for action=get, e.g. text or html.' },
      },
      required: ['action'],
    },
    output: { schema: LOOSE_OUTPUT, render: (_args, value) => [textBlock(jsonText(value))] },
    isConcurrencySafe: () => false,
    timeoutMs: options.defaultTimeoutMs,
    async execute(args, exec) {
      let envelope
      if (args.action === 'get') {
        envelope = await invoke(cli, options, 'clipboard-get', [...flag('--format', args.format)], { signal: exec.signal })
      } else if (args.action === 'set') {
        if (typeof args.text !== 'string') throw new Error('action=set needs text')
        envelope = await invoke(cli, options, 'clipboard-set', ['--stdin'], { input: args.text, signal: exec.signal })
      } else if (args.action === 'clear') {
        envelope = await invoke(cli, options, 'clipboard-clear', [], { signal: exec.signal })
      } else {
        throw new Error(`unsupported clipboard action ${String(args.action)}`)
      }
      return toolValue(envelope)
    },
    presentCall: (args) => ({ card: 'generic', title: `Clipboard ${args.action}`, kind: 'other' }),
  }

  const appsTool = {
    name: 'desktop_apps',
    description:
      'List running apps, launch an app (absolute path or a bare name under System32 / the Windows directory, with or without .exe), or close one. Use list to find the exact app name the other tools expect.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'launch', 'close'], description: 'App operation.' },
        app: { type: 'string', description: 'App name or executable path; required for launch and close.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command-line arguments for launch.' },
        cwd: { type: 'string', description: 'Working directory for launch.' },
        activate: { type: 'boolean', description: 'Bring the launched app to the foreground.' },
        force: { type: 'boolean', description: 'Force-close without a graceful request.' },
        timeout_ms: { type: 'integer', description: 'Deadline for list.' },
      },
      required: ['action'],
    },
    output: { schema: LOOSE_OUTPUT, render: (_args, value) => [textBlock(jsonText(value))] },
    isConcurrencySafe: () => false,
    timeoutMs: options.defaultTimeoutMs,
    async execute(args, exec) {
      let command
      let argv
      if (args.action === 'list') {
        command = 'list-apps'
        argv = [...flag('--app', args.app), ...flag('--timeout-ms', args.timeout_ms)]
      } else if (args.action === 'launch') {
        if (typeof args.app !== 'string' || args.app.length === 0) throw new Error('action=launch needs app')
        command = 'launch'
        argv = [args.app]
        for (const item of Array.isArray(args.args) ? args.args : []) argv.push('--arg', String(item))
        argv.push(...flag('--cwd', args.cwd), ...boolFlag('--activate', args.activate))
      } else if (args.action === 'close') {
        if (typeof args.app !== 'string' || args.app.length === 0) throw new Error('action=close needs app')
        command = 'close-app'
        argv = [args.app, ...boolFlag('--force', args.force)]
      } else {
        throw new Error(`unsupported app action ${String(args.action)}`)
      }
      const envelope = await invoke(cli, options, command, argv, { signal: exec.signal })
      return toolValue(envelope)
    },
    presentCall: (args) => ({ card: 'generic', title: `${String(args.action)} app${args.app !== undefined ? ` ${args.app}` : ''}`, kind: 'other' }),
  }

  const windowsTool = {
    name: 'desktop_windows',
    description:
      'List windows and displays, or focus, minimize, maximize, restore, move and resize a window. A minimized window cannot be driven by ref actions: restore it first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'list_displays', 'focus', 'minimize', 'maximize', 'restore', 'move', 'resize'], description: 'Window operation.' },
        app: { type: 'string', description: APP_DESCRIPTION },
        window_id: { type: 'string', description: 'Window id from the list.' },
        title: { type: 'string', description: 'Window title fragment for focus.' },
        x: { type: 'integer', description: 'X position for move.' },
        y: { type: 'integer', description: 'Y position for move.' },
        width: { type: 'integer', description: 'Width for resize.' },
        height: { type: 'integer', description: 'Height for resize.' },
      },
      required: ['action'],
    },
    output: { schema: LOOSE_OUTPUT, render: (_args, value) => [textBlock(jsonText(value))] },
    isConcurrencySafe: () => false,
    timeoutMs: options.defaultTimeoutMs,
    async execute(args, exec) {
      const scope = [...flag('--app', args.app), ...flag('--window-id', args.window_id)]
      let command
      let argv
      switch (args.action) {
        case 'list':
          command = 'list-windows'
          argv = [...flag('--app', args.app)]
          break
        case 'list_displays':
          command = 'list-displays'
          argv = []
          break
        case 'focus':
          command = 'focus-window'
          argv = [...scope, ...flag('--title', args.title)]
          break
        case 'minimize':
          command = 'minimize'
          argv = [...scope]
          break
        case 'maximize':
          command = 'maximize'
          argv = [...scope]
          break
        case 'restore':
          command = 'restore'
          argv = [...scope]
          break
        case 'move':
          command = 'move-window'
          argv = [...scope, ...flag('--x', args.x), ...flag('--y', args.y)]
          break
        case 'resize':
          command = 'resize-window'
          argv = [...scope, ...flag('--width', args.width), ...flag('--height', args.height)]
          break
        default:
          throw new Error(`unsupported window action ${String(args.action)}`)
      }
      const envelope = await invoke(cli, options, command, argv, { signal: exec.signal })
      return toolValue(envelope)
    },
    presentCall: (args) => ({ card: 'generic', title: `Windows ${String(args.action).replace('_', ' ')}`, kind: 'read' }),
  }

  const waitTool = {
    name: 'desktop_wait',
    description:
      'Wait for a duration, an element, text, a window, a menu, an event or a notification instead of sleeping blindly after an action.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ms: { type: 'integer', description: 'Fixed wait in milliseconds.' },
        app: { type: 'string', description: APP_DESCRIPTION },
        element: { type: 'string', description: 'Wait for this element selector (role:name).' },
        text: { type: 'string', description: 'Wait until this text is present.' },
        window: { type: 'string', description: 'Wait for a window matching this title.' },
        menu: { type: 'boolean', description: 'Wait for a menu to appear.' },
        event: { type: 'string', description: 'Event name, e.g. window-opened, window-closed, focus-changed.' },
        window_id: { type: 'string', description: 'Window id for window lifecycle events.' },
        timeout_ms: { type: 'integer', description: 'Maximum wait in milliseconds (default 30000).' },
      },
    },
    output: { schema: LOOSE_OUTPUT, render: (_args, value) => [textBlock(jsonText(value))] },
    isConcurrencySafe: () => false,
    timeoutMs: options.defaultTimeoutMs,
    async execute(args, exec) {
      const argv = [
        ...(Number.isInteger(args.ms) ? [String(args.ms)] : []),
        ...flag('--app', args.app),
        ...flag('--element', args.element),
        ...flag('--text', args.text),
        ...flag('--window', args.window),
        ...boolFlag('--menu', args.menu),
        ...flag('--event', args.event),
        ...flag('--window-id', args.window_id),
        ...flag('--timeout', args.timeout_ms),
      ]
      const envelope = await invoke(cli, options, 'wait', argv, { signal: exec.signal })
      return toolValue(envelope)
    },
    presentCall: (args) => ({ card: 'generic', title: args.ms !== undefined ? `Wait ${args.ms}ms` : 'Wait for UI', kind: 'other' }),
  }

  const batchTool = {
    name: 'desktop_batch',
    description:
      'Run a bounded sequential JSON batch of agent-desktop commands in one process: [{ "command": "click", "args": { "ref_id": "@s8f3k2p9:e1" } }, …]. Args use the command\'s own field names, and a flag drops its -- and uses _ (timeout_ms). Not a transaction; use stop_on_error to halt at the first failure.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        commands: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              command: { type: 'string' },
              args: { type: 'object', additionalProperties: true },
            },
            required: ['command'],
          },
          description: 'Ordered commands to run.',
        },
        stop_on_error: { type: 'boolean', description: 'Halt at the first failed command.' },
        timeout_ms: { type: 'integer', description: 'Wall-clock budget for the whole batch (default 60000).' },
      },
      required: ['commands'],
    },
    output: { schema: LOOSE_OUTPUT, render: (_args, value) => [textBlock(jsonText(value))] },
    isConcurrencySafe: () => false,
    timeoutMs: options.defaultTimeoutMs,
    async execute(args, exec) {
      if (!Array.isArray(args.commands) || args.commands.length === 0) throw new Error('commands must be a non-empty array')
      const payload = JSON.stringify(args.commands)
      if (payload.length > 24000) throw new Error('batch JSON is too large for one command line; split it into several calls')
      const argv = [payload, ...boolFlag('--stop-on-error', args.stop_on_error), ...flag('--timeout-ms', args.timeout_ms)]
      const envelope = await invoke(cli, options, 'batch', argv, { signal: exec.signal })
      return toolValue(envelope)
    },
    presentCall: (args) => ({ card: 'generic', title: `Batch ${Array.isArray(args.commands) ? args.commands.length : 0} commands`, kind: 'execute' }),
  }

  return [
    statusTool,
    snapshotTool,
    findTool,
    inspectTool,
    actTool,
    typeTool,
    setValueTool,
    pressTool,
    screenshotTool,
    clipboardTool,
    appsTool,
    windowsTool,
    waitTool,
    batchTool,
  ]
}

/* ------------------------------------------------------------------------- *
 * Image return (unchanged pipeline: attachments + model image capability)
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
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

async function commitCapture(ctx, exec, data, captureName) {
  const capable = await resolveImageInput(ctx, exec)
  if (!capable.ok) return { ok: false, reason: capable.reason }
  const attachments = ctx.get('attachments')
  if (attachments === undefined || attachments === null) return { ok: false, reason: 'no attachment service is mounted on this Host' }
  try {
    const ref = await attachments.saveImage({ data, mediaType: 'image/png', name: captureName })
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
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/* ------------------------------------------------------------------------- *
 * Plugin entry
 * ------------------------------------------------------------------------- */

function normalizeOptions(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const options = { ...DEFAULTS }
  if (typeof source.binPath === 'string' && source.binPath.length > 0) options.binPath = source.binPath
  for (const key of Object.keys(DEFAULTS)) {
    if (key === 'binPath') continue
    if (Number.isInteger(source[key]) && source[key] > 0) options[key] = source[key]
  }
  if (source.preferHeaded === true) options.preferHeaded = true
  return options
}

export function apply(ctx, config) {
  const options = normalizeOptions(config)
  let cli
  try {
    cli = resolveCli(options)
  } catch (error) {
    ctx.logger?.warn?.(`dsh-computer-use-windows: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  ctx.logger?.info?.(`dsh-computer-use-windows: using ${cli.label}`)
  for (const definition of buildTools(ctx, cli, options)) {
    ctx.effect(() => ctx.tools.register(definition))
  }
}
