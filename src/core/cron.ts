/**
 * Recurring scheduled tasks for Dot.
 *
 * A lightweight cron for agent prompts. Each task is a stored record with a
 * 5-field cron expression and a prompt; the supervisor ticks once per minute
 * and fires any task whose expression matches the current minute.
 *
 * State lives at ~/.nina/cron.json (single file, small, human-editable).
 * Fires run through runAgent so tasks have full tool access, same as missions.
 *
 * Cron expression: "min hour dom month dow"
 *   - "*" wildcard
 *   - "*\/N" step
 *   - "a,b,c" list
 *   - "a-b" range
 * Evaluated in local time.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { NINA_DIR } from './memory.js'
import { enqueue as bgEnqueue } from './bg-queue.js'
import { logEvent } from './db.js'

const CRON_FILE = path.join(NINA_DIR, 'cron.json')

export interface CronTask {
  id: string
  name: string
  cron: string
  prompt: string
  enabled: boolean
  createdAt: string
  lastRunAt: string | null
  lastStatus: 'ok' | 'error' | null
  lastSummary: string | null
  runCount: number
  /**
   * Per-task "last minute we fired this" marker, stored as the local
   * "YYYY-MM-DD HH:mm" string so it's unambiguous across midnight
   * boundaries and process restarts. If set and equal to the current
   * minute, the supervisor will skip re-firing — dedup is idempotent.
   */
  lastRunMinute?: string
}

interface CronFile {
  tasks: CronTask[]
}

function loadFile(): CronFile {
  try {
    if (!fs.existsSync(CRON_FILE)) return { tasks: [] }
    return JSON.parse(fs.readFileSync(CRON_FILE, 'utf8')) as CronFile
  } catch {
    return { tasks: [] }
  }
}

function saveFile(data: CronFile): void {
  fs.mkdirSync(path.dirname(CRON_FILE), { recursive: true })
  // Atomic write: write to a sibling temp file, then rename over the
  // target. Prevents torn reads if two writers race or if the process
  // dies mid-write. rename() on POSIX is atomic within one filesystem.
  const tmp = `${CRON_FILE}.tmp.${randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, CRON_FILE)
}

export function listTasks(): CronTask[] {
  return loadFile().tasks
}

export function getTask(id: string): CronTask | null {
  return loadFile().tasks.find((t) => t.id === id) ?? null
}

export function createTask(params: {
  name: string
  cron: string
  prompt: string
}): CronTask {
  validateCron(params.cron)
  const data = loadFile()
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const task: CronTask = {
    id,
    name: params.name,
    cron: params.cron,
    prompt: params.prompt,
    enabled: true,
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    lastStatus: null,
    lastSummary: null,
    runCount: 0,
  }
  data.tasks.push(task)
  saveFile(data)
  logEvent('cron.created', { id, name: task.name, cron: task.cron })
  return task
}

export function updateTask(
  id: string,
  patch: Partial<Pick<CronTask, 'name' | 'cron' | 'prompt' | 'enabled'>>,
): CronTask | null {
  if (patch.cron) validateCron(patch.cron)
  const data = loadFile()
  const t = data.tasks.find((x) => x.id === id)
  if (!t) return null
  Object.assign(t, patch)
  saveFile(data)
  return t
}

export function deleteTask(id: string): boolean {
  const data = loadFile()
  const before = data.tasks.length
  data.tasks = data.tasks.filter((t) => t.id !== id)
  if (data.tasks.length === before) return false
  saveFile(data)
  logEvent('cron.deleted', { id })
  return true
}

// ========== cron expression matching ==========

function validateCron(expr: string): void {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`Cron expression must have 5 fields, got ${parts.length}: "${expr}"`)
  }
  const ranges = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ] as const
  for (let i = 0; i < 5; i++) {
    try {
      parseField(parts[i], ranges[i][0], ranges[i][1])
    } catch (err) {
      throw new Error(`Invalid cron field ${i} ("${parts[i]}"): ${(err as Error).message}`)
    }
  }
}

function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>()
  for (const chunk of field.split(',')) {
    let step = 1
    let rangePart = chunk
    if (chunk.includes('/')) {
      const [r, s] = chunk.split('/')
      rangePart = r
      step = Number(s)
      if (!Number.isFinite(step) || step <= 0) {
        throw new Error(`Bad step "${s}"`)
      }
    }
    let lo = min
    let hi = max
    if (rangePart === '*' || rangePart === '') {
      // full range
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map(Number)
      if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`Bad range "${rangePart}"`)
      lo = a
      hi = b
    } else {
      const n = Number(rangePart)
      if (!Number.isFinite(n)) throw new Error(`Bad number "${rangePart}"`)
      lo = n
      hi = n
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`Range ${lo}-${hi} outside [${min},${max}]`)
    }
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

function matches(expr: string, d: Date): boolean {
  const parts = expr.trim().split(/\s+/)
  const fields = [
    parseField(parts[0], 0, 59),
    parseField(parts[1], 0, 23),
    parseField(parts[2], 1, 31),
    parseField(parts[3], 1, 12),
    parseField(parts[4], 0, 6),
  ]
  return (
    fields[0].has(d.getMinutes()) &&
    fields[1].has(d.getHours()) &&
    fields[2].has(d.getDate()) &&
    fields[3].has(d.getMonth() + 1) &&
    fields[4].has(d.getDay())
  )
}

// ========== supervisor ==========

let tickTimer: NodeJS.Timeout | null = null

/**
 * Format a Date as "YYYY-MM-DD HH:mm" in local time — the canonical
 * minute key for cron de-duplication. Stable across midnight boundaries
 * and unambiguous across process restarts (unlike "hours*60+minutes"
 * which resets at 00:00 and can re-fire a just-fired task).
 */
function minuteKey(d: Date): string {
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`
}

