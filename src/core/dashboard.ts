/**
 * Observability dashboard — renders Dot's recent activity as a self-contained
 * HTML file at ~/.nina/dashboard.html.
 *
 * Pulls from SQLite (events, conversations, tool_calls, token_usage) and
 * in-memory state (cron, missions, bg-queue, telegram). Everything is
 * read-only: the dashboard never mutates state.
 *
 * Exposed via the MCP tool `dot_timeline`, which regenerates the file and
 * optionally opens it in the default browser.
 */
import fs from 'node:fs'
import path from 'node:path'
import { NINA_DIR } from './memory.js'
import { getDb, getTokenStats } from './db.js'
import { listTasks as listCronTasks } from './cron.js'
import { listMissions } from './missions.js'
import { bgQueueDepth, bgCurrent } from './bg-queue.js'
import { telegramStatus } from './telegram.js'
import { loadConfig } from './config.js'
import { listRecentOps, getTrashStats } from './safe-ops.js'

const DASHBOARD_FILE = path.join(NINA_DIR, 'dashboard.html')

interface RecentRow {
  timestamp: string
  type: string
  source: string
  data: string
}

interface ConvRow {
  timestamp: string
  role: string
  content: string
  session_type: string
}

interface ToolRow {
  timestamp: string
  tool_name: string
  input: string
  decision: string
  duration_ms: number
}

