/**
 * Reversible destructive operations.
 *
 * Dot should NEVER directly rm files, delete emails, or overwrite things
 * without a recovery path. Every destructive op goes through a wrapper
 * here that:
 *
 *   1. Captures the original state
 *   2. Moves it to ~/.nina/trash/<iso-ts>/<original-path>/  (files)
 *      OR applies a reversible label (gmail)
 *   3. Logs an undo_log row with reversal steps
 *   4. Returns an undo_id the caller can use to reverse
 *
 * If Dot dies mid-op, the trash dir + the undo_log row are durable, so a
 * human can reconstruct the state even with Dot down.
 *
 * Design principle: it is ALWAYS better to let a file rot in trash for 30
 * days than to delete something the user wanted. Disk is cheap, regrets
 * are expensive.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { NINA_DIR } from './memory.js'
import { logUndoOp, markUndone, listRecentUndoOps, getUndoOp } from './db.js'

export const TRASH_DIR = path.join(NINA_DIR, 'trash')

function ensureTrashDir(): void {
  fs.mkdirSync(TRASH_DIR, { recursive: true })
}

/**
 * Is `candidate` inside `dir`? Uses path.relative, which correctly
 * handles sibling directories like /Users/alice-evil vs /Users/alice —
 * a pure prefix check would wrongly pass those.
 */
