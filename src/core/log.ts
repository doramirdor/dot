/**
 * Tiny append-only logger for Dot's runtime — ticks, advisories, escalations.
 *
 * Writes to ~/.nina/logs/dot.log, one line per event, JSON-ish but readable.
 * Intended for `tail -f ~/.nina/logs/dot.log` during dev.
 *
 * Auto-rotates when the file exceeds MAX_BYTES — keeps the last half.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const LOG_DIR = path.join(os.homedir(), '.nina', 'logs')
export const LOG_FILE = path.join(LOG_DIR, 'dot.log')

const MAX_BYTES = 1024 * 1024 // 1 MB

function ensureDir(): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
  } catch {
    // ignore
  }
}

function rotateIfNeeded(): void {
  try {
    const stat = fs.statSync(LOG_FILE)
    if (stat.size > MAX_BYTES) {
      const raw = fs.readFileSync(LOG_FILE, 'utf8')
      fs.writeFileSync(LOG_FILE, raw.slice(-MAX_BYTES / 2), 'utf8')
    }
  } catch {
    // ignore
  }
}

function format(level: string, tag: string, data: Record<string, unknown>): string {
  const ts = new Date().toISOString()
  const body = Object.entries(data)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ')
  return `${ts} [${level}] ${tag} ${body}\n`
}

export function log(tag: string, data: Record<string, unknown> = {}): void {
  ensureDir()
  try {
    fs.appendFileSync(LOG_FILE, format('info', tag, data), 'utf8')
    rotateIfNeeded()
  } catch {
    // ignore
  }
}

export function warn(tag: string, data: Record<string, unknown> = {}): void {
  ensureDir()
  try {
    fs.appendFileSync(LOG_FILE, format('warn', tag, data), 'utf8')
    rotateIfNeeded()
  } catch {
    // ignore
  }
}