export function renderDashboard(): string {
  const db = getDb()

  const events = db
    .prepare(
      'SELECT timestamp, type, source, data FROM events ORDER BY id DESC LIMIT 200',
    )
    .all() as RecentRow[]

  const conversations = db
    .prepare(
      'SELECT timestamp, role, content, session_type FROM conversations ORDER BY id DESC LIMIT 50',
    )
    .all() as ConvRow[]

  const toolCalls = db
    .prepare(
      'SELECT timestamp, tool_name, input, decision, duration_ms FROM tool_calls ORDER BY id DESC LIMIT 100',
    )
    .all() as ToolRow[]

  const tokens = getTokenStats()
  const cronTasks = listCronTasks()
  const missions = listMissions()
  const tg = telegramStatus()
  const queue = { depth: bgQueueDepth(), current: bgCurrent() }
  const budget = loadConfig().dailyBudgetUsd
  const budgetPct =
    budget > 0 ? Math.min(100, Math.round((tokens.todayCostUsd / budget) * 100)) : 0
  const recentOps = listRecentOps(20)
  const trash = getTrashStats()

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Dot · timeline</title>
<style>
  :root {
    --bg: #0f1115;
    --panel: #161a22;
    --border: #262b36;
    --text: #e6e8ec;
    --muted: #8b93a7;
    --accent: #7aa2f7;
    --ok: #9ece6a;
    --warn: #e0af68;
    --err: #f7768e;
    --mono: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    background: var(--bg);
    color: var(--text);
    font: 13px/1.5 -apple-system, system-ui, sans-serif;
    margin: 0;
    padding: 24px 32px;
  }
  h1 { font-size: 18px; margin: 0 0 4px; font-weight: 600; }
  h2 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    margin: 24px 0 8px;
    font-weight: 600;
  }
  .subtitle { color: var(--muted); font-size: 12px; margin-bottom: 24px; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 12px;
    margin-bottom: 8px;
  }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px 14px;
  }
  .card .label {
    font-size: 11px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 4px;
  }
  .card .value {
    font: 600 20px/1.2 var(--mono);
    color: var(--text);
  }
  .card .hint { font-size: 11px; color: var(--muted); margin-top: 4px; }
  table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--mono);
    font-size: 12px;
  }
  th, td {
    text-align: left;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  th {
    color: var(--muted);
    font-weight: 500;
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.06em;
  }
  tr:hover td { background: #1c2130; }
  .role-user { color: var(--accent); }
  .role-assistant { color: var(--ok); }
  .role-system { color: var(--muted); }
  .decision-auto { color: var(--muted); }
  .decision-user-approved, .decision-auto-approved { color: var(--ok); }
  .decision-deny, .decision-blocked-by-rule { color: var(--err); }
  .ts { color: var(--muted); white-space: nowrap; }
  .truncate {
    max-width: 560px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .wrap { white-space: pre-wrap; word-break: break-word; }
  details { margin-bottom: 16px; }
  details summary {
    cursor: pointer;
    color: var(--muted);
    font-size: 12px;
    user-select: none;
  }
  details[open] summary { color: var(--accent); }
  .pill {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 10px;
    background: #262b36;
    color: var(--muted);
    margin-right: 6px;
  }
  .pill.ok { background: #1e3a27; color: var(--ok); }
  .pill.off { background: #3a1e1e; color: var(--err); }
  footer {
    margin-top: 32px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: 11px;
    font-family: var(--mono);
  }
</style>
</head>
<body>
  <h1>Dot · timeline</h1>
  <div class="subtitle">generated ${new Date().toISOString()} · read-only snapshot · refresh via <code>dot_timeline</code></div>

  <div class="grid">
    <div class="card">
      <div class="label">today cost</div>
      <div class="value">$${tokens.todayCostUsd.toFixed(4)}</div>
      <div class="hint">${tokens.todayCalls} calls${budget > 0 ? ` · ${budgetPct}% of $${budget.toFixed(2)} cap` : ''}</div>
    </div>
    <div class="card">
      <div class="label">7-day cost</div>
      <div class="value">$${tokens.last7dCostUsd.toFixed(4)}</div>
      <div class="hint">${tokens.last7dCalls} calls</div>
    </div>
    <div class="card">
      <div class="label">lifetime</div>
      <div class="value">$${tokens.totalCostUsd.toFixed(2)}</div>
      <div class="hint">${(tokens.totalInputTokens + tokens.totalOutputTokens).toLocaleString()} tokens</div>
    </div>
    <div class="card">
      <div class="label">bg queue</div>
      <div class="value">${queue.depth}</div>
      <div class="hint">${escapeHtml(queue.current ?? '(idle)')}</div>
    </div>
    <div class="card">
      <div class="label">telegram</div>
      <div class="value"><span class="pill ${tg.running ? 'ok' : 'off'}">${tg.running ? 'on' : 'off'}</span>${tg.username ? '@' + escapeHtml(tg.username) : ''}</div>
      <div class="hint">${tg.allowlistSize} chats allowlisted</div>
    </div>
    <div class="card">
      <div class="label">cron tasks</div>
      <div class="value">${cronTasks.filter((t) => t.enabled).length}/${cronTasks.length}</div>
      <div class="hint">enabled / total</div>
    </div>
    <div class="card">
      <div class="label">missions</div>
      <div class="value">${missions.filter((m) => m.status === 'active').length}</div>
      <div class="hint">${missions.length} total</div>
    </div>
    <div class="card">
      <div class="label">trash</div>
      <div class="value">${trash.slots}</div>
      <div class="hint">${(trash.totalBytes / 1024 / 1024).toFixed(1)} MB · ${recentOps.filter((o) => !o.reversed_at && o.reversible).length} reversible</div>
    </div>
  </div>

  <h2>Cost by model</h2>
  <table>
    <thead><tr><th>model</th><th>calls</th><th>input</th><th>output</th><th>cost</th></tr></thead>
    <tbody>
      ${
        tokens.byModel.length === 0
          ? '<tr><td colspan="5" class="ts">no model usage yet</td></tr>'
          : tokens.byModel
              .map(
                (m) => `
        <tr>
          <td>${escapeHtml(m.model)}</td>
          <td>${m.calls}</td>
          <td>${m.inputTokens.toLocaleString()}</td>
          <td>${m.outputTokens.toLocaleString()}</td>
          <td>$${m.costUsd.toFixed(4)}</td>
        </tr>`,
              )
              .join('')
      }
    </tbody>
  </table>

  <h2>Cron tasks</h2>
  <table>
    <thead><tr><th>id</th><th>name</th><th>schedule</th><th>last run</th><th>status</th><th>runs</th></tr></thead>
    <tbody>
      ${
        cronTasks.length === 0
          ? '<tr><td colspan="6" class="ts">no scheduled tasks</td></tr>'
          : cronTasks
              .map(
                (t) => `
        <tr>
          <td class="ts">${escapeHtml(t.id)}</td>
          <td>${escapeHtml(t.name)} ${t.enabled ? '' : '<span class="pill off">off</span>'}</td>
          <td>${escapeHtml(t.cron)}</td>
          <td class="ts">${t.lastRunAt ? escapeHtml(t.lastRunAt.slice(0, 16)) : 'never'}</td>
          <td class="${t.lastStatus === 'ok' ? 'decision-auto-approved' : t.lastStatus === 'error' ? 'decision-deny' : ''}">${t.lastStatus ?? '—'}</td>
          <td>${t.runCount}</td>
        </tr>`,
              )
              .join('')
      }
    </tbody>
  </table>

  <h2>Recent destructive ops (reversible)</h2>
  <table>
    <thead><tr><th>id</th><th>time</th><th>op</th><th>target</th><th>state</th><th>reason</th></tr></thead>
    <tbody>
      ${
        recentOps.length === 0
          ? '<tr><td colspan="6" class="ts">no destructive ops recorded</td></tr>'
          : recentOps
              .map((o) => {
                const state = o.reversed_at
                  ? `<span class="pill">reversed</span>`
                  : o.reversible
                    ? `<span class="pill ok">reversible</span>`
                    : `<span class="pill off">permanent</span>`
                return `
        <tr>
          <td class="ts">${o.id}</td>
          <td class="ts">${escapeHtml(o.timestamp.slice(0, 16))}</td>
          <td>${escapeHtml(o.op_type)}</td>
          <td class="truncate">${escapeHtml(o.target)}</td>
          <td>${state}</td>
          <td class="truncate">${escapeHtml(o.agent_reason ?? '')}</td>
        </tr>`
              })
              .join('')
      }
    </tbody>
  </table>

  <h2>Recent events (last 200)</h2>
  <table>
    <thead><tr><th>time</th><th>type</th><th>source</th><th>data</th></tr></thead>
    <tbody>
      ${events
        .map(
          (e) => `
        <tr>
          <td class="ts">${escapeHtml(e.timestamp)}</td>
          <td>${escapeHtml(e.type)}</td>
          <td class="ts">${escapeHtml(e.source)}</td>
          <td class="truncate">${escapeHtml(e.data ?? '')}</td>
        </tr>`,
        )
        .join('')}
    </tbody>
  </table>

  <h2>Recent conversations (last 50)</h2>
  <table>
    <thead><tr><th>time</th><th>session</th><th>role</th><th>content</th></tr></thead>
    <tbody>
      ${conversations
        .map(
          (c) => `
        <tr>
          <td class="ts">${escapeHtml(c.timestamp)}</td>
          <td class="ts">${escapeHtml(c.session_type ?? '')}</td>
          <td class="role-${escapeHtml(c.role)}">${escapeHtml(c.role)}</td>
          <td class="truncate">${escapeHtml((c.content ?? '').slice(0, 400))}</td>
        </tr>`,
        )
        .join('')}
    </tbody>
  </table>

  <h2>Recent tool calls (last 100)</h2>
  <table>
    <thead><tr><th>time</th><th>tool</th><th>decision</th><th>ms</th><th>input</th></tr></thead>
    <tbody>
      ${toolCalls
        .map(
          (t) => `
        <tr>
          <td class="ts">${escapeHtml(t.timestamp)}</td>
          <td>${escapeHtml(t.tool_name)}</td>
          <td class="decision-${escapeHtml(t.decision)}">${escapeHtml(t.decision)}</td>
          <td>${t.duration_ms}</td>
          <td class="truncate">${escapeHtml((t.input ?? '').slice(0, 300))}</td>
        </tr>`,
        )
        .join('')}
    </tbody>
  </table>

  <footer>
    Dot observability dashboard · ${events.length} events · ${conversations.length} conversations · ${toolCalls.length} tool calls
  </footer>
</body>
</html>`

  fs.mkdirSync(path.dirname(DASHBOARD_FILE), { recursive: true })
  fs.writeFileSync(DASHBOARD_FILE, html, 'utf8')
  return DASHBOARD_FILE
}

function escapeHtml(s: string): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function getDashboardPath(): string {
  return DASHBOARD_FILE
}

/**
 * Return a compact text summary of Dot's recent state — designed to fit
 * inside a chat message so the agent itself can inspect its own activity.
 */
export function renderTextTimeline(opts: { events?: number } = {}): string {
  const eventLimit = opts.events ?? 40
  const db = getDb()
  const events = db
    .prepare(
      'SELECT timestamp, type, data FROM events ORDER BY id DESC LIMIT ?',
    )
    .all(eventLimit) as Array<{ timestamp: string; type: string; data: string }>
  const tokens = getTokenStats()
  const tg = telegramStatus()
  const queue = { depth: bgQueueDepth(), current: bgCurrent() }
  const cronTasks = listCronTasks()
  const missionsList = listMissions()

  const lines: string[] = []
  lines.push(`=== Dot timeline (${new Date().toISOString()}) ===`)
  lines.push('')
  lines.push(`cost today: $${tokens.todayCostUsd.toFixed(4)} (${tokens.todayCalls} calls)`)
  lines.push(`cost 7d:    $${tokens.last7dCostUsd.toFixed(4)} (${tokens.last7dCalls} calls)`)
  lines.push(`bg queue:   depth ${queue.depth}, current: ${queue.current ?? '(idle)'}`)
  lines.push(
    `telegram:   ${tg.running ? 'on' : 'off'}${tg.username ? ' @' + tg.username : ''} (${tg.allowlistSize} allowlisted)`,
  )
  lines.push(
    `cron:       ${cronTasks.filter((t) => t.enabled).length}/${cronTasks.length} enabled`,
  )
  lines.push(
    `missions:   ${missionsList.filter((m) => m.status === 'active').length} active / ${missionsList.length} total`,
  )
  lines.push('')
  lines.push(`--- last ${events.length} events ---`)
  for (const e of events) {
    const data = e.data ? ` ${e.data.slice(0, 160)}` : ''
    lines.push(`${e.timestamp.slice(11, 19)}  ${e.type}${data}`)
  }
  return lines.join('\n')
}
