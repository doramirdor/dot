/**
 * NadirClaw integration — reads stats from NadirClaw's SQLite log DB.
 *
 * NadirClaw is a local LLM router that saves costs by routing simple prompts
 * to cheaper models. It logs every request to ~/.nadirclaw/logs/requests.db.
 *
 * This module provides read-only access to those stats so Nina can show
 * unified token usage across both her own calls and NadirClaw-routed calls.
 */
import Database from 'better-sqlite3'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

const NADIRCLAW_DB_PATH = path.join(
  os.homedir(),
  '.nadirclaw',
  'logs',
  'requests.db',
)

export interface NadirClawStats {
  available: boolean
  totalRequests: number
  totalCostUsd: number
  totalPromptTokens: number
  totalCompletionTokens: number
  totalTokensSaved: number
  todayCostUsd: number
  todayRequests: number
  byModel: Array<{
    model: string
    requests: number
    costUsd: number
    promptTokens: number
    completionTokens: number
  }>
  byTier: Array<{
    tier: string
    requests: number
    costUsd: number
  }>
}

export function isNadirClawAvailable(): boolean {
  return fs.existsSync(NADIRCLAW_DB_PATH)
}

export function getNadirClawStats(): NadirClawStats {
  if (!isNadirClawAvailable()) {
    return {
      available: false,
      totalRequests: 0,
      totalCostUsd: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokensSaved: 0,
      todayCostUsd: 0,
      todayRequests: 0,
      byModel: [],
      byTier: [],
    }
  }

  try {
    // Open read-only — we never write to NadirClaw's DB
    const db = new Database(NADIRCLAW_DB_PATH, { readonly: true })
    db.pragma('busy_timeout = 1000')

    const totals = db
      .prepare(
        `SELECT
           COUNT(*) as totalRequests,
           COALESCE(SUM(cost), 0) as totalCostUsd,
           COALESCE(SUM(prompt_tokens), 0) as totalPromptTokens,
           COALESCE(SUM(completion_tokens), 0) as totalCompletionTokens,
           COALESCE(SUM(tokens_saved), 0) as totalTokensSaved
         FROM requests WHERE status = 'success'`,
      )
      .get() as any

    const today = db
      .prepare(
        `SELECT COALESCE(SUM(cost), 0) as costUsd, COUNT(*) as requests
         FROM requests WHERE status = 'success' AND date(timestamp) = date('now')`,
      )
      .get() as any

    const byModel = db
      .prepare(
        `SELECT selected_model as model, COUNT(*) as requests,
           COALESCE(SUM(cost), 0) as costUsd,
           COALESCE(SUM(prompt_tokens), 0) as promptTokens,
           COALESCE(SUM(completion_tokens), 0) as completionTokens
         FROM requests WHERE status = 'success' AND selected_model IS NOT NULL
         GROUP BY selected_model ORDER BY costUsd DESC LIMIT 10`,
      )
      .all() as any[]

    const byTier = db
      .prepare(
        `SELECT tier, COUNT(*) as requests, COALESCE(SUM(cost), 0) as costUsd
         FROM requests WHERE status = 'success' AND tier IS NOT NULL
         GROUP BY tier ORDER BY requests DESC`,
      )
      .all() as any[]

    db.close()

    return {
      available: true,
      ...totals,
      todayCostUsd: today.costUsd,
      todayRequests: today.requests,
      byModel,
      byTier,
    }
  } catch (err) {
    console.warn('[nadirclaw] Failed to read stats:', err)
    return {
      available: false,
      totalRequests: 0,
      totalCostUsd: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokensSaved: 0,
      todayCostUsd: 0,
      todayRequests: 0,
      byModel: [],
      byTier: [],
    }
  }
}

export function formatNadirClawStats(stats: NadirClawStats): string {
  if (!stats.available) return '(nadirclaw not found at ~/.nadirclaw/)'

  const lines = [
    '## NadirClaw Router Stats',
    `total requests: ${stats.totalRequests}`,
    `total cost: $${stats.totalCostUsd.toFixed(4)}`,
    `total tokens: ${(stats.totalPromptTokens + stats.totalCompletionTokens).toLocaleString()} (${stats.totalPromptTokens.toLocaleString()} in / ${stats.totalCompletionTokens.toLocaleString()} out)`,
    `tokens saved: ${stats.totalTokensSaved.toLocaleString()}`,
    `today: ${stats.todayRequests} requests, $${stats.todayCostUsd.toFixed(4)}`,
  ]

  if (stats.byModel.length > 0) {
    lines.push('', 'by model:')
    for (const m of stats.byModel) {
      lines.push(
        `  ${m.model}: ${m.requests} req, $${m.costUsd.toFixed(4)}, ${(m.promptTokens + m.completionTokens).toLocaleString()} tokens`,
      )
    }
  }

  if (stats.byTier.length > 0) {
    lines.push('', 'by tier:')
    for (const t of stats.byTier) {
      lines.push(`  ${t.tier}: ${t.requests} req, $${t.costUsd.toFixed(4)}`)
    }
  }

  return lines.join('\n')
}
