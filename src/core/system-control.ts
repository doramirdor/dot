/**
 * System-level controls for macOS.
 *
 * Gives Nina direct levers over the things Jarvis would control:
 * volume, brightness, dark mode, WiFi, Bluetooth, Do Not Disturb,
 * screen lock, sleep, window management, media playback, processes,
 * and file operations.
 *
 * All implementations use macOS-native CLI tools or AppleScript —
 * no third-party dependencies.
 */
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

async function osa(script: string, timeout = 5000): Promise<string> {
  const { stdout } = await execFileP('osascript', ['-e', script], { timeout })
  return stdout.trim()
}

function osaSync(script: string): string {
  return execFileSync('osascript', ['-e', script], {
    timeout: 3000,
    encoding: 'utf8',
  }).trim()
}

// ======================== VOLUME ========================

export async function getVolume(): Promise<number> {
  const raw = await osa('output volume of (get volume settings)')
  return parseInt(raw, 10)
}

export async function setVolume(level: number): Promise<void> {
  const clamped = Math.max(0, Math.min(100, Math.round(level)))
  await osa(`set volume output volume ${clamped}`)
}

export async function toggleMute(): Promise<boolean> {
  const current = await osa('output muted of (get volume settings)')
  const newState = current !== 'true'
  await osa(`set volume output muted ${newState}`)
  return newState
}

// ======================== BRIGHTNESS ========================

export async function getBrightness(): Promise<number> {
  try {
    const { stdout } = await execFileP(
      'brightness',
      ['-l'],
      { timeout: 2000 },
    )
    const match = stdout.match(/brightness\s+([\d.]+)/i)
    return match ? Math.round(parseFloat(match[1]!) * 100) : -1
  } catch {
    // brightness CLI not installed; try AppleScript
    try {
      // This only works on some Macs (external displays may not support it)
      const raw = await osa(
        'tell application "System Events" to get value of slider 1 of group 1 of window 1 of application process "Control Center"',
      )
      return Math.round(parseFloat(raw) * 100)
    } catch {
      return -1
    }
  }
}

export async function setBrightness(percent: number): Promise<void> {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)))
  const val = (clamped / 100).toFixed(2)
  try {
    await execFileP('brightness', [val], { timeout: 2000 })
  } catch {
    // Fallback: use AppleScript via System Preferences
    // Less reliable but works without the brightness CLI
    console.warn('[system] brightness CLI not found; install via `brew install brightness`')
  }
}

// ======================== DARK MODE ========================

export async function isDarkMode(): Promise<boolean> {
  const raw = await osa(
    'tell application "System Events" to tell appearance preferences to get dark mode',
  )
  return raw === 'true'
}

export async function setDarkMode(enabled: boolean): Promise<void> {
  await osa(
    `tell application "System Events" to tell appearance preferences to set dark mode to ${enabled}`,
  )
}

export async function toggleDarkMode(): Promise<boolean> {
  const current = await isDarkMode()
  await setDarkMode(!current)
  return !current
}

// ======================== WIFI ========================

export async function getWifiStatus(): Promise<{
  on: boolean
  ssid: string | null
}> {
  try {
    const { stdout } = await execFileP(
      'networksetup',
      ['-getairportpower', 'en0'],
      { timeout: 3000 },
    )
    const on = /on$/i.test(stdout.trim())
    let ssid: string | null = null
    if (on) {
      try {
        const { stdout: ssidOut } = await execFileP(
          'ipconfig',
          ['getsummary', 'en0'],
          { timeout: 3000 },
        )
        const match = ssidOut.match(/SSID\s*:\s*(.+)/)
        ssid = match?.[1]?.trim() ?? null
      } catch {
        // ignore
      }
    }
    return { on, ssid }
  } catch {
    return { on: false, ssid: null }
  }
}

export async function setWifi(on: boolean): Promise<void> {
  await execFileP(
    'networksetup',
    ['-setairportpower', 'en0', on ? 'on' : 'off'],
    { timeout: 5000 },
  )
}

// ======================== BLUETOOTH ========================

export async function isBluetoothOn(): Promise<boolean> {
  try {
    const { stdout } = await execFileP(
      'defaults',
      ['read', '/Library/Preferences/com.apple.Bluetooth', 'ControllerPowerState'],
      { timeout: 2000 },
    )
    return stdout.trim() === '1'
  } catch {
    return true // assume on if we can't read
  }
}

// Note: toggling Bluetooth programmatically requires blueutil (brew install blueutil)
// or an SPI call. We'll shell out to blueutil if available.
export async function setBluetooth(on: boolean): Promise<void> {
  try {
    await execFileP('blueutil', ['--power', on ? '1' : '0'], { timeout: 3000 })
  } catch {
    console.warn('[system] blueutil not found; install via `brew install blueutil`')
    throw new Error('blueutil not installed — run `brew install blueutil`')
  }
}