function isInsideDir(dir: string, candidate: string): boolean {
  const rel = path.relative(dir, candidate)
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function trashSlot(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  // Cryptographic randomness so two concurrent calls in the same
  // millisecond don't ever collide on the same slot directory.
  const rand = randomBytes(6).toString('hex')
  const dir = path.join(TRASH_DIR, `${ts}-${rand}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Reversible file delete. Moves the target to ~/.nina/trash/ instead of
 * unlinking. Works for files and directories. Returns an undo_id.
 */
export function safeDeleteFile(
  targetPath: string,
  agentReason?: string,
): { ok: boolean; undoId?: number; trashPath?: string; error?: string } {
  const abs = path.resolve(targetPath)
  if (!fs.existsSync(abs)) {
    return { ok: false, error: `path does not exist: ${abs}` }
  }
  // Guardrails — never trash anything outside the user's home, never
  // trash the trash dir itself, never trash ~/.nina entirely. Use
  // path.relative + '..' check instead of a string prefix so that a
  // sibling home (e.g. /Users/ellabaror-evil when home=/Users/ellabaror)
  // is correctly rejected.
  const home = os.homedir()
  if (!isInsideDir(home, abs)) {
    return { ok: false, error: `refusing to trash path outside home: ${abs}` }
  }
  if (abs === NINA_DIR || abs === TRASH_DIR || abs.startsWith(TRASH_DIR)) {
    return { ok: false, error: `refusing to trash dot's own directory` }
  }
  if (abs === home) {
    return { ok: false, error: `refusing to trash $HOME` }
  }

  ensureTrashDir()
  const slot = trashSlot()
  // Preserve the relative structure inside the slot so we can restore
  // the file exactly where it came from.
  const relative = path.relative(home, abs)
  const destParent = path.join(slot, path.dirname(relative))
  fs.mkdirSync(destParent, { recursive: true })
  const dest = path.join(slot, relative)

  try {
    fs.renameSync(abs, dest)
  } catch (err) {
    // EXDEV (cross-device): fall back to cp -r + rm
    try {
      fs.cpSync(abs, dest, { recursive: true })
      fs.rmSync(abs, { recursive: true, force: true })
    } catch (err2) {
      return { ok: false, error: (err2 as Error).message }
    }
  }

  const undoId = logUndoOp({
    opType: 'file.delete',
    target: abs,
    reversible: true,
    reversalSteps: { restoreFrom: dest, restoreTo: abs },
    agentReason,
  })
  return { ok: true, undoId, trashPath: dest }
}

/**
 * Reversible file overwrite. Before a write, snapshot the current content
 * to trash. If the file doesn't exist yet, the undo is "delete it again".
 */
export function safeWriteFile(
  targetPath: string,
  newContent: string | Buffer,
  agentReason?: string,
): { ok: boolean; undoId?: number; error?: string } {
  const abs = path.resolve(targetPath)
  ensureTrashDir()
  const existed = fs.existsSync(abs)
  let reversalSteps: Record<string, unknown>

  if (existed) {
    const slot = trashSlot()
    const backup = path.join(slot, path.basename(abs))
    try {
      fs.copyFileSync(abs, backup)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
    reversalSteps = { restoreFrom: backup, restoreTo: abs, existed: true }
  } else {
    reversalSteps = { removeCreated: abs, existed: false }
  }

  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    // Atomic write: write to a sibling temp file then rename over the
    // target. Prevents half-written files if the process crashes mid-
    // write, and prevents readers from seeing torn content.
    const tmp = `${abs}.tmp.${randomBytes(4).toString('hex')}`
    fs.writeFileSync(tmp, newContent)
    fs.renameSync(tmp, abs)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  const undoId = logUndoOp({
    opType: existed ? 'file.overwrite' : 'file.create',
    target: abs,
    reversible: true,
    reversalSteps,
    agentReason,
  })
  return { ok: true, undoId }
}

/**
 * Perform the reversal recorded for a given undo_log id. Only works for
 * reversible ops that haven't already been undone.
 */
export function undoOperation(undoId: number): { ok: boolean; message: string } {
  const row = getUndoOp(undoId)
  if (!row) return { ok: false, message: `no undo entry ${undoId}` }
  if (row.reversed_at) return { ok: false, message: `already reversed at ${row.reversed_at}` }
  if (!row.reversible) return { ok: false, message: 'op is not reversible' }
  if (!row.reversal_steps) return { ok: false, message: 'no reversal steps recorded' }

  let steps: Record<string, unknown>
  try {
    steps = JSON.parse(row.reversal_steps)
  } catch {
    return { ok: false, message: 'reversal steps corrupted' }
  }

  try {
    switch (row.op_type) {
      case 'file.delete': {
        const from = String(steps.restoreFrom)
        const to = String(steps.restoreTo)
        if (fs.existsSync(to)) {
          return { ok: false, message: `cannot restore: ${to} already exists` }
        }
        fs.mkdirSync(path.dirname(to), { recursive: true })
        fs.renameSync(from, to)
        markUndone(undoId)
        return { ok: true, message: `restored ${to}` }
      }
      case 'file.overwrite': {
        const from = String(steps.restoreFrom)
        const to = String(steps.restoreTo)
        fs.copyFileSync(from, to)
        markUndone(undoId)
        return { ok: true, message: `restored prior content of ${to}` }
      }
      case 'file.create': {
        const created = String(steps.removeCreated)
        if (fs.existsSync(created)) {
          fs.rmSync(created, { force: true, recursive: true })
        }
        markUndone(undoId)
        return { ok: true, message: `removed ${created}` }
      }
      case 'self.rewrite': {
        // Dynamic import so safe-ops stays free of the claude-code bridge.
        const layer = String(steps.layer) as
          | 'core'
          | 'skills'
          | 'brain'
          | 'heart'
        const snapshotPath = String(steps.snapshotPath)
        // Note: returns synchronously with a "scheduled" message; the
        // actual extraction happens in a microtask since this function
        // is sync. Callers wanting confirmation should poll the target
        // or prefer the async `undoSelfRewrite` helper exported below.
        void (async () => {
          try {
            const { restoreLayerSnapshot } = await import('./self-rewrite.js')
            await restoreLayerSnapshot(layer, snapshotPath)
            markUndone(undoId)
          } catch (err) {
            console.warn('[safe-ops] self.rewrite undo failed:', err)
          }
        })()
        return {
          ok: true,
          message: `self-rewrite rollback scheduled for ${layer} (snapshot ${snapshotPath})`,
        }
      }
      default:
        return { ok: false, message: `don't know how to reverse op_type ${row.op_type}` }
    }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}

export function listRecentOps(limit = 30): ReturnType<typeof listRecentUndoOps> {
  return listRecentUndoOps(limit)
}

/**
 * Compute trash dir size for the dashboard.
 */
export function getTrashStats(): { slots: number; totalBytes: number } {
  if (!fs.existsSync(TRASH_DIR)) return { slots: 0, totalBytes: 0 }
  const entries = fs.readdirSync(TRASH_DIR, { withFileTypes: true })
  let totalBytes = 0
  const walk = (p: string): void => {
    let stat: fs.Stats
    try {
      stat = fs.statSync(p)
    } catch {
      return
    }
    if (stat.isDirectory()) {
      let children: fs.Dirent[] = []
      try {
        children = fs.readdirSync(p, { withFileTypes: true })
      } catch {
        return
      }
      for (const c of children) walk(path.join(p, c.name))
    } else {
      totalBytes += stat.size
    }
  }
  for (const e of entries) walk(path.join(TRASH_DIR, e.name))
  return { slots: entries.length, totalBytes }
}
