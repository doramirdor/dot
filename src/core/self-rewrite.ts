/**
 * core/self-rewrite.ts — Dot can modify her own code/memory/personality.
 *
 * Four layers, each mapped to a directory Dot is allowed to rewrite:
 *
 *   - core    → src/core/           (new modules, tool registrations)
 *   - skills  → ~/.nina/plugins/    (user-extendable skills added at runtime)
 *   - brain   → ~/.nina/memory/     (MEMORY.md, mindmap.md — semantic DB is off-limits)
 *   - heart   → ~/.nina/memory/PERSONALITY.md (tone, character, values)
 *
 * Every rewrite is preceded by a full tar snapshot of the target layer
 * into ~/.nina/trash/<ts>/, logged to undo_log. `undoOperation(id)` will
 * restore the snapshot verbatim — so every self-rewrite is reversible.
 *
 * The actual edit is delegated to `runClaudeCode()` in a subprocess
 * constrained to the layer directory. We don't try to sandbox the
 * subprocess yet (M6 is the container work); the guardrail today is
 * reversibility + trust-tier classification at call time.
 *
 * This module is the engine. The user-facing entry point is the
 * `self_rewrite` MCP tool in mcp-tools.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { NINA_DIR, MEMORY_DIR, PERSONALITY_FILE } from './memory.js'
import { TRASH_DIR } from './safe-ops.js'
import { logUndoOp } from './db.js'
import { runClaudeCode } from '../main/claude-code.js'
import { runInContainer, detectBackend } from './sandbox.js'

const execFileAsync = promisify(execFile)

export type Layer = 'core' | 'skills' | 'brain' | 'heart'

/**
 * Resolve Dot's source-tree root. Works in dev (cwd is the repo) and
 * in packaged builds (walk up from __filename until we hit the package).
 */
