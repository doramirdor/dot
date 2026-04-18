/**
 * Local SQLite database for Nina.
 *
 * Stores ALL structured data that was previously scattered across JSON/log files:
 *   - conversations (every user prompt + Nina's response)
 *   - tool_calls (every tool invocation with input/output + timing)
 *   - events (proactive interrupts, observations, system events)
 *   - audit log (same as tool_calls but queryable)
 *
 * DB lives at ~/.nina/nina.db. Schema auto-migrates on open.
 */
import Database from 'better-sqlite3'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

const DB_PATH = path.join(os.homedir(), '.nina', 'nina.db')

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      session_type TEXT DEFAULT 'chat',
      tokens_used INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      tool_name TEXT NOT NULL,
      input TEXT,
      output TEXT,
      decision TEXT CHECK(decision IN ('auto', 'deny', 'user-approved', 'user-denied', 'blocked-by-rule')),
      duration_ms INTEGER DEFAULT 0,
      conversation_id INTEGER REFERENCES conversations(id)
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      type TEXT NOT NULL,
      data TEXT,
      source TEXT DEFAULT 'system'
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_timestamp ON conversations(timestamp);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_timestamp ON tool_calls(timestamp);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(tool_name);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);

    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      session_type TEXT DEFAULT 'chat',
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      model TEXT DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_token_usage_timestamp ON token_usage(timestamp);

    -- Undo log: every destructive operation (file delete, email archive,
    -- file overwrite, etc.) records a row here BEFORE executing, so the
    -- reversal steps are durable even if the process crashes mid-op.
    CREATE TABLE IF NOT EXISTS undo_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      op_type TEXT NOT NULL,            -- e.g. 'file.delete', 'gmail.archive', 'file.edit'
      target TEXT NOT NULL,             -- human-readable identifier (path, thread id, etc.)
      reversible INTEGER NOT NULL DEFAULT 1,
      reversal_steps TEXT,              -- JSON: how to undo it (e.g. trash path, prior labels)
      reversed_at TEXT,                 -- set when undo is performed
      agent_reason TEXT                 -- why the agent decided to do this
    );
    CREATE INDEX IF NOT EXISTS idx_undo_log_timestamp ON undo_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_undo_log_reversible ON undo_log(reversible, reversed_at);
  `)
}

// ============ conversations ============

export function logConversation(
  role: 'user' | 'assistant' | 'system',
  content: string,
  sessionType = 'chat',
): number {
  const stmt = getDb().prepare(
    'INSERT INTO conversations (role, content, session_type) VALUES (?, ?, ?)',
  )
  const result = stmt.run(role, content.slice(0, 50_000), sessionType)
  return Number(result.lastInsertRowid)
}

export function getRecentConversations(
  limit = 20,
): Array<{ id: number; timestamp: string; role: string; content: string }> {
  return getDb()
    .prepare(
      'SELECT id, timestamp, role, content FROM conversations ORDER BY id DESC LIMIT ?',
    )
    .all(limit) as Array<{ id: number; timestamp: string; role: string; content: string }>
}

export function getRecentConversationsBySession(
  sessionType: string,
  limit = 20,
): Array<{ id: number; timestamp: string; role: string; content: string }> {
  const rows = getDb()
    .prepare(
      'SELECT id, timestamp, role, content FROM conversations WHERE session_type = ? ORDER BY id DESC LIMIT ?',
    )
    .all(sessionType, limit) as Array<{
    id: number
    timestamp: string
    role: string
    content: string
  }>
  return rows.reverse()
}

export function searchConversations(
  query: string,
  limit = 20,
): Array<{ id: number; timestamp: string; role: string; content: string }> {
  return getDb()
    .prepare(
      "SELECT id, timestamp, role, content FROM conversations WHERE content LIKE ? ORDER BY id DESC LIMIT ?",
    )
    .all(`%${query}%`, limit) as Array<{ id: number; timestamp: string; role: string; content: string }>
}

// ============ tool calls ============

export function logToolCall(params: {
  toolName: string
  input: unknown
  output?: string
  decision: string
  durationMs?: number
  conversationId?: number
}): number {
  const stmt = getDb().prepare(
    'INSERT INTO tool_calls (tool_name, input, output, decision, duration_ms, conversation_id) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const result = stmt.run(
    params.toolName,
    JSON.stringify(params.input).slice(0, 10_000),
    (params.output ?? '').slice(0, 10_000),
    params.decision,
    params.durationMs ?? 0,
    params.conversationId ?? null,
  )
  return Number(result.lastInsertRowid)
}

export function getToolCallStats(
  days = 7,
): Array<{ tool_name: string; count: number; avg_duration_ms: number }> {
  return getDb()
    .prepare(
      `SELECT tool_name, COUNT(*) as count, ROUND(AVG(duration_ms)) as avg_duration_ms
       FROM tool_calls
       WHERE timestamp >= datetime('now', '-' || ? || ' days')
       GROUP BY tool_name
       ORDER BY count DESC`,
    )
    .all(days) as Array<{ tool_name: string; count: number; avg_duration_ms: number }>
}

export function getRecentToolCalls(
  limit = 20,
): Array<{ id: number; timestamp: string; tool_name: string; input: string; decision: string }> {
  return getDb()
    .prepare(
      'SELECT id, timestamp, tool_name, input, decision FROM tool_calls ORDER BY id DESC LIMIT ?',
    )
    .all(limit) as Array<{ id: number; timestamp: string; tool_name: string; input: string; decision: string }>
}

// ============ events ============

export function logEvent(type: string, data?: unknown, source = 'system'): void {
  getDb()
    .prepare('INSERT INTO events (type, data, source) VALUES (?, ?, ?)')
    .run(type, data ? JSON.stringify(data).slice(0, 10_000) : null, source)
}

export function getRecentEvents(
  type?: string,
  limit = 50,
): Array<{ id: number; timestamp: string; type: string; data: string; source: string }> {
  if (type) {
    return getDb()
      .prepare(
        'SELECT id, timestamp, type, data, source FROM events WHERE type = ? ORDER BY id DESC LIMIT ?',
      )
      .all(type, limit) as Array<{ id: number; timestamp: string; type: string; data: string; source: string }>
  }
  return getDb()
    .prepare(
      'SELECT id, timestamp, type, data, source FROM events ORDER BY id DESC LIMIT ?',
    )
    .all(limit) as Array<{ id: number; timestamp: string; type: string; data: string; source: string }>
}

// ============ undo log ============

export interface UndoEntry {
  id: number
  timestamp: string
  op_type: string
  target: string
  reversible: number
  reversal_steps: string | null
  reversed_at: string | null
  agent_reason: string | null
}

export function logUndoOp(params: {
  opType: string
  target: string
  reversible: boolean
  reversalSteps?: unknown
  agentReason?: string
}): number {
  const stmt = getDb().prepare(
    'INSERT INTO undo_log (op_type, target, reversible, reversal_steps, agent_reason) VALUES (?, ?, ?, ?, ?)',
  )
  const result = stmt.run(
    params.opType,
    params.target,
    params.reversible ? 1 : 0,
    params.reversalSteps ? JSON.stringify(params.reversalSteps) : null,
    params.agentReason ?? null,
  )
  return Number(result.lastInsertRowid)
}

export function markUndone(id: number): void {
  getDb()
    .prepare("UPDATE undo_log SET reversed_at = datetime('now') WHERE id = ?")
    .run(id)
}

export function listRecentUndoOps(limit = 50): UndoEntry[] {
  return getDb()
    .prepare('SELECT * FROM undo_log ORDER BY id DESC LIMIT ?')
    .all(limit) as UndoEntry[]
}

export function getUndoOp(id: number): UndoEntry | null {
  return (getDb().prepare('SELECT * FROM undo_log WHERE id = ?').get(id) as UndoEntry) ?? null
}

// ============ token usage ============

export function logTokenUsage(params: {
  sessionType?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  costUsd: number
  durationMs?: number
  model?: string
}): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO token_usage
         (session_type, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, duration_ms, model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.sessionType ?? 'chat',
        params.inputTokens,
        params.outputTokens,
        params.cacheReadTokens ?? 0,
        params.cacheCreationTokens ?? 0,
        params.costUsd,
        params.durationMs ?? 0,
        params.model ?? '',
      )
  } catch {
    // ignore
  }
}

export interface TokenStats {
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCostUsd: number
  totalCalls: number
  todayCostUsd: number
  todayCalls: number
  last7dCostUsd: number
  last7dCalls: number
  byModel: Array<{ model: string; calls: number; costUsd: number; inputTokens: number; outputTokens: number }>
  bySessionType: Array<{ sessionType: string; calls: number; costUsd: number }>
}

export function getTokenStats(): TokenStats {
  const db = getDb()

  const totals = db.prepare(
    `SELECT
       COALESCE(SUM(input_tokens), 0) as totalInputTokens,
       COALESCE(SUM(output_tokens), 0) as totalOutputTokens,
       COALESCE(SUM(cache_read_tokens), 0) as totalCacheReadTokens,
       COALESCE(SUM(cost_usd), 0) as totalCostUsd,
       COUNT(*) as totalCalls
     FROM token_usage`,
  ).get() as any

  const today = db.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) as costUsd, COUNT(*) as calls
     FROM token_usage WHERE timestamp >= date('now')`,
  ).get() as any

  const last7d = db.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) as costUsd, COUNT(*) as calls
     FROM token_usage WHERE timestamp >= date('now', '-7 days')`,
  ).get() as any

  const byModel = db.prepare(
    `SELECT model, COUNT(*) as calls,
       COALESCE(SUM(cost_usd), 0) as costUsd,
       COALESCE(SUM(input_tokens), 0) as inputTokens,
       COALESCE(SUM(output_tokens), 0) as outputTokens
     FROM token_usage WHERE model != '' GROUP BY model ORDER BY costUsd DESC`,
  ).all() as any[]

  const bySessionType = db.prepare(
    `SELECT session_type as sessionType, COUNT(*) as calls, COALESCE(SUM(cost_usd), 0) as costUsd
     FROM token_usage GROUP BY session_type ORDER BY costUsd DESC`,
  ).all() as any[]

  return {
    ...totals,
    todayCostUsd: today.costUsd,
    todayCalls: today.calls,
    last7dCostUsd: last7d.costUsd,
    last7dCalls: last7d.calls,
    byModel,
    bySessionType,
  }
}

// ============ stats ============

export function getStats(): {
  totalConversations: number
  totalToolCalls: number
  totalEvents: number
  dbSizeBytes: number
} {
  const convCount = getDb().prepare('SELECT COUNT(*) as n FROM conversations').get() as { n: number }
  const toolCount = getDb().prepare('SELECT COUNT(*) as n FROM tool_calls').get() as { n: number }
  const eventCount = getDb().prepare('SELECT COUNT(*) as n FROM events').get() as { n: number }
  let dbSize = 0
  try {
    dbSize = fs.statSync(DB_PATH).size
  } catch {
    // ignore
  }
  return {
    totalConversations: convCount.n,
    totalToolCalls: toolCount.n,
    totalEvents: eventCount.n,
    dbSizeBytes: dbSize,
  }
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