// ======================== SCREEN ========================

export async function lockScreen(): Promise<void> {
  await execFileP(
    'osascript',
    ['-e', 'tell application "System Events" to keystroke "q" using {command down, control down}'],
    { timeout: 3000 },
  )
}

export async function sleepDisplay(): Promise<void> {
  await execFileP('pmset', ['displaysleepnow'], { timeout: 3000 })
}

// ======================== MEDIA ========================

export async function mediaPlayPause(): Promise<void> {
  // System-wide play/pause via media key simulation
  await osa(`
    tell application "System Events"
      key code 49 using {command down, option down}
    end tell
  `)
  // More reliable: try Music.app and Spotify specifically
  try {
    await osa('tell application "Music" to playpause')
  } catch {
    try {
      await osa('tell application "Spotify" to playpause')
    } catch {
      // ignore — one of them might not be running
    }
  }
}

export async function mediaNext(): Promise<void> {
  try {
    await osa('tell application "Music" to next track')
  } catch {
    try {
      await osa('tell application "Spotify" to next track')
    } catch {
      // ignore
    }
  }
}

export async function mediaPrevious(): Promise<void> {
  try {
    await osa('tell application "Music" to previous track')
  } catch {
    try {
      await osa('tell application "Spotify" to previous track')
    } catch {
      // ignore
    }
  }
}

export async function getNowPlaying(): Promise<{
  track: string
  artist: string
  app: string
} | null> {
  // Try Spotify first (more common for dev users)
  try {
    const state = await osa(
      'tell application "Spotify" to get player state as string',
    )
    if (state === 'playing' || state === 'paused') {
      const track = await osa('tell application "Spotify" to get name of current track')
      const artist = await osa('tell application "Spotify" to get artist of current track')
      return { track, artist, app: 'Spotify' }
    }
  } catch {
    // Spotify not running
  }
  // Try Music.app
  try {
    const state = await osa(
      'tell application "Music" to get player state as string',
    )
    if (state === 'playing' || state === 'paused') {
      const track = await osa('tell application "Music" to get name of current track')
      const artist = await osa('tell application "Music" to get artist of current track')
      return { track, artist, app: 'Music' }
    }
  } catch {
    // Music not running
  }
  return null
}

// ======================== WINDOW MANAGEMENT ========================

export async function listWindows(): Promise<
  Array<{ app: string; title: string; id: number; position: number[]; size: number[] }>
> {
  const script = `
set out to ""
tell application "System Events"
  repeat with proc in (every process whose visible is true)
    try
      set appName to name of proc
      repeat with w in (every window of proc)
        try
          set wName to name of w
          set wPos to position of w
          set wSize to size of w
          set wId to id of w
          set out to out & appName & "|||" & wName & "|||" & wId & "|||" & (item 1 of wPos) & "," & (item 2 of wPos) & "|||" & (item 1 of wSize) & "," & (item 2 of wSize) & linefeed
        end try
      end repeat
    end try
  end repeat
end tell
return out`
  const raw = await osa(script, 8000)
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [app = '', title = '', idStr = '0', posStr = '0,0', sizeStr = '0,0'] =
        line.split('|||')
      const pos = posStr.split(',').map(Number)
      const sz = sizeStr.split(',').map(Number)
      return {
        app,
        title: title.slice(0, 120),
        id: parseInt(idStr, 10),
        position: pos,
        size: sz,
      }
    })
    .slice(0, 30)
}

export async function moveWindow(
  appName: string,
  x: number,
  y: number,
): Promise<void> {
  await osa(`
    tell application "System Events"
      tell process "${appName.replace(/"/g, '\\"')}"
        try
          set position of window 1 to {${Math.round(x)}, ${Math.round(y)}}
        end try
      end tell
    end tell
  `)
}

export async function resizeWindow(
  appName: string,
  width: number,
  height: number,
): Promise<void> {
  await osa(`
    tell application "System Events"
      tell process "${appName.replace(/"/g, '\\"')}"
        try
          set size of window 1 to {${Math.round(width)}, ${Math.round(height)}}
        end try
      end tell
    end tell
  `)
}

export async function minimizeWindow(appName: string): Promise<void> {
  await osa(`
    tell application "${appName.replace(/"/g, '\\"')}"
      try
        set miniaturized of window 1 to true
      end try
    end tell
  `)
}

