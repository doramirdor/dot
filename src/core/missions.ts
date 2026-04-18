/**
 * Long-running missions — markdown-per-mission with periodic check-ins.
 *
 * Each mission is a small directory:
 *   ~/.dot/missions/<id>/
 *     mission.md   — goal, status, metadata (YAML frontmatter + markdown body)
 *     log.md       — append-only activity log (every step appends here)
 *     artifacts/   — any files produced during the mission
 *
 * Missions persist across restarts. A supervisor loop checks every few minutes
 * which missions are due for a step and runs them.
 *
 * Mission statuses: pending | active | paused | complete | failed
 *
 * The step prompt runs via runAgent so the mission has full access to all
 * tools (browser, claude_code, screenshot, etc.) — missions ARE agent runs,
 * just scoped and persistent.
 */
import fs from 'node:fs'
import path from 'node:path'
import { NINA_DIR } from './memory.js'
import { runAgent } from './agent.js'

export const MISSIONS_DIR = path.join(NINA_DIR, 'missions')

export type MissionStatus = 'pending' | 'active' | 'paused' | 'complete' | 'failed'

export interface MissionMeta {
  id: string
  goal: string
  status: MissionStatus
  createdAt: string
  updatedAt: string
  nextRunAt: string | null // ISO timestamp or null
  checkIntervalMinutes: number
  stepCount: number
  lastStepSummary: string | null
  outcome: string | null
}

function ensureMissionsDir(): void {
  fs.mkdirSync(MISSIONS_DIR, { recursive: true })
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40)
}

function missionDir(id: string): string {
  return path.join(MISSIONS_DIR, id)
}

function missionFile(id: string): string {
  return path.join(missionDir(id), 'mission.md')
}

function logFile(id: string): string {
  return path.join(missionDir(id), 'log.md')
}

// ========== serialization ==========

function serializeMission(meta: MissionMeta, body: string): string {
  const frontmatter = [
    '---',
    `id: ${meta.id}`,
    `goal: ${JSON.stringify(meta.goal)}`,
    `status: ${meta.status}`,
    `createdAt: ${meta.createdAt}`,
    `updatedAt: ${meta.updatedAt}`,
    `nextRunAt: ${meta.nextRunAt ?? 'null'}`,
    `checkIntervalMinutes: ${meta.checkIntervalMinutes}`,
    `stepCount: ${meta.stepCount}`,
    `lastStepSummary: ${JSON.stringify(meta.lastStepSummary ?? '')}`,
    `outcome: ${JSON.stringify(meta.outcome ?? '')}`,
    '---',
    '',
  ].join('\n')
  return frontmatter + body
}

function parseMission(raw: string): { meta: MissionMeta; body: string } | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return null
  const frontmatter = match[1]!
  const body = match[2] ?? ''
  const meta: Partial<MissionMeta> = {}
  for (const line of frontmatter.split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/)
    if (!m) continue
    const key = m[1]!
    const rawVal = m[2]!.trim()
    let val: string | number | null = rawVal
    // JSON-decode quoted values
    if (rawVal.startsWith('"')) {
      try {
        val = JSON.parse(rawVal) as string
      } catch {
        val = rawVal
      }
    }
    if (rawVal === 'null') val = null
    if (key === 'checkIntervalMinutes' || key === 'stepCount') {
      const n = parseInt(rawVal, 10)
      val = Number.isFinite(n) ? n : 0
    }
    ;(meta as Record<string, unknown>)[key] = val
  }
  // Required fields check
  if (!meta.id || !meta.goal || !meta.status || !meta.createdAt) return null
  return { meta: meta as MissionMeta, body }
}

// ========== CRUD ==========

export function loadMission(id: string): { meta: MissionMeta; body: string } | null {
  try {
    const raw = fs.readFileSync(missionFile(id), 'utf8')
    return parseMission(raw)
  } catch {
    return null
  }
}

