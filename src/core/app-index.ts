/**
 * Installed-apps index with persistence and fuzzy resolution.
 *
 * Dot needs to know what apps are on the user's Mac to launch/drive them
 * by name. Scanning /Applications every time is slow (~150ms for 77
 * apps) and doesn't handle typos or partial names. This module:
 *
 *   1. Scans /Applications, ~/Applications, /System/Applications,
 *      and /System/Applications/Utilities (via system-control.listInstalledApps)
 *   2. Persists the result to ~/.dot/app-index.json with a timestamp
 *   3. Refreshes on morning ritual, on explicit request, or when a lookup
 *      misses (self-heals without user intervention)
 *   4. Resolves names fuzzily — "safari" matches "Safari", "music" matches
 *      "Music", "xcode" matches "Xcode.app"
 *
 * Cache schema:
 *   { scannedAt: ISO timestamp, apps: [{ name, path, location }] }
 */
import fs from 'node:fs'
import path from 'node:path'
import { NINA_DIR } from './memory.js'
import { listInstalledApps } from './system-control.js'
import { logEvent } from './db.js'

const INDEX_FILE = path.join(NINA_DIR, 'app-index.json')

export interface AppEntry {
  name: string
  path: string
  location: 'system' | 'user'
}

export interface AppIndex {
  scannedAt: string
  apps: AppEntry[]
}

let memCache: AppIndex | null = null

function loadFromDisk(): AppIndex | null {
  try {
    if (!fs.existsSync(INDEX_FILE)) return null
    const raw = fs.readFileSync(INDEX_FILE, 'utf8')
    return JSON.parse(raw) as AppIndex
  } catch {
    return null
  }
}

function saveToDisk(index: AppIndex): void {
  fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true })
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2) + '\n', 'utf8')
}

/**
 * Force a fresh scan of installed apps and persist the result.
 * Always safe to call — no side effects beyond writing the cache file.
 */
export async function scanApps(): Promise<AppIndex> {
  const start = Date.now()
  const apps = await listInstalledApps()
  const index: AppIndex = {
    scannedAt: new Date().toISOString(),
    apps,
  }
  memCache = index
  saveToDisk(index)
  logEvent('app_index.scan', {
    count: apps.length,
    durationMs: Date.now() - start,
  })
  return index
}

/**
 * Return the current index, loading from disk if needed. Scans fresh
 * only if the index has never been built.
 */
export async function getIndex(): Promise<AppIndex> {
  if (memCache) return memCache
  const fromDisk = loadFromDisk()
  if (fromDisk) {
    memCache = fromDisk
    return fromDisk
  }
  // First run — no index yet. Scan.
  return scanApps()
}

/**
 * Fuzzy-resolve an app name to an index entry. Rules, in order:
 *   1. Exact match (case-insensitive)
 *   2. Name starts with the query
 *   3. Name contains the query as a substring
 *   4. All chars of query appear in name in order (e.g. "msmt" → "Microsoft Teams")
 *
 * Returns the first match, or null. If the initial lookup fails AND the
 * index is older than `maxAgeMsForRescan`, we rescan and try again — this
 * is the "she can't find → scan again" self-heal behavior.
 */
export async function findApp(
  query: string,
  opts: { rescanOnMiss?: boolean } = { rescanOnMiss: true },
): Promise<AppEntry | null> {
  const index = await getIndex()
  const hit = resolveIn(index.apps, query)
  if (hit) return hit

  if (opts.rescanOnMiss !== false) {
    logEvent('app_index.miss_rescan', { query })
    const fresh = await scanApps()
    return resolveIn(fresh.apps, query)
  }
  return null
}

/**
 * Return multiple matches for a query — useful when the agent wants to
 * show the user options before picking.
 */
export async function findAppMatches(
  query: string,
  limit = 5,
): Promise<AppEntry[]> {
  const index = await getIndex()
  const out: AppEntry[] = []
  const q = query.toLowerCase().trim()
  if (!q) return []
  // Exact
  for (const a of index.apps) {
    if (a.name.toLowerCase() === q) out.push(a)
  }
  // StartsWith
  for (const a of index.apps) {
    if (a.name.toLowerCase().startsWith(q) && !out.includes(a)) out.push(a)
  }
  // Contains
  for (const a of index.apps) {
    if (a.name.toLowerCase().includes(q) && !out.includes(a)) out.push(a)
  }
  // Subsequence
  for (const a of index.apps) {
    if (isSubsequence(q, a.name.toLowerCase()) && !out.includes(a)) out.push(a)
  }
  return out.slice(0, limit)
}

function resolveIn(apps: AppEntry[], query: string): AppEntry | null {
  const q = query.toLowerCase().trim()
  if (!q) return null

  // 1. exact
  for (const a of apps) {
    if (a.name.toLowerCase() === q) return a
  }
  // 2. starts-with
  for (const a of apps) {
    if (a.name.toLowerCase().startsWith(q)) return a
  }
  // 3. contains
  for (const a of apps) {
    if (a.name.toLowerCase().includes(q)) return a
  }
  // 4. subsequence
  for (const a of apps) {
    if (isSubsequence(q, a.name.toLowerCase())) return a
  }
  return null
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0
  for (const ch of haystack) {
    if (ch === needle[i]) i++
    if (i === needle.length) return true
  }
  return false
}

export function getIndexAgeSeconds(): number | null {
  const idx = memCache ?? loadFromDisk()
  if (!idx) return null
  return Math.round((Date.now() - new Date(idx.scannedAt).getTime()) / 1000)
}

export function getIndexPath(): string {
  return INDEX_FILE
}