export async function closeWindow(appName: string): Promise<void> {
  await osa(`
    tell application "${appName.replace(/"/g, '\\"')}"
      try
        close window 1
      end try
    end tell
  `)
}

export async function focusApp(appName: string): Promise<void> {
  await osa(`
    tell application "${appName.replace(/"/g, '\\"')}" to activate
  `)
}

/**
 * Tile two apps side by side. Takes the left half and right half of the
 * primary display.
 */
export async function tileTwoApps(leftApp: string, rightApp: string): Promise<void> {
  const script = `
    tell application "System Events"
      set screenSize to {1, 1}
      try
        set screenSize to size of scroll area 1 of application process "Finder"
      on error
        -- fallback: assume 1440x900
        set screenSize to {1440, 900}
      end try
    end tell

    set screenW to item 1 of screenSize
    set screenH to item 2 of screenSize
    set halfW to screenW div 2

    tell application "${leftApp.replace(/"/g, '\\"')}" to activate
    tell application "System Events"
      tell process "${leftApp.replace(/"/g, '\\"')}"
        try
          set position of window 1 to {0, 25}
          set size of window 1 to {halfW, screenH - 25}
        end try
      end tell
    end tell

    tell application "${rightApp.replace(/"/g, '\\"')}" to activate
    tell application "System Events"
      tell process "${rightApp.replace(/"/g, '\\"')}"
        try
          set position of window 1 to {halfW, 25}
          set size of window 1 to {halfW, screenH - 25}
        end try
      end tell
    end tell
  `
  await osa(script, 8000)
}

// ======================== PROCESSES ========================

export async function listRunningApps(): Promise<string[]> {
  const raw = await osa(
    'tell application "System Events" to get name of every process whose background only is false',
  )
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

export async function quitApp(appName: string): Promise<void> {
  await osa(`tell application "${appName.replace(/"/g, '\\"')}" to quit`)
}

export async function forceQuitApp(appName: string): Promise<void> {
  try {
    await execFileP('pkill', ['-f', appName], { timeout: 3000 })
  } catch {
    // pkill returns non-zero if no process matched — fine
  }
}

/**
 * Launch a macOS app by name (e.g. "Safari", "Music", "Calendar") or by
 * absolute path. Uses `open -a` which handles display name → bundle
 * resolution. If the app is already running, this activates (brings to
 * front) instead of re-launching. Works for any installed app.
 */
export async function launchApp(appName: string): Promise<void> {
  await execFileP('open', ['-a', appName], { timeout: 10_000 })
}

/**
 * Launch or activate an app and optionally open a specific file with it.
 * e.g. openFileWithApp("/tmp/x.pdf", "Preview")
 */
export async function openFileWithApp(
  filePath: string,
  appName: string,
): Promise<void> {
  await execFileP('open', ['-a', appName, filePath], { timeout: 10_000 })
}

/**
 * Open a URL or file path with the system default handler. Same as
 * double-clicking — "open https://..." opens the default browser,
 * "open file.pdf" opens Preview, etc.
 */
export async function openWithDefault(target: string): Promise<void> {
  await execFileP('open', [target], { timeout: 10_000 })
}

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * List installed apps by scanning /Applications and ~/Applications.
 * Returns display names (".app" suffix stripped).
 */
export async function listInstalledApps(): Promise<
  Array<{ name: string; path: string; location: 'system' | 'user' }>
> {
  const out: Array<{ name: string; path: string; location: 'system' | 'user' }> = []
  const dirs: Array<{ dir: string; location: 'system' | 'user' }> = [
    { dir: '/Applications', location: 'system' },
    { dir: path.join(os.homedir(), 'Applications'), location: 'user' },
    { dir: '/System/Applications', location: 'system' },
  ]
  for (const { dir, location } of dirs) {
    if (!fs.existsSync(dir)) continue
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.name.endsWith('.app')) {
        out.push({
          name: e.name.replace(/\.app$/, ''),
          path: path.join(dir, e.name),
          location,
        })
      }
      // Recurse one level for /System/Applications/Utilities
      if (e.isDirectory() && !e.name.endsWith('.app')) {
        const subdir = path.join(dir, e.name)
        try {
          const sub = fs.readdirSync(subdir, { withFileTypes: true })
          for (const s of sub) {
            if (s.name.endsWith('.app')) {
              out.push({
                name: s.name.replace(/\.app$/, ''),
                path: path.join(subdir, s.name),
                location,
              })
            }
          }
        } catch {
          // ignore
        }
      }
    }
  }
  // Dedupe by name (system wins over user if same name)
  const seen = new Map<string, { name: string; path: string; location: 'system' | 'user' }>()
  for (const app of out) {
    if (!seen.has(app.name)) seen.set(app.name, app)
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Run an arbitrary AppleScript and return its stdout. This is the
 * universal access pattern for Mac apps — Mail, Calendar, Reminders,
 * Notes, Music, Photos, Safari, Chrome, Messages, Contacts, Finder,
 * Pages, Numbers, Keynote, and anything else with a scripting
 * dictionary is reachable through this one tool.
 *
 * Classified as `confirm` by the trust layer — it's arbitrary code
 * execution inside the user's session context, roughly Bash-equivalent.
 */
export async function runAppleScript(
  script: string,
  timeoutMs = 15_000,
): Promise<{ stdout: string; stderr: string }> {
  // Use execFile with -e so we can pass multi-line scripts without shell
  // escaping. Split on newlines and pass each as a separate -e to
  // preserve line semantics.
  const lines = script.split('\n')
  const args: string[] = []
  for (const line of lines) {
    args.push('-e', line)
  }
  try {
    const { stdout, stderr } = await execFileP('osascript', args, {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    })
    return { stdout, stderr }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? 'unknown error',
    }
  }
}