export function startCronSupervisor(
  onRun?: (task: CronTask, status: 'ok' | 'error', summary: string) => void,
): void {
  if (tickTimer) return
  const tick = async () => {
    const now = new Date()
    const key = minuteKey(now)
    const data = loadFile()
    for (const task of data.tasks) {
      if (!task.enabled) continue
      // Per-task dedup: if we already ran this task in this calendar
      // minute, skip it. Persisted, so this survives restarts and
      // correctly handles the midnight boundary.
      if (task.lastRunMinute === key) continue
      try {
        if (!matches(task.cron, now)) continue
      } catch {
        continue
      }
      // Optimistically stamp the minute BEFORE firing so a second
      // tick that lands inside the same minute can't double-fire.
      // runTaskNow will also update lastRunAt / lastStatus on exit.
      task.lastRunMinute = key
      saveFile(data)
      await runTaskNow(task.id, onRun)
    }
  }
  // Fire every 20s so we catch the minute boundary even with drift
  tickTimer = setInterval(() => {
    void tick()
  }, 20_000)
  void tick()
}

export function stopCronSupervisor(): void {
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = null
}

export async function runTaskNow(
  id: string,
  onRun?: (task: CronTask, status: 'ok' | 'error', summary: string) => void,
): Promise<{ status: 'ok' | 'error'; summary: string }> {
  const data = loadFile()
  const task = data.tasks.find((t) => t.id === id)
  if (!task) return { status: 'error', summary: 'task not found' }

  logEvent('cron.fire', { id: task.id, name: task.name })

  // Intercept: named tasks that correspond to hardcoded flows run those
  // flows directly instead of dispatching the prompt through the agent.
  // The Morning Loop is the first of these — it has a JS-side drafting +
  // approval flow that the agent alone can't drive.
  if (task.name === 'morning-loop') {
    try {
      const { runMorningLoop } = await import('./morning-loop.js')
      const r = await runMorningLoop()
      const summary =
        r.status === 'ok'
          ? `drafted ${r.draftCount}, sent ${r.sentCount}, skipped ${r.skippedCount}`
          : r.status === 'skipped'
            ? `skipped: ${r.error ?? 'unknown reason'}`
            : `error: ${r.error ?? 'unknown'}`
      const result: { status: 'ok' | 'error'; summary: string } = {
        status: r.status === 'error' ? 'error' : 'ok',
        summary,
      }
      const latest = loadFile()
      const t2 = latest.tasks.find((x) => x.id === id)
      if (t2) {
        t2.lastRunAt = new Date().toISOString()
        t2.lastStatus = result.status
        t2.lastSummary = result.summary
        t2.runCount += 1
        saveFile(latest)
      }
      logEvent('cron.done', { id, status: result.status, summary: result.summary.slice(0, 200) })
      onRun?.(task, result.status, result.summary)
      return result
    } catch (err) {
      const summary = `morning-loop crashed: ${(err as Error).message}`
      logEvent('cron.done', { id, status: 'error', summary })
      onRun?.(task, 'error', summary)
      return { status: 'error', summary }
    }
  }

  const jobResult = await bgEnqueue({
    label: `cron:${task.name}`,
    prompt: `[Scheduled task: ${task.name}]\n\n${task.prompt}`,
    channelContext: {
      channel: 'cron',
      label: task.name,
      extras: {
        task_id: task.id,
        cron_expr: task.cron,
        run_count: task.runCount,
      },
    },
  })
  const result: { status: 'ok' | 'error'; summary: string } =
    jobResult.status === 'ok'
      ? { status: 'ok', summary: jobResult.text.trim().slice(0, 400) || 'no output' }
      : { status: 'error', summary: (jobResult.error ?? 'unknown error').slice(0, 400) }

  // Reload fresh to avoid clobbering concurrent edits
  const latest = loadFile()
  const t2 = latest.tasks.find((x) => x.id === id)
  if (t2) {
    t2.lastRunAt = new Date().toISOString()
    t2.lastStatus = result.status
    t2.lastSummary = result.summary
    t2.runCount += 1
    saveFile(latest)
  }
  logEvent('cron.done', {
    id,
    status: result.status,
    summary: result.summary.slice(0, 200),
  })
  onRun?.(task, result.status, result.summary)
  return result
}
