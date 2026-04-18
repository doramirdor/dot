/**
 * Plugin lifecycle service — runs on OpenClaw gateway start.
 *
 * Handles one-time setup (compile Swift AX binary, scan installed apps)
 * and long-running background work (screen watcher).
 */
import { checkAccessibility } from '../core/native-ax.js'
import { scanApps, getIndex } from '../core/app-index.js'
import * as screenWatcher from '../core/screen-watcher.js'

export interface DotMacServiceOptions {
  enableScreenWatcher?: boolean
  screenWatcherIntervalMs?: number
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }
}

let started = false
let screenWatcherInterval: ReturnType<typeof setInterval> | null = null

export async function startService(opts: DotMacServiceOptions = {}): Promise<void> {
  if (started) return
  started = true
  const log = opts.logger ?? console

  // 1. Compile AX binary (idempotent — skips if already compiled)
  try {
    const axResult = await checkAccessibility()
    if (axResult.compiled) {
      log.info('[dot-mac] AX binary compiled and ready')
    } else {
      log.warn('[dot-mac] AX binary not compiled — native app accessibility will be unavailable')
    }
    if (!axResult.trusted) {
      log.warn('[dot-mac] AX not trusted — grant in System Settings → Privacy & Security → Accessibility')
    }
  } catch (err) {
    log.error(`[dot-mac] AX check failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 2. Scan installed apps (populates the fuzzy index)
  try {
    const idx = await scanApps()
    log.info(`[dot-mac] App index: ${idx.apps.length} installed apps`)
  } catch (err) {
    log.error(`[dot-mac] App scan failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 3. Start screen watcher (optional, default on)
  if (opts.enableScreenWatcher !== false) {
    const intervalMs = opts.screenWatcherIntervalMs ?? 180_000 // 3 min default
    try {
      screenWatcher.startScreenWatcher(intervalMs)
      log.info(`[dot-mac] Screen watcher started (every ${intervalMs / 1000}s)`)
    } catch (err) {
      log.error(`[dot-mac] Screen watcher failed to start: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

export function stopService(): void {
  if (!started) return
  started = false
  try {
    screenWatcher.stopScreenWatcher()
  } catch {
    // ignore — may not have been started
  }
  if (screenWatcherInterval) {
    clearInterval(screenWatcherInterval)
    screenWatcherInterval = null
  }
}

export async function serviceStatus(): Promise<{
  axCompiled: boolean
  axTrusted: boolean
  appsScanned: number
  screenWatcherActive: boolean
}> {
  let axCompiled = false
  let axTrusted = false
  try {
    const result = await checkAccessibility()
    axCompiled = result.compiled ?? false
    axTrusted = result.trusted ?? false
  } catch {
    // leave as false
  }

  let appsScanned = 0
  try {
    const idx = await getIndex()
    appsScanned = idx.apps.length
  } catch {
    // leave as 0
  }

  return {
    axCompiled,
    axTrusted,
    appsScanned,
    screenWatcherActive: started,  // proxy: if service started and screen watcher wasn't disabled, it's running
  }
}