export function saveMission(meta: MissionMeta, body: string): void {
  ensureMissionsDir()
  const dir = missionDir(meta.id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(missionFile(meta.id), serializeMission(meta, body), 'utf8')
}

export function listMissions(): MissionMeta[] {
  ensureMissionsDir()
  try {
    const ids = fs
      .readdirSync(MISSIONS_DIR)
      .filter((f) => fs.statSync(path.join(MISSIONS_DIR, f)).isDirectory())
    const out: MissionMeta[] = []
    for (const id of ids) {
      const m = loadMission(id)
      if (m) out.push(m.meta)
    }
    // Sort: active first, then paused, then by updatedAt desc
    out.sort((a, b) => {
      const order: Record<MissionStatus, number> = {
        active: 0,
        pending: 1,
        paused: 2,
        complete: 3,
        failed: 4,
      }
      const diff = order[a.status] - order[b.status]
      if (diff !== 0) return diff
      return b.updatedAt.localeCompare(a.updatedAt)
    })
    return out
  } catch {
    return []
  }
}

export function createMission(params: {
  goal: string
  checkIntervalMinutes?: number
  initialBody?: string
}): MissionMeta {
  ensureMissionsDir()
  const goal = params.goal.trim()
  const baseSlug = slugify(goal) || 'mission'
  // Find unique id
  let id = baseSlug
  let n = 1
  while (fs.existsSync(missionDir(id))) {
    n++
    id = `${baseSlug}-${n}`
  }
  const now = new Date().toISOString()
  const interval = params.checkIntervalMinutes ?? 180 // 3 hours default
  const meta: MissionMeta = {
    id,
    goal,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    nextRunAt: new Date(Date.now() + 30_000).toISOString(), // first run in 30s
    checkIntervalMinutes: interval,
    stepCount: 0,
    lastStepSummary: null,
    outcome: null,
  }
  const body =
    params.initialBody ??
    `# ${goal}\n\n## Plan\n\n(Dot will fill this in on the first step.)\n\n## Notes\n\n`
  saveMission(meta, body)
  return meta
}

export function appendLog(id: string, entry: string): void {
  const dir = missionDir(id)
  fs.mkdirSync(dir, { recursive: true })
  const line = `\n### ${new Date().toISOString()}\n\n${entry.trim()}\n`
  try {
    fs.appendFileSync(logFile(id), line, 'utf8')
  } catch (err) {
    console.warn('[missions] appendLog failed:', err)
  }
}

export function readLog(id: string, tailBytes = 3000): string {
  try {
    const raw = fs.readFileSync(logFile(id), 'utf8')
    if (raw.length <= tailBytes) return raw
    return '…\n' + raw.slice(-tailBytes)
  } catch {
    return '(empty)'
  }
}

export function updateMissionStatus(
  id: string,
  status: MissionStatus,
  outcome?: string,
): void {
  const loaded = loadMission(id)
  if (!loaded) return
  loaded.meta.status = status
  loaded.meta.updatedAt = new Date().toISOString()
  if (status === 'complete' || status === 'failed') {
    loaded.meta.nextRunAt = null
    if (outcome) loaded.meta.outcome = outcome
  }
  saveMission(loaded.meta, loaded.body)
}

// ========== running a step ==========

function buildStepPrompt(meta: MissionMeta, body: string, tailLog: string): string {
  return `[Mission step — background work, no user watching]

You are Dot, working on a long-running mission. Take one concrete step
toward the goal, then stop and log what you did.

# Mission
id: ${meta.id}
goal: ${meta.goal}
status: ${meta.status}
step number: ${meta.stepCount + 1}
check interval: ${meta.checkIntervalMinutes} minutes

# Mission body
${body}

# Recent log (last few steps)
${tailLog}

# Instructions

1. Read any memory files that might help: ~/.dot/memory/projects.md,
   preferences.md, user_profile.md. Consult them before deciding what to do.

2. Take ONE concrete step. Use any tools you need (bash, browser, claude_code,
   screenshot, calendar, mail, etc.). Do not try to finish the whole mission
   in one step — take the next obvious action.

3. After the step, decide the mission's new state:
   - "active"   → more work to do; schedule another check after the interval
   - "paused"   → blocked waiting for something; keep the mission alive but
                  don't re-run automatically
   - "complete" → goal achieved; write an outcome summary
   - "failed"   → cannot proceed; write a failure summary

4. Your final response MUST be a single JSON object on the LAST line,
   nothing else after it. Format exactly:

       {"status":"active","summary":"<one-line summary of what you did>","outcome":null}

   Or for completion:

       {"status":"complete","summary":"<last step>","outcome":"<final outcome>"}

5. Before the JSON, you may write a few paragraphs describing what you did
   and what's next. Those paragraphs will be appended to the mission log.
   Keep it concise — this is a log entry, not a report.

Rules:
- Never spend more than ~2 minutes per step. If something is taking forever,
  pause the mission and describe the blocker.
- Never delete or destroy anything outside ~/.dot/. If the mission touches
  real user files or projects, be conservative.
- Never send email, post to social media, or spend money without the outcome
  JSON saying "paused" + asking the user to confirm next step.`
}

export interface StepResult {
  status: MissionStatus
  summary: string
  outcome: string | null
  rawOutput: string
  error: string | null
}

function parseStepOutput(raw: string): StepResult {
  const trimmed = raw.trim()
  // Find the LAST JSON object in the output
  let parsed: Partial<StepResult> = {}
  const jsonMatch = trimmed.match(/\{[^{}]*"status"[^{}]*\}[^{}]*$/m)
  if (jsonMatch) {
    try {
      parsed = JSON.parse(jsonMatch[0]) as Partial<StepResult>
    } catch {
      // ignore
    }
  }

  const status: MissionStatus =
    (parsed.status as MissionStatus) && ['active', 'paused', 'complete', 'failed'].includes(parsed.status as string)
      ? (parsed.status as MissionStatus)
      : 'active'

  return {
    status,
    summary: parsed.summary ?? 'step ran',
    outcome: parsed.outcome ?? null,
    rawOutput: trimmed,
    error: null,
  }
}

export async function runMissionStep(id: string): Promise<StepResult> {
  const loaded = loadMission(id)
  if (!loaded) {
    return {
      status: 'failed',
      summary: 'mission not found',
      outcome: null,
      rawOutput: '',
      error: `mission ${id} not found`,
    }
  }

  const tailLog = readLog(id, 2000)
  const prompt = buildStepPrompt(loaded.meta, loaded.body, tailLog)

  return new Promise((resolve) => {
    let buffer = ''
    runAgent(prompt, {
      onText: (text) => {
        buffer += text
      },
      onTool: () => {},
      onDone: () => {
        const result = parseStepOutput(buffer)

        // Update mission metadata
        const updated = { ...loaded.meta }
        updated.stepCount += 1
        updated.updatedAt = new Date().toISOString()
        updated.lastStepSummary = result.summary
        updated.status = result.status
        if (result.status === 'complete' || result.status === 'failed') {
          updated.outcome = result.outcome
          updated.nextRunAt = null
        } else if (result.status === 'paused') {
          updated.nextRunAt = null
        } else {
          updated.nextRunAt = new Date(
            Date.now() + updated.checkIntervalMinutes * 60 * 1000,
          ).toISOString()
        }
        saveMission(updated, loaded.body)

        // Append to log
        appendLog(id, result.rawOutput)

        resolve(result)
      },
      onError: (err) => {
        appendLog(id, `[ERROR] ${err}`)
        const updated = { ...loaded.meta }
        updated.updatedAt = new Date().toISOString()
        updated.lastStepSummary = `error: ${err.slice(0, 100)}`
        // Reschedule with backoff
        updated.nextRunAt = new Date(
          Date.now() + Math.min(updated.checkIntervalMinutes * 2, 720) * 60 * 1000,
        ).toISOString()
        saveMission(updated, loaded.body)
        resolve({
          status: updated.status,
          summary: `error: ${err.slice(0, 100)}`,
          outcome: null,
          rawOutput: buffer,
          error: err,
        })
      },
    }, {
      freshSession: true,
      channelContext: {
        channel: 'mission',
        label: loaded.meta.id,
        extras: {
          goal: loaded.meta.goal,
          step_count: loaded.meta.stepCount,
          status: loaded.meta.status,
        },
      },
    }).catch((err) => {
      resolve({
        status: 'failed',
        summary: 'spawn failed',
        outcome: null,
        rawOutput: '',
        error: err instanceof Error ? err.message : String(err),
      })
    })
  })
}

// ========== supervisor loop ==========

let supervisorHandle: NodeJS.Timeout | null = null
let supervisorRunning = false

async function supervisorTick(onStep?: (id: string, result: StepResult) => void): Promise<void> {
  if (supervisorRunning) return
  supervisorRunning = true
  try {
    const missions = listMissions()
    const now = Date.now()
    for (const meta of missions) {
      if (meta.status !== 'active') continue
      if (!meta.nextRunAt) continue
      const due = Date.parse(meta.nextRunAt)
      if (!Number.isFinite(due) || due > now) continue
      // Run one mission per tick to avoid concurrent agent runs
      console.log(`[missions] stepping ${meta.id}`)
      const result = await runMissionStep(meta.id)
      onStep?.(meta.id, result)
      break
    }
  } finally {
    supervisorRunning = false
  }
}

export function startMissionSupervisor(
  tickIntervalMs = 2 * 60 * 1000, // check every 2 min
  onStep?: (id: string, result: StepResult) => void,
): void {
  if (supervisorHandle) return
  supervisorHandle = setInterval(() => {
    void supervisorTick(onStep)
  }, tickIntervalMs)
  // Also fire an initial check shortly after startup
  setTimeout(() => void supervisorTick(onStep), 15_000)
}

export function stopMissionSupervisor(): void {
  if (supervisorHandle) {
    clearInterval(supervisorHandle)
    supervisorHandle = null
  }
}

// ========== formatting ==========

export function formatMissionList(missions: MissionMeta[]): string {
  if (missions.length === 0) return '(no missions)'
  return missions
    .map((m) => {
      const lines = [
        `${m.status === 'active' ? '▸' : m.status === 'paused' ? '⏸' : m.status === 'complete' ? '✓' : m.status === 'failed' ? '✗' : '•'} ${m.id}`,
        `    goal: ${m.goal}`,
        `    steps: ${m.stepCount} · updated: ${m.updatedAt}`,
      ]
      if (m.lastStepSummary) lines.push(`    last: ${m.lastStepSummary}`)
      if (m.nextRunAt) lines.push(`    next: ${m.nextRunAt}`)
      if (m.outcome) lines.push(`    outcome: ${m.outcome}`)
      return lines.join('\n')
    })
    .join('\n\n')
}

export function formatMissionStatus(id: string): string {
  const loaded = loadMission(id)
  if (!loaded) return `mission "${id}" not found`
  const { meta, body } = loaded
  const tail = readLog(id, 1500)
  return [
    `# ${meta.id}`,
    '',
    `goal: ${meta.goal}`,
    `status: ${meta.status}`,
    `steps: ${meta.stepCount}`,
    `updated: ${meta.updatedAt}`,
    meta.nextRunAt ? `next: ${meta.nextRunAt}` : '',
    meta.outcome ? `outcome: ${meta.outcome}` : '',
    '',
    '## Body',
    body.trim(),
    '',
    '## Recent log',
    tail.trim(),
  ]
    .filter(Boolean)
    .join('\n')
}
