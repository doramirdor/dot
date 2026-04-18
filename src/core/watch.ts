/**
 * Watchers: Dot can poll a bash command or a URL on an interval and fire
 * a native notification (and a Telegram ping when applicable) the moment
 * a condition flips. Good for "tell me when the build finishes", "ping me
 * when the 4pm slot opens on Resy", "shout when the VPN reconnects".
 *
 * Design choices:
 *   - One-shot by default. As soon as the match fires, the watch stops.
 *     If the user wants a tripwire that keeps firing, they can re-arm it.
 *   - Hard cap on concurrent watches (MAX_WATCHES). Prevents runaway loops.
 *   - Each watch has a max check count so even a silent failure self-terminates.
 *   - Bash and URL modes share the same skeleton. Match condition is a regex
 *     against stdout / response body. Bash mode also supports exit-code match.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { sendNotification } from './notify.js'

const execFileP = promisify(execFile)

export type WatchType = 'bash' | 'url'

export interface Watch {
  id: string
  type: WatchType
  label: string
  /** Bash command or URL. */
  target: string
  /** Regex source string. Empty for "exit code 0" bash watches. */
  pattern: string
  intervalSec: number
  maxChecks: number
  checks: number
  createdAt: number
  lastCheckedAt: number | null
  lastSample: string
  /** For bash watches: if true, a zero exit code alone counts as a match. */
  matchOnExitZero: boolean
  /** Internal. */
  timer: NodeJS.Timeout
}

const MAX_WATCHES = 10
const MIN_INTERVAL_SEC = 10
const MAX_INTERVAL_SEC = 3600
const DEFAULT_INTERVAL_SEC = 60
const DEFAULT_MAX_CHECKS = 240 // with 60s interval => 4h cap

const watches = new Map<string, Watch>()

function newId(): string {
  return `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

function clampInterval(sec: number | undefined): number {
  const v = sec ?? DEFAULT_INTERVAL_SEC
  return Math.max(MIN_INTERVAL_SEC, Math.min(MAX_INTERVAL_SEC, v))
}

async function runBashOnce(cmd: string): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileP('bash', ['-lc', cmd], {
      timeout: 20_000,
      maxBuffer: 1_000_000,
    })
    return { stdout: String(stdout ?? ''), code: 0 }
  } catch (err: unknown) {
    const e = err as { stdout?: string; code?: number }
    return {
      stdout: String(e?.stdout ?? ''),
      code: typeof e?.code === 'number' ? e.code : 1,
    }
  }
}

async function fetchUrlOnce(url: string): Promise<string> {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  })
  const text = await res.text()
  return text.slice(0, 200_000)
}

function finishWatch(w: Watch, reason: string, sample: string) {
  clearInterval(w.timer)
  watches.delete(w.id)
  const subtitle = `${w.type}: ${w.label}`
  void sendNotification(
    `${reason}. ${sample.slice(0, 140)}`.trim(),
    'Dot watch',
    subtitle,
  )
}

function tickFactory(w: Watch) {
  return async () => {
    if (w.checks >= w.maxChecks) {
      finishWatch(w, `stopped after ${w.checks} checks, no match`, w.lastSample)
      return
    }
    w.checks++
    w.lastCheckedAt = Date.now()

    let sample = ''
    let matched = false

    try {
      if (w.type === 'bash') {
        const { stdout, code } = await runBashOnce(w.target)
        sample = stdout.trim().slice(0, 2000)
        if (w.matchOnExitZero && code === 0) matched = true
        if (!matched && w.pattern) {
          matched = new RegExp(w.pattern, 'i').test(stdout)
        }
      } else {
        const body = await fetchUrlOnce(w.target)
        sample = body.replace(/\s+/g, ' ').trim().slice(0, 2000)
        if (w.pattern) {
          matched = new RegExp(w.pattern, 'i').test(body)
        }
      }
    } catch (err) {
      sample = `error: ${(err as Error).message ?? String(err)}`.slice(0, 500)
    }

    w.lastSample = sample

    if (matched) {
      finishWatch(w, `match on "${w.label}"`, sample)
    }
  }
}

export function startWatch(args: {
  type: WatchType
  label: string
  target: string
  pattern?: string
  intervalSec?: number
  maxChecks?: number
  matchOnExitZero?: boolean
}): { ok: true; id: string } | { ok: false; error: string } {
  if (watches.size >= MAX_WATCHES) {
    return { ok: false, error: `max concurrent watches (${MAX_WATCHES}) reached` }
  }
  if (!args.target || args.target.trim().length === 0) {
    return { ok: false, error: 'target is required' }
  }
  const matchOnExitZero = args.type === 'bash' && (args.matchOnExitZero ?? !args.pattern)
  if (!args.pattern && !matchOnExitZero) {
    return { ok: false, error: 'pattern is required for url watches' }
  }

  const id = newId()
  const intervalSec = clampInterval(args.intervalSec)
  const maxChecks = Math.max(1, Math.min(10_000, args.maxChecks ?? DEFAULT_MAX_CHECKS))

  const w: Watch = {
    id,
    type: args.type,
    label: args.label.slice(0, 80) || args.target.slice(0, 80),
    target: args.target,
    pattern: args.pattern ?? '',
    intervalSec,
    maxChecks,
    checks: 0,
    createdAt: Date.now(),
    lastCheckedAt: null,
    lastSample: '',
    matchOnExitZero,
    timer: setInterval(() => {}, intervalSec * 1000),
  }

  const tick = tickFactory(w)
  clearInterval(w.timer)
  w.timer = setInterval(tick, intervalSec * 1000)
  watches.set(id, w)
  // Fire once immediately so "already done" is caught right away.
  void tick()

  return { ok: true, id }
}

export function stopWatch(id: string): boolean {
  const w = watches.get(id)
  if (!w) return false
  clearInterval(w.timer)
  watches.delete(id)
  return true
}

export function listWatches(): Array<Omit<Watch, 'timer'>> {
  return Array.from(watches.values()).map((w) => {
    const { timer: _timer, ...rest } = w
    return rest
  })
}

export function stopAllWatches() {
  for (const w of watches.values()) clearInterval(w.timer)
  watches.clear()
}
