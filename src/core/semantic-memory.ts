/**
 * Semantic memory — vector-backed remember/recall.
 *
 * Uses sqlite-vec to add a virtual table to Nina's existing SQLite DB.
 * Embeddings come from embed.ts (Transformers.js or Ollama).
 *
 * Three memory types:
 *   - 'conversation' — raw user/assistant messages
 *   - 'fact' — extracted structured facts ("user's co-founder is Alex")
 *   - 'summary' — compressed conversation summaries
 *
 * All vectors live in the same `vec_memories` table alongside their text
 * content, making it trivial to query: "find the 5 most relevant memories
 * to this question."
 */
import { getDb } from './db.js'
import { embed, getEmbeddingDim, initEmbedder } from './embed.js'
import * as sqliteVec from 'sqlite-vec'
import crypto from 'node:crypto'

let vecInitialized = false

/**
 * Initialize the vector extension and create the virtual table.
 * Must be called after the DB is open.
 */
export async function initSemanticMemory(): Promise<void> {
  if (vecInitialized) return

  // Initialize the embedder (loads model on first call)
  await initEmbedder()
  const dim = getEmbeddingDim()

  const db = getDb()

  // Load sqlite-vec extension
  sqliteVec.load(db)

  // Create the virtual table for vector search.
  // sqlite-vec uses vec0 module. We use a shadow table for metadata
  // because vec0 virtual tables have limited column type support.
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('conversation', 'fact', 'summary', 'observation')),
      source TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      embedding BLOB,
      content_hash TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
  `)

  // Backfill content_hash column on pre-existing rows (safe if already added).
  // Must run BEFORE creating the idx_memories_hash index, since older DBs
  // created the memories table without this column.
  try {
    db.exec('ALTER TABLE memories ADD COLUMN content_hash TEXT')
  } catch {
    // column already exists
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(content_hash, type);
  `)

  // Create the vec0 virtual table for vector similarity search.
  // Using rowid as implicit PK (no explicit INTEGER PRIMARY KEY column)
  // to avoid BigInt/type issues with better-sqlite3 in Electron.
  try {
    db.exec(`
      CREATE VIRTUAL TABLE vec_memories USING vec0(
        embedding float[${dim}]
      );
    `)
  } catch {
    // Table already exists — that's fine
  }

  vecInitialized = true
  console.log(`[semantic-memory] initialized (dim=${dim})`)
}

/**
 * Store a memory with its embedding. Auto-embeds the content.
 */
export async function remember(
  content: string,
  type: 'conversation' | 'fact' | 'summary' | 'observation',
  source = '',
): Promise<number> {
  if (!vecInitialized) await initSemanticMemory()

  // Skip empty or very short content
  if (!content || content.trim().length < 10) return -1

  const db = getDb()

  // Dedup: if an entry with the same (type, content_hash) already exists
  // within the last 24 hours, skip the write. Prevents "read same email
  // 3 times today" from creating 3 vector rows, and keeps the screen
  // watcher's repeated (app, window) tuples from flooding the store.
  // A 24h window means the same fact can be re-logged tomorrow —
  // helpful for recency-biased recall without permanent exclusion.
  const hash = hashContent(type, content)
  try {
    const existing = db
      .prepare(
        `SELECT id FROM memories
         WHERE content_hash = ? AND type = ?
         AND created_at > datetime('now', '-1 day')
         LIMIT 1`,
      )
      .get(hash, type) as { id: number } | undefined
    if (existing) return existing.id
  } catch {
    // If the hash column isn't there yet for some reason, fall through
    // to the normal insert path.
  }

  const vector = await embed(content)
  const vectorBlob = Buffer.from(vector.buffer)

  // Insert into metadata table
  const result = db
    .prepare(
      'INSERT INTO memories (content, type, source, embedding, content_hash) VALUES (?, ?, ?, ?, ?)',
    )
    .run(content.slice(0, 10_000), type, source, vectorBlob, hash)

  // lastInsertRowid is BigInt in better-sqlite3 — vec0 needs a plain integer
  const memoryId = Number(result.lastInsertRowid)

  // Insert into vector index (implicit rowid — no PK column needed)
  try {
    db.prepare('INSERT INTO vec_memories (rowid, embedding) VALUES (?, ?)').run(
      memoryId,
      vectorBlob,
    )
  } catch (err) {
    // If rowid approach fails too, try without specifying rowid at all
    try {
      db.prepare('INSERT INTO vec_memories (embedding) VALUES (?)').run(vectorBlob)
    } catch (err2) {
      console.warn('[semantic-memory] vec insert failed:', err2)
    }
  }

  return memoryId
}

/**
 * Stable hash of the content used for dedup. Case-insensitive, whitespace-
 * normalized, first 200 chars — enough to catch "read email X" vs "read
 * email X again" while still letting meaningful edits create new rows.
 */
function hashContent(type: string, content: string): string {
  const normalized = content
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  return crypto.createHash('sha1').update(`${type}::${normalized}`).digest('hex').slice(0, 16)
}

