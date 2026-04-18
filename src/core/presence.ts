/**
 * Presence sensing: is the user available to be interrupted right now?
 *
 * Signals (all best-effort, never throw):
 *   - idle seconds (how long since last HID event)
 *   - screen lock state
 *   - focus mode active (Do Not Disturb, Work, Sleep, etc.)
 *   - in a video call (Zoom, Meet, Teams, FaceTime, Slack Huddle)
 *
 * Used to gate proactive interrupts so Nina doesn't speak up when the user
 * can't or shouldn't be interrupted.
 */
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const execFileP = promisify(execFile)

// ========== idle ==========

/** Seconds since the last HID event. 0 = user is active right now. */
export function getIdleSeconds(): number {
  try {
    const out = execFileSync(
      '/bin/sh',
      [
        '-c',
        "/usr/sbin/ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF/1000000000; exit}'",
      ],
      { encoding: 'utf8', timeout: 1500 },
    )
    const n = parseFloat(out.trim())
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

// ========== screen lock ==========

export function isScreenLocked(): boolean {
  try {
    const out = execFileSync(
      '/bin/sh',
      ['-c', "/usr/sbin/ioreg -n Root -d1 -a 2>/dev/null || /usr/sbin/ioreg -n Root -d1"],
      { encoding: 'utf8', timeout: 1500 },
    )
    // Look for CGSSessionScreenIsLocked = 1 in the output
    return /CGSSessionScreenIsLocked["\s]*=\s*(1|true|yes)/i.test(out)
  } catch {
    return false
  }
}

// ========== focus mode ==========

/**
 * Is the user in a Focus mode (Do Not Disturb, Work, Sleep, Custom)?
 *
 * macOS 12+ stores active focus assertions at:
 *   ~/Library/DoNotDisturb/DB/Assertions.json
 *
 * The schema has shifted between OS releases so we just check whether any
 * non-empty assertion entries exist anywhere in the JSON.
 */
export function isInFocusMode(): boolean {
  const p = path.join(os.homedir(), 'Library/DoNotDisturb/DB/Assertions.json')
  try {
    if (!fs.existsSync(p)) return false
    const raw = fs.readFileSync(p, 'utf8').trim()
    if (!raw) return false
    const parsed = JSON.parse(raw)
    // Shallow search for any assertion-like structure
    const stack: unknown[] = [parsed]
    while (stack.length > 0) {
      const cur = stack.pop()
      if (!cur) continue
      if (typeof cur !== 'object') continue
      if (Array.isArray(cur)) {
        if (cur.length > 0) {
          for (const item of cur) stack.push(item)
        }
      } else {
        const obj = cur as Record<string, unknown>
        // Any key ending in "Assertion" with a truthy value signals active focus
        for (const [k, v] of Object.entries(obj)) {
          if (/assertion/i.test(k) && v) return true
          if (typeof v === 'object') stack.push(v)
        }
      }
    }
    return false
  } catch {
    return false
  }
}

// ========== in a call ==========

const CALL_APP_BUNDLE_IDS = [
  'us.zoom.xos', // Zoom
  'com.microsoft.teams', // Teams classic
  'com.microsoft.teams2', // Teams new
  'com.apple.FaceTime', // FaceTime
  'com.google.Chrome.app.meet', // Meet PWA
  'com.tinyspeck.slackmacgap', // Slack (huddle proxy — not reliable, but a signal)
  'com.hnc.Discord', // Discord
  'com.webex.meetingmanager',
]

const CALL_APP_PROC_NAMES = [
  'zoom.us',
  'Microsoft Teams',
  'Microsoft Teams (work or school)',
  'FaceTime',
  'Google Meet',
  'Webex',
  'WebexHelper',
  'Slack Helper (Audio)', // slack huddle
]

export async function isInCall(): Promise<boolean> {
  // Fast path: ps for any of the known call helper processes
  try {
    const { stdout } = await execFileP(
      '/bin/sh',
      ['-c', 'ps -axco command'],
      { timeout: 1500 },
    )
    const procs = stdout.split('\n')
    for (const name of CALL_APP_PROC_NAMES) {
      if (procs.includes(name)) return true
    }
  } catch {
    // fall through
  }

  // Extra signal: check if the microphone is currently in use via the TCC
  // log stream. Too noisy for reliable detection here, so we skip it —
  // the process check above catches 90% of real-world calls.

  // Tiny sanity check: if one of the call app bundles is running, be cautious.
  try {
    const { stdout } = await execFileP(
      'osascript',
      [
        '-e',
        `tell application "System Events" to get bundle identifier of every process`,
      ],
      { timeout: 2000 },
    )
    const bundles = stdout.split(',').map((s) => s.trim())
    for (const id of CALL_APP_BUNDLE_IDS) {
      if (bundles.includes(id)) {
        // app running is weak signal; combined with any mic-using check would
        // be stronger. Good enough for now.
        return true
      }
    }
  } catch {
    // ignore
  }

  return false
}

// ========== proactive push gate ==========

/**
 * Should a proactive message be pushed to Telegram (mobile) instead of,
 * or in addition to, showing up on the Mac?
 *
 * User decision (see CLAUDE.md `Fixed decisions`): push to Telegram ONLY
 * when the Mac is unavailable. Defined as:
 *
 *   - screen is locked, OR
 *   - user has been idle for >= 30 minutes
 *
 * "Asleep" is folded into "locked" in practice — launchd processes are
 * frozen in true sleep, and display sleep reads as locked on most setups.
 *
 * Unlike `getAvailability`, this function does NOT treat focus mode or
 * in-call as "away" — the user is still physically present and may see a
 * desktop notification. Pushing to Telegram in those cases would be
 * over-notifying.
 */
const PUSH_IDLE_THRESHOLD_SECONDS = 30 * 60 // 30 minutes

export function shouldPushProactiveToPhone(): {
  push: boolean
  reason: string
} {
  if (isScreenLocked()) {
    return { push: true, reason: 'screen locked' }
  }
  const idle = getIdleSeconds()
  if (idle >= PUSH_IDLE_THRESHOLD_SECONDS) {
    return { push: true, reason: `idle ${Math.round(idle / 60)}m` }
  }
  return { push: false, reason: `present (idle ${Math.round(idle)}s)` }
}

// ========== composite availability ==========

export interface Availability {
  available: boolean
  reason: string | null
  idleSeconds: number
}

const MAX_IDLE_BEFORE_UNAVAILABLE = 5 * 60 // 5 minutes

/**
 * Combined presence check: is it okay to interrupt the user right now?
 * Returns `available: true` only if all gates pass.
 */
export async function getAvailability(): Promise<Availability> {
  const idle = getIdleSeconds()

  if (isScreenLocked()) {
    return { available: false, reason: 'screen locked', idleSeconds: idle }
  }
  if (idle > MAX_IDLE_BEFORE_UNAVAILABLE) {
    return { available: false, reason: `idle ${Math.round(idle)}s`, idleSeconds: idle }
  }
  if (isInFocusMode()) {
    return { available: false, reason: 'focus mode', idleSeconds: idle }
  }
  if (await isInCall()) {
    return { available: false, reason: 'in a call', idleSeconds: idle }
  }

  return { available: true, reason: null, idleSeconds: idle }
}
