/**
 * core/swarm.ts — run N sub-agents in parallel with per-task workspaces.
 *
 * When Dot has a job that splits into independent pieces (analyse 5
 * repos, research 4 companies, check 8 URLs), she picks `swarm_dispatch`
 * instead of a serial loop. Each swarm member:
 *
 *   - gets its own workspace at `~/.nina/swarm/<runId>/<idx>/`
 *   - starts with a fresh session (no conversation history)
 *   - runs with a tight tool allowlist (no telegram, no self-rewrite,
 *     no mission control — a swarm member is a scoped worker, not a
 *     full Dot)
 *   - writes its own `result.md` into its workspace
 *   - returns a short summary string to the caller
 *
 * Concurrency is capped (default 3) so the user's machine doesn't melt
 * when Dot gets ambitious. Timeouts are per-task (default 3 min).
 *
 * The workspace dirs are NOT auto-cleaned — they live under
 * `~/.nina/swarm/` for later inspection + replay. Sweep them manually
 * or add a retention job later (not in scope for this file).
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { NINA_DIR } from './memory.js'
import { runAgent } from './agent.js'

export interface SwarmTask {
  /** Short label shown in telemetry. */
  label: string
  /** The prompt this sub-agent receives. Treat as fresh — no history. */
  prompt: string
  /** Extra files to drop into the workspace before the agent runs. Keys
   *  are filenames relative to the workspace root; values are content. */
  files?: Record<string, string>
  /** Override the default worker tool allowlist for this task. */
  allowedTools?: string[]
}

export interface SwarmOptions {
  /** Role name for all tasks — purely cosmetic, shown in labels. */
  role?: string
  /** Maximum concurrent workers. Default 3. */
  concurrency?: number
  /** Per-task hard timeout ms. Default 3 min. */
  timeoutMs?: number
}

export interface SwarmResultEntry {
  idx: number
  label: string
  ok: boolean
  workspace: string
  text: string
  tools: string[]
  durationMs: number
  error?: string
}

const DEFAULT_WORKER_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'mcp__nina__screenshot',
  'mcp__nina__browser_goto',
  'mcp__nina__browser_snapshot',
  'mcp__nina__browser_get_text',
  'mcp__nina__gmail_search',
  'mcp__nina__calendar_upcoming',
  'mcp__nina__think',
]

function makeRunDir(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const rand = randomBytes(4).toString('hex')
  const dir = path.join(NINA_DIR, 'swarm', `${ts}-${rand}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function seedWorkspace(dir: string, task: SwarmTask, role?: string): void {
  fs.mkdirSync(dir, { recursive: true })
  const claudeMd =
    `# You are a Dot swarm worker\n\n` +
    (role ? `Role: **${role}**\n\n` : '') +
    `You are one of several parallel workers. Your scope is ONLY the task below. ` +
    `Do NOT import state from Dot's main memory — treat this workspace as your full world. ` +
    `Write your findings into \`result.md\` before you finish. Keep it tight (<300 words).\n\n` +
    `## Task\n\n${task.prompt}\n`
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), claudeMd, 'utf8')
  // Seed files
  for (const [name, content] of Object.entries(task.files ?? {})) {
    if (name.includes('..') || path.isAbsolute(name)) continue
    const p = path.join(dir, name)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content, 'utf8')
  }
}

async function runOneTask(
  idx: number,
  task: SwarmTask,
  workspace: string,
  role: string | undefined,
  timeoutMs: number,
): Promise<SwarmResultEntry> {
  const startedAt = Date.now()
  seedWorkspace(workspace, task, role)
  let collected = ''
  const toolsUsed: string[] = []
  let settled = false
  return await new Promise<SwarmResultEntry>((resolve) => {
    const to = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({
        idx,
        label: task.label,
        ok: false,
        workspace,
        text: collected,
        tools: toolsUsed,
        durationMs: Date.now() - startedAt,
        error: `timeout after ${timeoutMs}ms`,
      })
    }, timeoutMs)

    runAgent(
      `You are a swarm worker (idx=${idx}, role=${role ?? 'worker'}, label="${task.label}"). ` +
        `Read CLAUDE.md in the cwd and do the task. Save your findings to result.md. ` +
        `Keep tool calls minimal.`,
      {
        onText: (t) => {
          collected += t
        },
        onTool: (name) => {
          toolsUsed.push(name)
        },
        onDone: () => {
          if (settled) return
          settled = true
          clearTimeout(to)
          // Prefer the content the worker wrote to result.md, if any.
          let finalText = collected
          try {
            const rp = path.join(workspace, 'result.md')
            if (fs.existsSync(rp)) {
              finalText = fs.readFileSync(rp, 'utf8')
            }
          } catch {
            // ignore
          }
          resolve({
            idx,
            label: task.label,
            ok: true,
            workspace,
            text: finalText.trim().slice(0, 8000),
            tools: toolsUsed,
            durationMs: Date.now() - startedAt,
          })
        },
        onError: (err) => {
          if (settled) return
          settled = true
          clearTimeout(to)
          resolve({
            idx,
            label: task.label,
            ok: false,
            workspace,
            text: collected,
            tools: toolsUsed,
            durationMs: Date.now() - startedAt,
            error: err,
          })
        },
      },
      {
        freshSession: true,
        cwd: workspace,
        allowedTools: task.allowedTools ?? DEFAULT_WORKER_TOOLS,
        channelContext: {
          channel: 'swarm',
          label: `${role ?? 'worker'}:${task.label}`,
        },
      },
    ).catch((err: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(to)
      resolve({
        idx,
        label: task.label,
        ok: false,
        workspace,
        text: collected,
        tools: toolsUsed,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  })
}

/**
 * Run N tasks in parallel with bounded concurrency. Returns results in
 * input order (sorted by idx).
 */
export async function spawnSwarm(
  tasks: SwarmTask[],
  opts?: SwarmOptions,
): Promise<{ runId: string; runDir: string; results: SwarmResultEntry[] }> {
  const runDir = makeRunDir()
  const runId = path.basename(runDir)
  const concurrency = Math.max(1, Math.min(opts?.concurrency ?? 3, 8))
  const timeoutMs = opts?.timeoutMs ?? 3 * 60 * 1000
  const role = opts?.role
  const results: SwarmResultEntry[] = []
  let nextIdx = 0

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIdx++
      if (i >= tasks.length) return
      const task = tasks[i]
      const workspace = path.join(runDir, String(i).padStart(3, '0'))
      const entry = await runOneTask(i, task, workspace, role, timeoutMs)
      results.push(entry)
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker())
  await Promise.all(workers)
  results.sort((a, b) => a.idx - b.idx)

  // Write an index file so the swarm run is self-documenting on disk.
  try {
    const index = {
      runId,
      startedAt: new Date().toISOString(),
      role,
      tasks: results.map((r) => ({
        idx: r.idx,
        label: r.label,
        ok: r.ok,
        durationMs: r.durationMs,
        workspace: r.workspace,
        error: r.error,
      })),
    }
    fs.writeFileSync(
      path.join(runDir, 'swarm.json'),
      JSON.stringify(index, null, 2),
      'utf8',
    )
  } catch {
    // non-critical
  }

  return { runId, runDir, results }
}
