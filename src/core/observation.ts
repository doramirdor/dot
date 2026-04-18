import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { MEMORY_DIR } from './memory.js'
import { log } from './log.js'

const execFileP = promisify(execFile)

export const ACTIVITY_LOG = path.join(MEMORY_DIR, 'activity_log.md')

const DEFAULT_INTERVAL_MS = 2 * 60 * 1000 // 2 minutes — tick is cheap, no LLM
const MAX_LOG_BYTES = 256 * 1024 // cap activity log at 256KB

export interface TickEvent {
  app: string | null
  window: string | null
  escalated: boolean
}

let intervalHandle: NodeJS.Timeout | null = null
let paused = false
let lastObservationAt: Date | null = null
let proactiveHandler: ((message: string) => void) | null = null
let tickHandler: ((ev: TickEvent) => void) | null = null

// Cached state between ticks for cheap local signal detection
interface TickState {
  app: string | null
  window: string | null
  since: number // ms timestamp when this (app,window) was first seen
  prevDwellMinutes: number // dwell of the window we just left
  lastSeenProjectAt: Map<string, number>
}
const tickState: TickState = {
  app: null,
  window: null,
  since: Date.now(),
  prevDwellMinutes: 0,
  lastSeenProjectAt: new Map(),
}

export interface TickSignals {
  dwellMinutes: number
  appChanged: boolean
  prevDwellMinutes: number
  returnedToProject: string | null
  errorOnScreen: boolean
  meaningfulChange: boolean
}

function computeSignals(obs: Observation): TickSignals {
  const now = Date.now()
  const sameWindow = obs.app === tickState.app && obs.window === tickState.window
  let prevDwellMinutes = 0
  if (!sameWindow) {
    prevDwellMinutes = Math.floor((now - tickState.since) / 60_000)
    tickState.prevDwellMinutes = prevDwellMinutes
    tickState.app = obs.app
    tickState.window = obs.window
    tickState.since = now
  }
  const dwellMinutes = Math.floor((now - tickState.since) / 60_000)

  // Track project return: derive project from first recent file path segment
  let returnedToProject: string | null = null
  const project = obs.recentFiles[0]?.match(/~\/Documents\/code\/([^/]+)/)?.[1] ?? null
  if (project) {
    const last = tickState.lastSeenProjectAt.get(project)
    if (last && now - last > 60 * 60_000) {
      returnedToProject = project
    }
    tickState.lastSeenProjectAt.set(project, now)
  }

  const title = (obs.window ?? '').toLowerCase()
  const errorOnScreen = /error|traceback|exception|failed/.test(title)

  // A "meaningful change" is a window switch that happened after the user
  // actually spent time on the previous thing (≥2 min). Filters out rapid
  // tab-flipping so we don't spam Haiku every few seconds.
  const meaningfulChange = !sameWindow && prevDwellMinutes >= 2

  return {
    dwellMinutes,
    appChanged: !sameWindow,
    prevDwellMinutes,
    returnedToProject,
    errorOnScreen,
    meaningfulChange,
  }
}

function shouldEscalate(s: TickSignals): boolean {
  return (
    s.dwellMinutes >= 20 ||
    s.returnedToProject !== null ||
    s.errorOnScreen ||
    s.meaningfulChange
  )
}

/** Returns the name of the currently frontmost macOS app, or null on failure. */
async function getFrontmostApp(): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      'osascript',
      [
        '-e',
        'tell application "System Events" to get name of first application process whose frontmost is true',
      ],
      { timeout: 3000 },
    )
    return stdout.trim() || null
  } catch {
    return null
  }
}

/** Returns the active window title of the frontmost app, if accessible. */
async function getFrontmostWindowTitle(): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      'osascript',
      [
        '-e',
        `tell application "System Events"
           set frontApp to first application process whose frontmost is true
           try
             set frontWin to name of first window of frontApp
           on error
             set frontWin to ""
           end try
         end tell
         return frontWin`,
      ],
      { timeout: 3000 },
    )
    const title = stdout.trim()
    return title.length > 0 ? title.slice(0, 140) : null
  } catch {
    return null
  }
}

/**
 * Return file paths under ~/Documents/code that were modified in the last
 * `minutes` minutes. Uses Spotlight (mdfind) which is fast and cached.
 */
async function getRecentCodeFiles(minutes = 30): Promise<string[]> {
  const codeDir = path.join(os.homedir(), 'Documents', 'code')
  if (!fs.existsSync(codeDir)) return []
  try {
    const { stdout } = await execFileP(
      'mdfind',
      [
        '-onlyin',
        codeDir,
        `kMDItemFSContentChangeDate >= $time.now(-${minutes * 60})`,
      ],
      { timeout: 5000 },
    )
    return stdout
      .split('\n')
      .filter((l) => l.trim() && !l.includes('/node_modules/') && !l.includes('/.git/'))
      .slice(0, 8)
      .map((p) => p.replace(os.homedir(), '~'))
  } catch {
    return []
  }
}

