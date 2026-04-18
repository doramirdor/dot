/**
 * Serialized background-agent queue.
 *
 * Problem: cron tasks, mission steps, reflection, and diary can all fire
 * runAgent concurrently. Each run spins up the Agent SDK, loads memory,
 * creates an MCP server, and hammers the model. Under load this melts both
 * the local process and the API budget.
 *
 * Solution: any "background" agent call goes through enqueue() here, which
 * runs at most one at a time. Foreground chat turns bypass this queue — a
 * user typing should never wait on a cron task. Simple FIFO.
 */
import { runAgent, type ChannelContext } from './agent.js'
import { logEvent, getTokenStats } from './db.js'
import { loadConfig } from './config.js'

export interface BgJob {
  label: string
  prompt: string
  onText?: (text: string) => void
  onTool?: (name: string, input: unknown) => void
  /**
   * Optional channel context. When set, bg-queue passes it through to
   * runAgent so the situational frame is rendered for this background
   * turn. Added in Week 2 of the refactor plan.
   */
  channelContext?: ChannelContext
}

export interface BgJobResult {
  status: 'ok' | 'error'
  text: string
  error?: string
  durationMs: number
}

interface QueuedJob {
  job: BgJob
  enqueuedAt: number
  resolve: (r: BgJobResult) => void
}

const queue: QueuedJob[] = []
let running: string | null = null
const MAX_QUEUE = 50
/** Hard deadline per background job. Prevents a stuck stream from
 *  hanging the queue forever. 10 min is generous — real jobs finish
 *  well under that; anything over is almost certainly wedged. */
const JOB_TIMEOUT_MS = 10 * 60 * 1000
/** When a 429 or 5xx lands, park the whole queue until this timestamp.
 *  Backoff is deterministic and short enough to recover quickly without
 *  flooding the API. */
let rateLimitUntil = 0

export function bgQueueDepth(): number {
  return queue.length
}

export function bgCurrent(): string | null {
  return running
}

export function enqueue(job: BgJob): Promise<BgJobResult> {
  return new Promise((resolve) => {
    // Soft daily-budget gate: background jobs are blocked past the cap.
    // Foreground chat never goes through this queue, so user turns still
    // work and can decide what to do about the budget.
    const cap = loadConfig().dailyBudgetUsd
    if (cap > 0) {
      try {
        const today = getTokenStats().todayCostUsd
        if (today >= cap) {
          logEvent('bgqueue.budget_block', {
            label: job.label,
            todayCostUsd: today,
            cap,
          })
          resolve({
            status: 'error',
            text: '',
            error: `daily budget reached ($${today.toFixed(4)} of $${cap.toFixed(2)}). background job "${job.label}" skipped. use foreground chat or raise dailyBudgetUsd in ~/.dot/config.json.`,
            durationMs: 0,
          })
          return
        }
      } catch (err) {
        // Fail CLOSED: if we can't read the budget, don't run background
        // work — better to skip a cron than to melt the budget because
        // of a transient DB error.
        logEvent('bgqueue.budget_check_failed', {
          label: job.label,
          error: (err as Error).message,
        })
        resolve({
          status: 'error',
          text: '',
          error: `budget check failed: ${(err as Error).message} — background job "${job.label}" skipped for safety`,
          durationMs: 0,
        })
        return
      }
    }
    // Respect 429 cooldown: if the last drain saw a rate-limit, park
    // this job until the cooldown lapses. Foreground turns don't queue
    // here, so the user can still type at Dot.
    if (rateLimitUntil > Date.now()) {
      const waitMs = rateLimitUntil - Date.now()
      logEvent('bgqueue.rate_cooldown', { label: job.label, waitMs })
      resolve({
        status: 'error',
        text: '',
        error: `rate-limit cooldown: ${Math.ceil(waitMs / 1000)}s remaining`,
        durationMs: 0,
      })
      return
    }

    if (queue.length >= MAX_QUEUE) {
      logEvent('bgqueue.drop', { label: job.label, depth: queue.length })
      resolve({
        status: 'error',
        text: '',
        error: `queue full (${MAX_QUEUE})`,
        durationMs: 0,
      })
      return
    }
    queue.push({ job, enqueuedAt: Date.now(), resolve })
    logEvent('bgqueue.push', { label: job.label, depth: queue.length })
    void drain()
  })
}

async function drain(): Promise<void> {
  if (running) return
  const next = queue.shift()
  if (!next) return
  running = next.job.label
  const start = Date.now()
  let buffer = ''
  let settled = false
  const settleOnce = (result: BgJobResult): void => {
    if (settled) return
    settled = true
    next.resolve(result)
  }

  // Hard deadline — if runAgent wedges, we still resolve so the queue
  // doesn't freeze and subsequent jobs can proceed.
  const timeoutId = setTimeout(() => {
    logEvent('bgqueue.timeout', { label: next.job.label, deadlineMs: JOB_TIMEOUT_MS })
    settleOnce({
      status: 'error',
      text: buffer,
      error: `job exceeded ${Math.round(JOB_TIMEOUT_MS / 1000)}s deadline`,
      durationMs: Date.now() - start,
    })
  }, JOB_TIMEOUT_MS)

  try {
    await new Promise<void>((resolveInner) => {
      void runAgent(
        next.job.prompt,
        {
          onText: (text) => {
            buffer += text
            next.job.onText?.(text)
          },
          onTool: (name, input) => next.job.onTool?.(name, input),
          onDone: () => {
            settleOnce({
              status: 'ok',
              text: buffer,
              durationMs: Date.now() - start,
            })
            resolveInner()
          },
          onError: (err) => {
            // Detect rate-limit / overload errors and park the queue.
            // Error strings from the Agent SDK / Anthropic API typically
            // include "429", "rate_limit", or "overloaded_error". Match
            // conservatively.
            const lower = err.toLowerCase()
            if (/429|rate[_ -]?limit|overloaded/.test(lower)) {
              const cooldownMs = 60_000 // 1 minute — enough to clear
              rateLimitUntil = Date.now() + cooldownMs
              logEvent('bgqueue.rate_limit_detected', {
                label: next.job.label,
                cooldownMs,
                errSnippet: err.slice(0, 200),
              })
            }
            settleOnce({
              status: 'error',
              text: buffer,
              error: err,
              durationMs: Date.now() - start,
            })
            resolveInner()
          },
        },
        { freshSession: true, channelContext: next.job.channelContext },
      )
    })
  } catch (err) {
    settleOnce({
      status: 'error',
      text: buffer,
      error: (err as Error).message,
      durationMs: Date.now() - start,
    })
  } finally {
    clearTimeout(timeoutId)
    running = null
    logEvent('bgqueue.done', {
      label: next.job.label,
      durationMs: Date.now() - start,
      remaining: queue.length,
    })
    // Chain to next without blocking the stack
    if (queue.length > 0) setImmediate(() => void drain())
  }
}