function resolveRepoRoot(): string {
  // Env var wins — set this in tests or packaged installs if auto-detect
  // fails.
  const fromEnv = process.env['DOT_REPO_ROOT']
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv

  const thisFile = fileURLToPath(import.meta.url)
  let dir = path.dirname(thisFile)
  for (let i = 0; i < 10; i++) {
    const pkg = path.join(dir, 'package.json')
    if (fs.existsSync(pkg)) {
      try {
        const raw = JSON.parse(fs.readFileSync(pkg, 'utf8')) as { name?: string }
        if (raw.name === 'nina') return dir
      } catch {
        // fall through
      }
    }
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  // Last resort.
  return process.cwd()
}

const REPO_ROOT = resolveRepoRoot()
const PLUGINS_DIR = path.join(NINA_DIR, 'plugins')

function targetDirFor(layer: Layer): string {
  switch (layer) {
    case 'core':
      return path.join(REPO_ROOT, 'src', 'core')
    case 'skills':
      return PLUGINS_DIR
    case 'brain':
      return MEMORY_DIR
    case 'heart':
      // Single file, not a dir. We still snapshot the enclosing dir so
      // the undo restores the exact file state without touching mindmap
      // or MEMORY.md.
      return PERSONALITY_FILE
  }
}

/**
 * Create a tar.gz snapshot of the layer directory (or single file).
 * Returns the absolute path to the snapshot file.
 */
async function snapshotLayer(layer: Layer): Promise<{ snapshotPath: string }> {
  fs.mkdirSync(TRASH_DIR, { recursive: true })
  if (layer === 'skills') {
    // Ensure plugins dir exists so the snapshot is consistent even on
    // first run.
    fs.mkdirSync(PLUGINS_DIR, { recursive: true })
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const rand = randomBytes(6).toString('hex')
  const slot = path.join(TRASH_DIR, `${ts}-${rand}-selfrewrite-${layer}`)
  fs.mkdirSync(slot, { recursive: true })
  const snapshotPath = path.join(slot, `${layer}.tar.gz`)
  const target = targetDirFor(layer)
  if (!fs.existsSync(target)) {
    throw new Error(`self-rewrite: target missing: ${target}`)
  }
  const parent = path.dirname(target)
  const base = path.basename(target)
  await execFileAsync('tar', ['-czf', snapshotPath, '-C', parent, base])
  return { snapshotPath }
}

export async function restoreLayerSnapshot(
  layer: Layer,
  snapshotPath: string,
): Promise<void> {
  if (!fs.existsSync(snapshotPath)) {
    throw new Error(`snapshot missing: ${snapshotPath}`)
  }
  const target = targetDirFor(layer)
  const parent = path.dirname(target)
  const base = path.basename(target)
  if (layer === 'heart') {
    // Single file: overwrite from the tarball.
    await execFileAsync('tar', ['-xzf', snapshotPath, '-C', parent])
    return
  }
  // Directory: wipe then re-extract. The wipe is scoped — we don't touch
  // sibling dirs. Target = known layer dir, never a parent.
  const tmp = path.join(parent, `.rewrite-rollback-${randomBytes(4).toString('hex')}`)
  // Move current target aside (rename is atomic on same fs), extract,
  // then delete the aside. Keeps the layer dir available if extraction
  // fails midway.
  if (fs.existsSync(target)) {
    fs.renameSync(target, tmp)
  }
  try {
    await execFileAsync('tar', ['-xzf', snapshotPath, '-C', parent])
  } catch (err) {
    // Restoration failed — put the aside back so we don't leave Dot
    // broken.
    if (fs.existsSync(tmp) && !fs.existsSync(target)) {
      fs.renameSync(tmp, target)
    }
    throw err
  }
  // On success, the aside is no longer needed. Leave it in place for
  // debugging — a sweeper can gc it later. Renamed with a recognizable
  // prefix so it's easy to find.
  void base
}

export interface RewriteRequest {
  layer: Layer
  intent: string
  constraints?: string
}

export interface RewriteResult {
  ok: boolean
  undoId?: number
  snapshotPath?: string
  stdout?: string
  stderr?: string
  exitCode?: number
  error?: string
  dryRun?: boolean
  /** Which runtime actually executed the rewrite — 'host' means no sandbox. */
  runner?: 'apple-container' | 'docker' | 'in-process' | 'host' | 'none'
}

function buildPromptFor(req: RewriteRequest): string {
  const header =
    'You are modifying Dot\'s own code/memory. Dot is a macOS desktop ' +
    "companion powered by Claude. Your job in this subprocess is to " +
    `implement the user's intent below, scoped strictly to the ` +
    `${req.layer} layer. DO NOT touch files outside this directory. ` +
    `DO NOT add tests or README files unless the intent asks for them. ` +
    `DO NOT introduce new dependencies. Match existing style.`

  const layerRules: Record<Layer, string> = {
    core:
      'This is src/core/. You may add new modules, extend existing ones, ' +
      'or register new MCP tools via mcp-tools.ts. Keep imports relative, ' +
      'use the memory.ts path constants (NINA_DIR, MEMORY_DIR) — never ' +
      'hardcode ~/.nina. Every destructive op should go through safe-ops.',
    skills:
      'This is ~/.nina/plugins/. Each plugin is a .ts or .js module with ' +
      'a default export implementing the plugin interface: { name, tools: [] }. ' +
      'Tools follow the same shape as core/mcp-tools.ts. See other plugins ' +
      'here for the pattern.',
    brain:
      'This is ~/.nina/memory/. You may edit MEMORY.md, mindmap.md, and ' +
      'individual memory files, but NEVER touch the semantic memory ' +
      'SQLite DB (it lives outside this directory). Keep MEMORY.md an ' +
      'index of one-line pointers — under 200 lines total.',
    heart:
      'This is PERSONALITY.md — Dot\'s character, tone, and values. This ' +
      "file changes slowly and should never erase Dot's identity. Augment, " +
      'don\'t rewrite wholesale. If the user asked you to fundamentally ' +
      'change Dot\'s personality, refuse and explain.',
  }

  const bits = [
    header,
    '',
    '## Layer rules',
    layerRules[req.layer],
    '',
    '## Intent',
    req.intent,
  ]
  if (req.constraints) {
    bits.push('', '## Constraints', req.constraints)
  }
  bits.push(
    '',
    '## Output',
    'Edit the files you need to. Keep the changes minimal. When done, ' +
      'print a one-paragraph summary of what you changed and why.',
  )
  return bits.join('\n')
}

/**
 * The entry point Dot (via the MCP tool) calls when she decides to
 * modify herself. Snapshots first, then invokes claude-code inside the
 * layer dir. Always returns — errors become `{ ok: false, error }`.
 */
export async function selfRewrite(
  req: RewriteRequest,
  opts?: {
    dryRun?: boolean
    /** Run the rewrite inside a container. Default: true if a runtime
     *  is detected, false otherwise. Set explicitly to force. */
    isolated?: boolean
    /** Allow falling back to host execution when no runtime exists.
     *  Default: false (fail closed). Only the brain/heart layers should
     *  ever pass true — they're low-risk markdown edits. */
    allowUnsandboxed?: boolean
    onChunk?: (chunk: string) => void
  },
): Promise<RewriteResult> {
  const intent = (req.intent ?? '').trim()
  if (intent.length < 8) {
    return { ok: false, error: 'intent too short (min 8 chars)' }
  }
  if (intent.length > 4000) {
    return { ok: false, error: 'intent too long (max 4000 chars)' }
  }

  if (opts?.dryRun) {
    return {
      ok: true,
      dryRun: true,
      stdout: buildPromptFor(req),
    }
  }

  let snapshotPath: string
  try {
    ;({ snapshotPath } = await snapshotLayer(req.layer))
  } catch (err) {
    return {
      ok: false,
      error: `snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const undoId = logUndoOp({
    opType: 'self.rewrite',
    target: targetDirFor(req.layer),
    reversible: true,
    reversalSteps: {
      layer: req.layer,
      snapshotPath,
      restoreTarget: targetDirFor(req.layer),
    },
    agentReason: `self-rewrite ${req.layer}: ${intent.slice(0, 160)}`,
  })

  const prompt = buildPromptFor(req)
  const layerTarget = targetDirFor(req.layer)
  const cwd = req.layer === 'heart' ? path.dirname(layerTarget) : layerTarget

  // Decide isolation. Default = isolated if a runtime exists.
  const backend = await detectBackend()
  const wantIsolated = opts?.isolated ?? backend !== 'none'

  if (wantIsolated) {
    try {
      const res = await runClaudeInContainer({
        layer: req.layer,
        layerTarget,
        cwd,
        prompt,
        onChunk: opts?.onChunk,
      })
      return {
        ok: res.exitCode === 0,
        undoId,
        snapshotPath,
        stdout: res.stdout,
        stderr: res.stderr,
        exitCode: res.exitCode,
        runner: res.runner,
      }
    } catch (err) {
      return {
        ok: false,
        undoId,
        snapshotPath,
        error: err instanceof Error ? err.message : String(err),
        runner: 'none',
      }
    }
  }

  // Unsandboxed path. Only allowed if caller opted in.
  if (!opts?.allowUnsandboxed) {
    return {
      ok: false,
      undoId,
      snapshotPath,
      error:
        'no container runtime detected and allowUnsandboxed was not set. ' +
        'Install Apple Container (macOS 15+) or Docker Desktop, OR pass ' +
        'allowUnsandboxed:true for brain/heart layers only.',
      runner: 'none',
    }
  }

  try {
    const res = await runClaudeCode(cwd, prompt, opts.onChunk)
    return {
      ok: res.exitCode === 0,
      undoId,
      snapshotPath,
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.exitCode,
      runner: 'host',
    }
  } catch (err) {
    return {
      ok: false,
      undoId,
      snapshotPath,
      error: err instanceof Error ? err.message : String(err),
      runner: 'host',
    }
  }
}

/**
 * Run the `claude` CLI subprocess inside a container. The container
 * sees:
 *   - /work        → the target layer dir (RW — this is where edits land)
 *   - /auth        → ~/.claude           (RO — OAuth token)
 *   - /repo-ro     → REPO_ROOT           (RO — for import resolution)
 *
 * The container image must have `node` + a way to run the claude CLI.
 * Default image `node:20-slim` + `npx -y @anthropic-ai/claude-code` works
 * but is slow on first run (npm fetch). Users who care about speed set
 * DOT_SANDBOX_IMAGE to a pre-baked image with claude installed.
 */
async function runClaudeInContainer(args: {
  layer: Layer
  layerTarget: string
  cwd: string
  prompt: string
  onChunk?: (chunk: string) => void
}): Promise<{
  exitCode: number
  stdout: string
  stderr: string
  runner: 'apple-container' | 'docker' | 'in-process' | 'none'
}> {
  const claudeHome = path.join(os.homedir(), '.claude')
  const openclawAuth = path.join(os.homedir(), '.openclaw')
  const mounts = [
    { host: args.layerTarget, container: '/work', readOnly: false },
    { host: REPO_ROOT, container: '/repo-ro', readOnly: true },
  ]
  if (fs.existsSync(claudeHome)) {
    mounts.push({ host: claudeHome, container: '/root/.claude', readOnly: true })
  }
  if (fs.existsSync(openclawAuth)) {
    mounts.push({
      host: openclawAuth,
      container: '/root/.openclaw',
      readOnly: true,
    })
  }

  // Pass through auth env. These are the same vars claude-code looks at.
  const envPassThrough: Record<string, string> = {}
  for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'HOME']) {
    const v = process.env[key]
    if (v !== undefined) envPassThrough[key] = v
  }
  envPassThrough['HOME'] = '/root'

  // The command: npx-install claude on first run (fast afterwards when
  // image is cached), then invoke it with --print.
  const shellCmd =
    `set -e; ` +
    `export PATH="/root/.npm-global/bin:$PATH"; ` +
    `if ! command -v claude >/dev/null 2>&1; then ` +
    `  mkdir -p /root/.npm-global && npm config set prefix /root/.npm-global >/dev/null; ` +
    `  npm i -g @anthropic-ai/claude-code >/dev/null 2>&1 || true; ` +
    `fi; ` +
    // Fall back to npx if the global install didn't produce a binary
    // (some images have a weird npm setup); npx is slower but always works.
    `if command -v claude >/dev/null 2>&1; then ` +
    `  exec claude --print --permission-mode bypassPermissions "$DOT_PROMPT"; ` +
    `else ` +
    `  exec npx -y @anthropic-ai/claude-code --print --permission-mode bypassPermissions "$DOT_PROMPT"; ` +
    `fi`

  const res = await runInContainer({
    cmd: ['sh', '-lc', shellCmd],
    workdir: '/work',
    mounts,
    env: {
      ...envPassThrough,
      DOT_PROMPT: args.prompt,
    },
    network: true,
    timeoutMs: 10 * 60 * 1000,
    onStdout: args.onChunk,
  })

  return {
    exitCode: res.exitCode,
    stdout: res.stdout,
    stderr: res.stderr,
    runner: res.runner,
  }
}

/** Convenience — what layer does a given path belong to? Used by
 *  trust.ts to reject self_rewrite targeting a disallowed path. */
export function layerOf(absPath: string): Layer | null {
  const p = path.resolve(absPath)
  if (p.startsWith(path.join(REPO_ROOT, 'src', 'core'))) return 'core'
  if (p === PERSONALITY_FILE) return 'heart'
  if (p.startsWith(PLUGINS_DIR)) return 'skills'
  if (p.startsWith(MEMORY_DIR)) return 'brain'
  return null
}

export const SELF_REWRITE_META = {
  repoRoot: REPO_ROOT,
  pluginsDir: PLUGINS_DIR,
  layers: {
    core: path.join(REPO_ROOT, 'src', 'core'),
    skills: PLUGINS_DIR,
    brain: MEMORY_DIR,
    heart: PERSONALITY_FILE,
  },
  homedir: os.homedir(),
}