interface Observation {
  timestamp: string
  app: string | null
  window: string | null
  recentFiles: string[]
}

async function collectObservation(): Promise<Observation> {
  const [app, windowTitle, recentFiles] = await Promise.all([
    getFrontmostApp(),
    getFrontmostWindowTitle(),
    getRecentCodeFiles(15),
  ])
  return {
    timestamp: new Date().toISOString(),
    app,
    window: windowTitle,
    recentFiles,
  }
}

function formatObservation(obs: Observation): string {
  const parts = [`- ${obs.timestamp}`]
  if (obs.app) parts.push(`**${obs.app}**`)
  if (obs.window) parts.push(`_${obs.window}_`)
  if (obs.recentFiles.length > 0) parts.push(`files: ${obs.recentFiles.join(', ')}`)
  return parts.join(' · ') + '\n'
}

function appendActivityLog(line: string): void {
  try {
    // Ensure header exists
    if (!fs.existsSync(ACTIVITY_LOG)) {
      fs.writeFileSync(
        ACTIVITY_LOG,
        `# Activity Log\n\nAutomatic observations. Nina consolidates this during reflection.\n\n`,
        'utf8',
      )
    }
    fs.appendFileSync(ACTIVITY_LOG, line, 'utf8')
    // Trim if it gets too big — keep only the last MAX_LOG_BYTES
    const stat = fs.statSync(ACTIVITY_LOG)
    if (stat.size > MAX_LOG_BYTES) {
      const content = fs.readFileSync(ACTIVITY_LOG, 'utf8')
      const trimmed =
        `# Activity Log\n\n(older entries trimmed)\n\n` + content.slice(-MAX_LOG_BYTES / 2)
      fs.writeFileSync(ACTIVITY_LOG, trimmed, 'utf8')
    }
  } catch (err) {
    console.warn('[nina] Failed to append activity log:', err)
  }
}

async function tick(): Promise<void> {
  if (paused) return
  try {
    const obs = await collectObservation()
    // Skip noise: Nina observing herself
    if (obs.app && /Nina|Electron/.test(obs.app)) return
    appendActivityLog(formatObservation(obs))
    lastObservationAt = new Date()

    // Cheap local signals. Only escalate to an LLM advisory when
    // something is actually worth looking at.
    let escalated = false
    let signalsForLog: TickSignals | null = null
    if (proactiveHandler) {
      const signals = computeSignals(obs)
      signalsForLog = signals
      if (shouldEscalate(signals)) {
        escalated = true
        log('tick.escalate', {
          app: obs.app,
          window: obs.window,
          dwell: signals.dwellMinutes,
          prevDwell: signals.prevDwellMinutes,
          change: signals.meaningfulChange,
          returnedTo: signals.returnedToProject,
          errorOnScreen: signals.errorOnScreen,
        })
        try {
          const { runAdvisory } = await import('./proactive.js')
          const result = await runAdvisory(signals)
          if (result.message) {
            log('tick.spoke', { message: result.message })
            proactiveHandler(result.message)
          } else {
            log('tick.silent', { reason: result.reason })
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          log('tick.error', { err: msg })
          console.warn('[nina] Advisory check failed:', err)
        }
      }
    }

    // Every tick gets one line, even silent ones, so `tail -f` shows the heartbeat
    log('tick', {
      app: obs.app,
      window: obs.window,
      dwell: signalsForLog?.dwellMinutes ?? 0,
      escalated,
    })

    // Fire a tick event for the UI (visible pulse).
    if (tickHandler) {
      try {
        tickHandler({ app: obs.app, window: obs.window, escalated })
      } catch {
        // ignore
      }
    }
  } catch (err) {
    console.warn('[nina] Observation tick failed:', err)
  }
}

export function startObservationLoop(
  intervalMs = DEFAULT_INTERVAL_MS,
  onProactive?: (message: string) => void,
  onTick?: (ev: TickEvent) => void,
): void {
  if (intervalHandle) return
  if (onProactive) proactiveHandler = onProactive
  if (onTick) tickHandler = onTick
  // Fire one observation immediately so the log isn't empty.
  void tick()
  intervalHandle = setInterval(tick, intervalMs)
}

export function stopObservationLoop(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
}

export function pauseObservation(): void {
  paused = true
}

export function resumeObservation(): void {
  paused = false
}

export function isPaused(): boolean {
  return paused
}

export function getLastObservationAt(): Date | null {
  return lastObservationAt
}
