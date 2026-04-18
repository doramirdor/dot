/**
 * Continuous screen-state fusion — a background loop that captures the
 * primary display periodically, hashes the frame, and keeps a small ring
 * buffer of recent screenshots on disk so Dot can answer "what was on
 * my screen 2 minutes ago?" without re-capturing.
 *
 * Design principles:
 *   - Cheap. Perceptual hash skip for unchanged frames (no token cost).
 *   - Privacy-respecting: pauses when screen is locked, user is idle >5 min,
 *     or the frontmost app is in a sensitive list (1Password, KeePass, banks).
 *   - Disk-bounded: ring buffer of N frames, older files auto-deleted.
 *   - No LLM calls in the loop itself. Frames are only sent to Claude when
 *     the user explicitly asks (via screen_now / screen_at / screen_timeline).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { NINA_DIR } from './memory.js'
import { getIdleSeconds, isScreenLocked } from './presence.js'

const execFileP = promisify(execFile)

const WATCHER_DIR = path.join(NINA_DIR, 'screen-watcher')
const FRAMES_DIR = path.join(WATCHER_DIR, 'frames')
const INDEX_FILE = path.join(WATCHER_DIR, 'index.json')

const DEFAULT_INTERVAL_MS = 45_000 // 45 seconds
const MAX_FRAMES = 12 // ring buffer size
const MAX_IDLE_BEFORE_PAUSE = 5 * 60 // 5 minutes

// Bundle IDs / app names we never capture frames for. Keeps passwords,
// banking, and private browsing out of Dot's rolling buffer.
const SENSITIVE_APPS: RegExp[] = [
  /1Password/i,
  /KeePass/i,
  /Bitwarden/i,
  /Dashlane/i,
  /LastPass/i,
  /Keychain/i,
  /Private/i, // Chrome/Safari private browsing window titles
]

export interface Frame {
  /** ISO timestamp */
  timestamp: string
  /** Relative path inside WATCHER_DIR/frames */
  file: string
  /** Perceptual-ish hash (cheap) */
  hash: string
  /** Frontmost app when captured (if known) */
  app: string | null
  /** Active window title when captured (if known) */
  window: string | null
}

interface WatcherIndex {
  frames: Frame[]
  lastCaptureAt: string | null
  paused: boolean
}

function ensureDirs(): void {
  fs.mkdirSync(FRAMES_DIR, { recursive: true })
}

function loadIndex(): WatcherIndex {
  try {
    if (!fs.existsSync(INDEX_FILE)) return { frames: [], lastCaptureAt: null, paused: false }
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'))
  } catch {
    return { frames: [], lastCaptureAt: null, paused: false }
  }
}

function saveIndex(idx: WatcherIndex): void {
  ensureDirs()
  fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2), 'utf8')
}

// ========== capture ==========

async function getFrontmostInfo(): Promise<{ app: string | null; window: string | null }> {
  try {
    const { stdout } = await execFileP(
      'osascript',
      [
        '-e',
        `tell application "System Events"
           set frontApp to first application process whose frontmost is true
           set appName to name of frontApp
           try
             set winName to name of first window of frontApp
           on error
             set winName to ""
           end try
         end tell
         return appName & "|||" & winName`,
      ],
      { timeout: 2000 },
    )
    const [app = '', winTitle = ''] = stdout.trim().split('|||')
    return { app: app || null, window: winTitle ? winTitle.slice(0, 140) : null }
  } catch {
    return { app: null, window: null }
  }
}

function isSensitive(app: string | null, window: string | null): boolean {
  for (const re of SENSITIVE_APPS) {
    if (app && re.test(app)) return true
    if (window && re.test(window)) return true
  }
  return false
}

/**
 * Capture the primary display as a small JPEG. Uses `screencapture -x -m -t jpg`
 * directly to a temp path, then downscales via `sips` to keep size sane.
 */
async function captureFrame(): Promise<string | null> {
  const tmpPath = path.join(os.tmpdir(), `nina-frame-${Date.now()}.jpg`)
  try {
    await execFileP('screencapture', ['-x', '-m', '-t', 'jpg', tmpPath], {
      timeout: 5000,
    })
    if (!fs.existsSync(tmpPath)) return null

    // Downscale to 1280px max width for hashability + token economy
    try {
      await execFileP('sips', ['-Z', '1280', tmpPath], { timeout: 5000 })
    } catch {
      // sips may not be available; keep original
    }
    return tmpPath
  } catch {
    return null
  }
}

/**
 * Compute a cheap perceptual-ish hash by downscaling the JPEG to 8x8
 * via sips and hashing the resulting bytes. Different enough frames
 * produce different hashes; identical frames collide.
 */
