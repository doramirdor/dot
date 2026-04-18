/**
 * Migration utilities — pull state from sibling Claw projects into Dot.
 *
 * Supported sources:
 *   - openClaw at ~/.openclaw (auth profiles, memory files, skills hints)
 *   - nanoClaw at ~/.nanoclaw (SQLite message history, per-group CLAUDE.md)
 *
 * Dot's native data dir is ~/.nina. Migration never deletes source data —
 * only reads and copies. Idempotent: running twice won't duplicate memories.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Database from 'better-sqlite3'
import { NINA_DIR, MEMORY_DIR, ensureMemoryDir } from './memory.js'
import { logEvent, logConversation } from './db.js'

const OPENCLAW_DIR = path.join(os.homedir(), '.openclaw')
const NANOCLAW_DIR = path.join(os.homedir(), '.nanoclaw')
const IMPORT_MARK = path.join(NINA_DIR, '.import-marks.json')

interface ImportMarks {
  openclawAuth?: string
  openclawMemory?: string
  nanoclawMessages?: { lastId: number; at: string }
}

function readMarks(): ImportMarks {
  try {
    if (!fs.existsSync(IMPORT_MARK)) return {}
    return JSON.parse(fs.readFileSync(IMPORT_MARK, 'utf8')) as ImportMarks
  } catch {
    return {}
  }
}

function writeMarks(m: ImportMarks): void {
  fs.mkdirSync(path.dirname(IMPORT_MARK), { recursive: true })
  fs.writeFileSync(IMPORT_MARK, JSON.stringify(m, null, 2) + '\n', 'utf8')
}

export interface MigrationReport {
  source: 'openclaw' | 'nanoclaw'
  available: boolean
  itemsImported: number
  notes: string[]
  skipped: string[]
}

// ========== openClaw ==========

export function migrateFromOpenClaw(): MigrationReport {
  const report: MigrationReport = {
    source: 'openclaw',
    available: false,
    itemsImported: 0,
    notes: [],
    skipped: [],
  }
  if (!fs.existsSync(OPENCLAW_DIR)) {
    report.notes.push('~/.openclaw not found')
    return report
  }
  report.available = true
  ensureMemoryDir()
  const marks = readMarks()

  // 1. Auth profiles — Dot already reads from this path on startup, so we
  //    only record that it exists. No copy.
  const authFile = path.join(OPENCLAW_DIR, 'agents/main/agent/auth-profiles.json')
  if (fs.existsSync(authFile)) {
    report.notes.push(`auth profiles detected at ${authFile} (Dot reads directly)`)
    marks.openclawAuth = new Date().toISOString()
  } else {
    report.skipped.push('no auth-profiles.json')
  }

  // 2. Memory files — copy .md files from openclaw memory into Dot's memory dir,
  //    prefixed so they don't collide with Dot's own.
  const srcMemDir = path.join(OPENCLAW_DIR, 'memory')
  if (fs.existsSync(srcMemDir)) {
    const copied = copyMarkdownTree(srcMemDir, path.join(MEMORY_DIR, 'imported', 'openclaw'))
    report.itemsImported += copied
    if (copied > 0) report.notes.push(`imported ${copied} memory files from openclaw`)
    marks.openclawMemory = new Date().toISOString()
  } else {
    report.skipped.push('no ~/.openclaw/memory')
  }

  // 3. Identity / soul hints — if there's an identity.json, stash it as a note.
  const idFile = path.join(OPENCLAW_DIR, 'identity', 'identity.json')
  if (fs.existsSync(idFile)) {
    try {
      const content = fs.readFileSync(idFile, 'utf8')
      const notePath = path.join(MEMORY_DIR, 'imported', 'openclaw', 'identity.md')
      fs.mkdirSync(path.dirname(notePath), { recursive: true })
      fs.writeFileSync(
        notePath,
        `---
name: openclaw identity (imported)
description: Identity metadata copied from openClaw on migration
type: reference
---

\`\`\`json
${content}
\`\`\`
`,
        'utf8',
      )
      report.itemsImported += 1
      report.notes.push('imported openclaw identity.json')
    } catch (err) {
      report.skipped.push(`identity.json: ${(err as Error).message}`)
    }
  }

  writeMarks(marks)
  logEvent('migrate.openclaw', {
    imported: report.itemsImported,
    notes: report.notes.length,
  })
  return report
}

// ========== nanoClaw ==========

export function migrateFromNanoClaw(): MigrationReport {
  const report: MigrationReport = {
    source: 'nanoclaw',
    available: false,
    itemsImported: 0,
    notes: [],
    skipped: [],
  }
  if (!fs.existsSync(NANOCLAW_DIR)) {
    report.notes.push('~/.nanoclaw not found')
    return report
  }
  report.available = true
  ensureMemoryDir()
  const marks = readMarks()

  // 1. Messages DB — import new rows into Dot's conversations table as a
  //    'nanoclaw-import' session so they're searchable but clearly marked.
  const msgDb = path.join(NANOCLAW_DIR, 'store', 'messages.db')
  if (fs.existsSync(msgDb)) {
    try {
      const imported = importNanoClawMessages(msgDb, marks.nanoclawMessages?.lastId ?? 0)
      report.itemsImported += imported.count
      marks.nanoclawMessages = {
        lastId: imported.lastId,
        at: new Date().toISOString(),
      }
      if (imported.count > 0) {
        report.notes.push(`imported ${imported.count} messages from nanoclaw`)
      } else {
        report.notes.push('nanoclaw messages already up to date')
      }
    } catch (err) {
      report.skipped.push(`messages.db: ${(err as Error).message}`)
    }
  } else {
    report.skipped.push('no nanoclaw messages.db')
  }

  // 2. Per-group CLAUDE.md files — stash as imported memory notes.
  const groupsDir = path.join(NANOCLAW_DIR, 'groups')
  if (fs.existsSync(groupsDir)) {
    try {
      const groups = fs.readdirSync(groupsDir, { withFileTypes: true })
      let count = 0
      for (const g of groups) {
        if (!g.isDirectory()) continue
        const claudeMd = path.join(groupsDir, g.name, 'CLAUDE.md')
        if (!fs.existsSync(claudeMd)) continue
        const dest = path.join(
          MEMORY_DIR,
          'imported',
          'nanoclaw',
          `group-${sanitize(g.name)}.md`,
        )
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        const body = fs.readFileSync(claudeMd, 'utf8')
        fs.writeFileSync(
          dest,
          `---
name: nanoclaw group ${g.name}
description: CLAUDE.md imported from nanoclaw group ${g.name}
type: reference
---

${body}`,
          'utf8',
        )
        count += 1
      }
      report.itemsImported += count
      if (count > 0) report.notes.push(`imported ${count} nanoclaw group contexts`)
    } catch (err) {
      report.skipped.push(`groups: ${(err as Error).message}`)
    }
  }

  writeMarks(marks)
  logEvent('migrate.nanoclaw', {
    imported: report.itemsImported,
    notes: report.notes.length,
  })
  return report
}

// ========== helpers ==========

function importNanoClawMessages(
  dbPath: string,
  sinceId: number,
): { count: number; lastId: number } {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    // nanoclaw schema varies. Try common column names; fall back to generic.
    const tableInfo = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
      .get() as { name: string } | undefined
    if (!tableInfo) return { count: 0, lastId: sinceId }

    const cols = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
    const colNames = new Set(cols.map((c) => c.name))
    const idCol = colNames.has('id') ? 'id' : 'rowid'
    const bodyCol = colNames.has('body')
      ? 'body'
      : colNames.has('content')
        ? 'content'
        : colNames.has('text')
          ? 'text'
          : null
    if (!bodyCol) return { count: 0, lastId: sinceId }
    const roleCol = colNames.has('role')
      ? 'role'
      : colNames.has('sender')
        ? 'sender'
        : null
    const groupCol = colNames.has('group_id')
      ? 'group_id'
      : colNames.has('chat_id')
        ? 'chat_id'
        : null

    const select = `
      SELECT ${idCol} as id, ${bodyCol} as body
      ${roleCol ? `, ${roleCol} as role` : ''}
      ${groupCol ? `, ${groupCol} as grp` : ''}
      FROM messages
      WHERE ${idCol} > ?
      ORDER BY ${idCol} ASC
      LIMIT 5000
    `
    const rows = db.prepare(select).all(sinceId) as Array<{
      id: number
      body: string
      role?: string
      grp?: string
    }>

    let maxId = sinceId
    for (const row of rows) {
      const role = normalizeRole(row.role)
      const body = String(row.body ?? '').slice(0, 20_000)
      if (!body.trim()) continue
      const tag = row.grp ? `[nanoclaw:${row.grp}] ` : '[nanoclaw] '
      logConversation(role, tag + body, 'nanoclaw-import')
      if (row.id > maxId) maxId = row.id
    }
    return { count: rows.length, lastId: maxId }
  } finally {
    db.close()
  }
}

function normalizeRole(r: string | undefined): 'user' | 'assistant' | 'system' {
  const s = (r ?? '').toLowerCase()
  if (s.includes('assist') || s === 'bot' || s === 'agent') return 'assistant'
  if (s === 'system') return 'system'
  return 'user'
}

function copyMarkdownTree(src: string, dest: string): number {
  let count = 0
  if (!fs.existsSync(src)) return 0
  fs.mkdirSync(dest, { recursive: true })
  const entries = fs.readdirSync(src, { withFileTypes: true })
  for (const e of entries) {
    const from = path.join(src, e.name)
    const to = path.join(dest, e.name)
    if (e.isDirectory()) {
      count += copyMarkdownTree(from, to)
    } else if (e.isFile() && /\.(md|markdown|txt)$/i.test(e.name)) {
      try {
        fs.copyFileSync(from, to)
        count += 1
      } catch {
        // ignore
      }
    }
  }
  return count
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 60)
}

// ========== orchestrator ==========

export function migrateAll(): MigrationReport[] {
  return [migrateFromOpenClaw(), migrateFromNanoClaw()]
}

export function formatReports(reports: MigrationReport[]): string {
  const lines: string[] = []
  for (const r of reports) {
    lines.push(`\n# ${r.source}`)
    lines.push(r.available ? `  available: yes` : `  available: no`)
    lines.push(`  items imported: ${r.itemsImported}`)
    if (r.notes.length) lines.push(`  notes:\n${r.notes.map((n) => `    - ${n}`).join('\n')}`)
    if (r.skipped.length)
      lines.push(`  skipped:\n${r.skipped.map((n) => `    - ${n}`).join('\n')}`)
  }
  return lines.join('\n')
}
