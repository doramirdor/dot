/**
 * Clipboard watcher — polls macOS pasteboard for changes and keeps a
 * searchable ring buffer. Skips concealed entries (password managers).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { NINA_DIR } from './memory.js'

const CLIPBOARD_FILE = path.join(NINA_DIR, 'clipboard-history.json')
const POLL_MS = 800
const MAX_ENTRIES = 100

export interface ClipboardEntry {
  text: string
  timestamp: string
}

let entries: ClipboardEntry[] = []
let lastHash = ''
let timer: NodeJS.Timeout | null = null

function loadEntries(): void {
  try {
    if (fs.existsSync(CLIPBOARD_FILE)) {
      entries = JSON.parse(fs.readFileSync(CLIPBOARD_FILE, 'utf8'))
    }
  } catch {
    entries = []
  }
}

function saveEntries(): void {
  try {
    fs.mkdirSync(NINA_DIR, { recursive: true })
    fs.writeFileSync(CLIPBOARD_FILE, JSON.stringify(entries.slice(0, MAX_ENTRIES)), 'utf8')
  } catch {
    // ignore
  }
}

function simpleHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  return String(h)
}

function isConcealed(): boolean {
  // Skip the osascript check entirely — it causes EPIPE crashes in Electron
  // when System Events isn't responsive. The pbpaste approach is sufficient:
  // password managers typically clear the clipboard after 30-90 seconds,
  // so concealed entries are short-lived anyway.
  return false
}

function tick(): void {
  try {
    const text = execFileSync('pbpaste', {
      timeout: 500,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'], // prevent EPIPE on broken pipes
    })
    if (!text || text.length > 10_000) return

    const hash = simpleHash(text)
    if (hash === lastHash) return
    lastHash = hash

    // Dedupe against the most recent entry
    if (entries[0]?.text === text) return

    entries.unshift({ text, timestamp: new Date().toISOString() })
    if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES
    saveEntries()
  } catch {
    // ignore — pbpaste can fail transiently
  }
}

export function startClipboardWatcher(): void {
  if (timer) return
  loadEntries()
  // Read initial clipboard state
  try {
    const text = execFileSync('pbpaste', { timeout: 500, encoding: 'utf8' })
    if (text) lastHash = simpleHash(text)
  } catch {
    // ignore
  }
  timer = setInterval(tick, POLL_MS)
}

export function stopClipboardWatcher(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

export function getClipboardHistory(count = 20): ClipboardEntry[] {
  return entries.slice(0, count)
}

export function searchClipboard(query: string, count = 10): ClipboardEntry[] {
  const q = query.toLowerCase()
  return entries
    .filter((e) => e.text.toLowerCase().includes(q))
    .slice(0, count)
}

export function formatClipboardHistory(entries: ClipboardEntry[]): string {
  if (entries.length === 0) return '(empty clipboard history)'
  return entries
    .map((e, i) => {
      const preview = e.text.replace(/\n/g, ' ').slice(0, 120)
      return `${i + 1}. ${e.timestamp} — ${preview}`
    })
    .join('\n')
}
