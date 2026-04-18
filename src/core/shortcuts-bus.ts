/**
 * macOS Shortcuts.app bus: auto-discovers the user's Shortcuts and lets the
 * agent run them by name via a single `run_shortcut` tool.
 *
 * Apple's `shortcuts` CLI (built-in since macOS 12) exposes:
 *   shortcuts list             — prints one shortcut name per line
 *   shortcuts run "Name"       — runs the shortcut
 *   shortcuts run "Name" --input-path -  (stdin input)
 *   shortcuts run "Name" --output-path - (stdout output)
 *
 * This module caches the list on startup + refresh, and provides a runner
 * that handles stdin input and stdout capture.
 */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { Writable } from 'node:stream'

const execFileP = promisify(execFile)

let cached: string[] | null = null
let lastRefresh = 0
const REFRESH_INTERVAL_MS = 10 * 60 * 1000 // 10 min

/** List all Shortcuts the user has in Shortcuts.app. */
export async function listShortcuts(force = false): Promise<string[]> {
  if (!force && cached && Date.now() - lastRefresh < REFRESH_INTERVAL_MS) {
    return cached
  }
  try {
    const { stdout } = await execFileP('shortcuts', ['list'], {
      timeout: 5_000,
    })
    cached = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    lastRefresh = Date.now()
    return cached
  } catch (err) {
    console.warn('[nina] shortcuts list failed:', err)
    return cached ?? []
  }
}

export interface ShortcutRunResult {
  output: string
  exitCode: number
  error?: string
}

/**
 * Run a shortcut by exact name. Optional text input is passed via stdin.
 * Returns captured stdout. Times out at 60s.
 */
export async function runShortcut(
  name: string,
  input?: string,
): Promise<ShortcutRunResult> {
  // Verify the shortcut exists to give a clear error (the CLI otherwise exits
  // with an unhelpful generic error)
  const all = await listShortcuts()
  if (!all.includes(name)) {
    const close = all.filter((n) => n.toLowerCase().includes(name.toLowerCase())).slice(0, 5)
    return {
      output: '',
      exitCode: -1,
      error: `Shortcut "${name}" not found.${close.length > 0 ? ` Did you mean: ${close.join(', ')}?` : ''}`,
    }
  }

  return new Promise((resolve) => {
    const args = ['run', name]
    if (input !== undefined) {
      args.push('--input-path', '-')
    }
    args.push('--output-path', '-')

    const child = spawn('shortcuts', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60_000,
    })

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    if (input !== undefined && child.stdin) {
      ;(child.stdin as Writable).end(input)
    } else if (child.stdin) {
      ;(child.stdin as Writable).end()
    }

    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve({ output: stdout.trim(), exitCode: 0 })
      } else {
        resolve({
          output: stdout.trim(),
          exitCode: code ?? -1,
          error: stderr.trim() || `exited with code ${code}`,
        })
      }
    })

    child.on('error', (err: Error) => {
      resolve({ output: '', exitCode: -1, error: err.message })
    })
  })
}