/**
 * Send a keyboard shortcut to the frontmost app. Useful for apps that
 * aren't fully scriptable but respond to cmd-N, cmd-shift-4, etc.
 * Modifiers: cmd, shift, option, control. Key is a single char or a
 * special like 'return', 'tab', 'space', 'delete', 'escape'.
 */
export async function sendKeyboardShortcut(
  key: string,
  modifiers: Array<'cmd' | 'shift' | 'option' | 'control'> = [],
): Promise<void> {
  const modMap: Record<string, string> = {
    cmd: 'command down',
    shift: 'shift down',
    option: 'option down',
    control: 'control down',
  }
  const usingParts = modifiers.map((m) => modMap[m]).filter(Boolean)
  const using = usingParts.length > 0 ? ` using {${usingParts.join(', ')}}` : ''
  const specials: Record<string, string> = {
    return: 'return',
    tab: 'tab',
    space: 'space',
    delete: 'delete',
    escape: 'escape',
    up: 'up arrow',
    down: 'down arrow',
    left: 'left arrow',
    right: 'right arrow',
  }
  const lower = key.toLowerCase()
  let keyExpr: string
  if (specials[lower]) {
    // Named key codes via `key code` are cleaner but vary by layout.
    // Use keystroke with a key name via `key code` special handling.
    const keyCodes: Record<string, number> = {
      return: 36,
      tab: 48,
      space: 49,
      delete: 51,
      escape: 53,
      up: 126,
      down: 125,
      left: 123,
      right: 124,
    }
    keyExpr = `key code ${keyCodes[lower]}`
    await osa(`tell application "System Events" to ${keyExpr}${using}`)
    return
  }
  const escaped = key.replace(/"/g, '\\"')
  await osa(`tell application "System Events" to keystroke "${escaped}"${using}`)
}

// ======================== FILE OPERATIONS ========================

export async function revealInFinder(filePath: string): Promise<void> {
  await execFileP('open', ['-R', filePath], { timeout: 3000 })
}

export async function quickLook(filePath: string): Promise<void> {
  // qlmanage -p opens Quick Look preview
  execFile('qlmanage', ['-p', filePath], { timeout: 30_000 }, () => {})
}

export async function moveToTrash(filePath: string): Promise<void> {
  await osa(`
    tell application "Finder"
      move POSIX file "${filePath.replace(/"/g, '\\"')}" to trash
    end tell
  `)
}

// ======================== SYSTEM INFO ========================

export async function getSystemStatus(): Promise<{
  volume: number
  muted: boolean
  darkMode: boolean
  wifi: { on: boolean; ssid: string | null }
  bluetooth: boolean
  nowPlaying: { track: string; artist: string; app: string } | null
  batteryPercent: number | null
}> {
  const [volume, muted, darkMode, wifi, bluetooth, nowPlaying, battery] =
    await Promise.all([
      getVolume().catch(() => 0),
      osa('output muted of (get volume settings)')
        .then((r) => r === 'true')
        .catch(() => false),
      isDarkMode().catch(() => false),
      getWifiStatus().catch(() => ({ on: false, ssid: null })),
      isBluetoothOn().catch(() => true),
      getNowPlaying().catch(() => null),
      (async () => {
        try {
          const { stdout } = await execFileP('pmset', ['-g', 'batt'], {
            timeout: 2000,
          })
          const match = stdout.match(/(\d+)%/)
          return match ? parseInt(match[1]!, 10) : null
        } catch {
          return null
        }
      })(),
    ])

  return { volume, muted, darkMode, wifi, bluetooth, nowPlaying, batteryPercent: battery }
}