export interface MemoryMatch {
  id: number
  content: string
  type: string
  source: string
  createdAt: string
  distance: number
}

export interface RecallFilters {
  /** Filter by memory type. */
  type?: string
  /** ISO timestamp — only return memories created at or after this. */
  since?: string
  /** ISO timestamp — only return memories created at or before this. */
  until?: string
}

/**
 * Recall the most relevant memories for a query.
 * Returns memories sorted by relevance (closest first).
 *
 * When `since` / `until` are provided, we overfetch from the vector
 * index and filter by created_at — cheap for small N, and avoids a
 * complex index-join with vec0.
 */
export async function recall(
  query: string,
  limit = 5,
  typeOrFilters?: string | RecallFilters,
): Promise<MemoryMatch[]> {
  if (!vecInitialized) await initSemanticMemory()

  const filters: RecallFilters =
    typeof typeOrFilters === 'string'
      ? { type: typeOrFilters }
      : (typeOrFilters ?? {})
  const hasTimeRange = Boolean(filters.since || filters.until)

  const db = getDb()
  const queryVector = await embed(query)
  const queryBlob = Buffer.from(queryVector.buffer)

  // Overfetch generously when time-filtering, so the post-filter set
  // still has enough candidates. 5x is a safe default.
  const overfetch = hasTimeRange ? limit * 5 : limit * 2

  // Query the vector index for nearest neighbors
  let rows: Array<{ rowid: number; distance: number }>
  try {
    rows = db
      .prepare(
        `SELECT rowid, distance
         FROM vec_memories
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT ?`,
      )
      .all(queryBlob, overfetch) as Array<{ rowid: number; distance: number }>
  } catch (err) {
    console.warn('[semantic-memory] vec search failed:', err)
    return []
  }

  if (rows.length === 0) return []

  // Fetch full metadata for matched memories
  const ids = rows.map((r) => Number(r.rowid))
  const distanceMap = new Map(rows.map((r) => [Number(r.rowid), r.distance]))

  const placeholders = ids.map(() => '?').join(',')
  const memories = db
    .prepare(
      `SELECT id, content, type, source, created_at as createdAt
       FROM memories
       WHERE id IN (${placeholders})`,
    )
    .all(...ids) as Array<{
    id: number
    content: string
    type: string
    source: string
    createdAt: string
  }>

  // Filter by type and time range
  let filtered = memories
  if (filters.type) {
    filtered = filtered.filter((m) => m.type === filters.type)
  }
  if (filters.since) {
    const sinceMs = Date.parse(filters.since)
    if (!Number.isNaN(sinceMs)) {
      filtered = filtered.filter((m) => Date.parse(m.createdAt) >= sinceMs)
    }
  }
  if (filters.until) {
    const untilMs = Date.parse(filters.until)
    if (!Number.isNaN(untilMs)) {
      filtered = filtered.filter((m) => Date.parse(m.createdAt) <= untilMs)
    }
  }

  // Sort by distance and limit
  return filtered
    .map((m) => ({
      ...m,
      distance: distanceMap.get(m.id) ?? 999,
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
}

/**
 * Extract facts from a conversation and store them.
 * Called periodically (e.g., every N turns) or after significant exchanges.
 *
 * This is a SYNCHRONOUS store — the actual extraction from the conversation
 * happens in the agent (Claude extracts facts as part of the reflection or
 * onboarding prompts). This function just stores pre-extracted facts.
 */
export async function rememberFact(fact: string, source = ''): Promise<number> {
  return remember(fact, 'fact', source)
}

/**
 * Store a conversation turn for semantic recall.
 */
export async function rememberConversation(
  role: 'user' | 'assistant',
  content: string,
): Promise<number> {
  return remember(`[${role}] ${content}`, 'conversation', role)
}

/**
 * Format recall results as context for the system prompt.
 */
export function formatRecallResults(results: MemoryMatch[]): string {
  if (results.length === 0) return ''
  const lines = results.map((r) => {
    const age = timeSince(new Date(r.createdAt))
    return `- [${r.type}, ${age}] ${r.content.slice(0, 200)}`
  })
  return `\n# Relevant memories (semantic recall)\n\n${lines.join('\n')}\n`
}

function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  const days = Math.floor(seconds / 86400)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  return `${Math.floor(days / 30)}mo ago`
}

/**
 * Get memory stats.
 */
export function getMemoryStats(): {
  total: number
  conversations: number
  facts: number
  summaries: number
  observations: number
} {
  const db = getDb()
  const total = (
    db.prepare('SELECT COUNT(*) as n FROM memories').get() as { n: number }
  ).n
  const byType = db
    .prepare(
      'SELECT type, COUNT(*) as n FROM memories GROUP BY type',
    )
    .all() as Array<{ type: string; n: number }>

  const counts: Record<string, number> = {}
  for (const row of byType) counts[row.type] = row.n

  return {
    total,
    conversations: counts['conversation'] ?? 0,
    facts: counts['fact'] ?? 0,
    summaries: counts['summary'] ?? 0,
    observations: counts['observation'] ?? 0,
  }
}