async function hashFrame(jpegPath: string): Promise<string> {
  try {
    const tinyPath = path.join(os.tmpdir(), `nina-hash-${Date.now()}.png`)
    await execFileP(
      'sips',
      ['-Z', '16', '-s', 'format', 'png', jpegPath, '--out', tinyPath],
      { timeout: 3000 },
    )
    const buf = fs.readFileSync(tinyPath)
    fs.unlinkSync(tinyPath)
    return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16)
  } catch {
    // Fallback: hash the full file. Precise but not perceptual.
    try {
      const buf = fs.readFileSync(jpegPath)
      return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16)
    } catch {
      return ''
    }
  }
}

async function saveFrame(jpegPath: string, hash: string): Promise<string> {
  ensureDirs()
  const name = `${Date.now()}-${hash.slice(0, 8)}.jpg`
  const dest = path.join(FRAMES_DIR, name)
  fs.copyFileSync(jpegPath, dest)
  try {
    fs.unlinkSync(jpegPath)
  } catch {
    // ignore
  }
  return name
}

function trimRingBuffer(idx: WatcherIndex): void {
  if (idx.frames.length <= MAX_FRAMES) return
  const toRemove = idx.frames.splice(0, idx.frames.length - MAX_FRAMES)
  for (const f of toRemove) {
    try {
      fs.unlinkSync(path.join(FRAMES_DIR, f.file))
    } catch {
      // ignore
    }
  }
}

// ========== loop ==========

let intervalHandle: NodeJS.Timeout | null = null
let loopRunning = false
let externallyPaused = false

async function tick(): Promise<void> {
  if (loopRunning) return
  loopRunning = true
  try {
    if (externallyPaused) return

    // Presence gates — don't capture when user can't see or is idle
    if (isScreenLocked()) return
    if (getIdleSeconds() > MAX_IDLE_BEFORE_PAUSE) return

    const { app, window: winTitle } = await getFrontmostInfo()
    if (isSensitive(app, winTitle)) return

    const tmpPath = await captureFrame()
    if (!tmpPath) return
    const hash = await hashFrame(tmpPath)

    const idx = loadIndex()
    const last = idx.frames[idx.frames.length - 1]

    if (last && last.hash === hash) {
      // Unchanged — just delete the tmp and move on
      try {
        fs.unlinkSync(tmpPath)
      } catch {
        // ignore
      }
      idx.lastCaptureAt = new Date().toISOString()
      saveIndex(idx)
      return
    }

    const savedName = await saveFrame(tmpPath, hash)
    const frame: Frame = {
      timestamp: new Date().toISOString(),
      file: savedName,
      hash,
      app,
      window: winTitle,
    }
    idx.frames.push(frame)
    idx.lastCaptureAt = frame.timestamp
    trimRingBuffer(idx)
    saveIndex(idx)
  } catch (err) {
    console.warn('[screen-watcher] tick failed:', err)
  } finally {
    loopRunning = false
  }
}

export function startScreenWatcher(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (intervalHandle) return
  ensureDirs()
  // Delay first tick slightly so startup isn't jammed
  setTimeout(() => void tick(), 10_000)
  intervalHandle = setInterval(() => void tick(), intervalMs)
}

export function stopScreenWatcher(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
}

export function pauseScreenWatcher(): void {
  externallyPaused = true
  const idx = loadIndex()
  idx.paused = true
  saveIndex(idx)
}

export function resumeScreenWatcher(): void {
  externallyPaused = false
  const idx = loadIndex()
  idx.paused = false
  saveIndex(idx)
}

export function isScreenWatcherPaused(): boolean {
  return externallyPaused
}

// ========== query ==========

export function getRecentFrames(count = 5): Frame[] {
  const idx = loadIndex()
  return idx.frames.slice(-count)
}

export function getLatestFrame(): Frame | null {
  const idx = loadIndex()
  return idx.frames[idx.frames.length - 1] ?? null
}

export function getFramePath(frame: Frame): string {
  return path.join(FRAMES_DIR, frame.file)
}

/**
 * Read the latest frame as base64 JPEG. Returns null if no frames captured
 * yet or the file is missing.
 */
export function readLatestFrameBase64(): { base64: string; frame: Frame } | null {
  const frame = getLatestFrame()
  if (!frame) return null
  const p = getFramePath(frame)
  try {
    const buf = fs.readFileSync(p)
    return { base64: buf.toString('base64'), frame }
  } catch {
    return null
  }
}

/**
 * Render a compact text timeline of recent frames.
 */
export function formatTimeline(frames: Frame[]): string {
  if (frames.length === 0) return '(no frames captured yet)'
  return frames
    .map((f) => {
      const parts = [f.timestamp]
      if (f.app) parts.push(f.app)
      if (f.window) parts.push(`"${f.window}"`)
      return `- ${parts.join(' · ')}`
    })
    .join('\n')
}
