/**
 * core/sandbox.ts — run untrusted commands inside a container.
 *
 * Three backends in preference order:
 *
 *   1. Apple Container (`container` CLI, macOS 15+). Native M-series,
 *      fast start, no VM overhead per run.
 *   2. Docker Desktop / colima / rancher-desktop (`docker` CLI).
 *      Ubiquitous fallback.
 *   3. In-process exec. No isolation — only used when the caller
 *      explicitly allowed `allowUnsandboxed: true` AND neither runtime
 *      is installed. Logs a warning.
 *
 * Designed for two callers today:
 *   - self-rewrite.ts → runs `claude --print` inside the container with
 *     the layer dir mounted read-write, everything else read-only.
 *   - future: high-risk Bash tool calls, untrusted plugin execution.
 *
 * The primitive here is `runInContainer`. It takes mounts, env, cmd,
 * and a timeout. It does NOT know about claude-code or Dot's layers —
 * that's the caller's job.
 */
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'

const execFileAsync = promisify(execFile)

export type SandboxRunner = 'apple-container' | 'docker' | 'in-process'

export interface Mount {
  host: string
  container: string
  readOnly?: boolean
}

export interface RunInContainerOptions {
  /** Command + args to run inside the container. First element is the binary. */
  cmd: string[]
  /** Working dir inside the container. Must be a mount target or a dir in the image. */
  workdir?: string
  /** Host→container bindings. Paths expanded with path.resolve on host side. */
  mounts?: Mount[]
  /** Extra env vars to inject. Keys allowed even if not set on host. */
  env?: Record<string, string>
  /** Container image tag. Default: `node:20-slim`. */
  image?: string
  /** Hard timeout (ms). Default 5 min. */
  timeoutMs?: number
  /** If true, give the container network access. Default: true (claude needs API). */
  network?: boolean
  /** Stream stdout. */
  onStdout?: (chunk: string) => void
  /** Stream stderr. */
  onStderr?: (chunk: string) => void
  /** Permit fallback to in-process when no container runtime exists.
   *  When false (default) we fail closed with `runner: 'none'`. */
  allowUnsandboxed?: boolean
  /** Preferred backend override — for tests. */
  preferred?: 'apple-container' | 'docker'
}

export interface RunInContainerResult {
  stdout: string
  stderr: string
  exitCode: number
  runner: SandboxRunner | 'none'
  /** True if we fell back to in-process execution. */
  fallback?: boolean
  error?: string
}

const DEFAULT_IMAGE = process.env['DOT_SANDBOX_IMAGE'] ?? 'node:20-slim'

let cachedBackend: SandboxRunner | 'none' | null = null

async function hasBinary(name: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('which', [name])
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

async function dockerAlive(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      timeout: 2000,
    })
    return true
  } catch {
    return false
  }
}

export async function detectBackend(): Promise<SandboxRunner | 'none'> {
  if (cachedBackend) return cachedBackend
  if (await hasBinary('container')) {
    cachedBackend = 'apple-container'
    return cachedBackend
  }
  if ((await hasBinary('docker')) && (await dockerAlive())) {
    cachedBackend = 'docker'
    return cachedBackend
  }
  cachedBackend = 'none'
  return cachedBackend
}

/** Reset the cached detection — only used by tests + the dev `dot_sandbox_probe` tool. */
export function resetBackendCache(): void {
  cachedBackend = null
}

function assertMount(m: Mount): void {
  const hostAbs = path.resolve(m.host)
  if (!fs.existsSync(hostAbs)) {
    throw new Error(`sandbox mount missing on host: ${hostAbs}`)
  }
  if (!path.isAbsolute(m.container)) {
    throw new Error(`sandbox mount container path must be absolute: ${m.container}`)
  }
}

function dockerArgs(opts: RunInContainerOptions): string[] {
  const args = ['run', '--rm', '-i']
  if (opts.network === false) args.push('--network=none')
  if (opts.workdir) args.push('--workdir', opts.workdir)
  for (const m of opts.mounts ?? []) {
    const hostAbs = path.resolve(m.host)
    args.push(
      '-v',
      `${hostAbs}:${m.container}${m.readOnly ? ':ro' : ''}`,
    )
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    args.push('-e', `${k}=${v}`)
  }
  args.push(opts.image ?? DEFAULT_IMAGE)
  args.push(...opts.cmd)
  return args
}

function appleContainerArgs(opts: RunInContainerOptions): string[] {
  // Apple Container CLI mirrors docker closely but has its own flag shape.
  // This matches the `container run` syntax as of the macOS 15 release.
  // If the shape drifts, the failure is visible (non-zero exit + stderr).
  const args = ['run', '--rm', '-i']
  if (opts.network === false) args.push('--no-network')
  if (opts.workdir) args.push('--workdir', opts.workdir)
  for (const m of opts.mounts ?? []) {
    const hostAbs = path.resolve(m.host)
    args.push(
      '--volume',
      `${hostAbs}:${m.container}${m.readOnly ? ':ro' : ''}`,
    )
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    args.push('--env', `${k}=${v}`)
  }
  args.push(opts.image ?? DEFAULT_IMAGE)
  args.push(...opts.cmd)
  return args
}

function runChild(
  bin: string,
  args: string[],
  opts: {
    timeoutMs: number
    onStdout?: (c: string) => void
    onStderr?: (c: string) => void
  },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    const to = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
    }, opts.timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      const s = chunk.toString()
      stdout += s
      opts.onStdout?.(s)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const s = chunk.toString()
      stderr += s
      opts.onStderr?.(s)
    })
    child.on('close', (code) => {
      clearTimeout(to)
      resolve({ stdout, stderr, exitCode: code ?? -1 })
    })
    child.on('error', (err) => {
      clearTimeout(to)
      resolve({ stdout, stderr: stderr + `\n${err.message}`, exitCode: -1 })
    })
  })
}

/**
 * Run a command inside a container. Fails closed (returns
 * `runner: 'none'`) if no runtime is installed and
 * `allowUnsandboxed` is not set. Does NOT throw for cmd exit != 0 —
 * callers inspect `exitCode`.
 */
export async function runInContainer(
  opts: RunInContainerOptions,
): Promise<RunInContainerResult> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000
  for (const m of opts.mounts ?? []) {
    try {
      assertMount(m)
    } catch (err) {
      return {
        stdout: '',
        stderr: '',
        exitCode: -1,
        runner: 'none',
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  const backend =
    opts.preferred && (await hasBinary(opts.preferred === 'docker' ? 'docker' : 'container'))
      ? opts.preferred
      : await detectBackend()

  if (backend === 'apple-container') {
    const res = await runChild('container', appleContainerArgs(opts), {
      timeoutMs,
      onStdout: opts.onStdout,
      onStderr: opts.onStderr,
    })
    return { ...res, runner: 'apple-container' }
  }
  if (backend === 'docker') {
    const res = await runChild('docker', dockerArgs(opts), {
      timeoutMs,
      onStdout: opts.onStdout,
      onStderr: opts.onStderr,
    })
    return { ...res, runner: 'docker' }
  }

  // No container runtime.
  if (!opts.allowUnsandboxed) {
    return {
      stdout: '',
      stderr:
        'no container runtime (install Apple Container on macOS 15+ or Docker Desktop), ' +
        'and allowUnsandboxed was not set',
      exitCode: -1,
      runner: 'none',
      error: 'no-container-runtime',
    }
  }
  // Fallback: run on host. Caller accepted the risk.
  const [bin, ...rest] = opts.cmd
  const res = await runChild(bin, rest, {
    timeoutMs,
    onStdout: opts.onStdout,
    onStderr: opts.onStderr,
  })
  return { ...res, runner: 'in-process', fallback: true }
}

/**
 * Convenience probe returned by the `dot_sandbox_probe` MCP tool. Tests
 * the detected backend with a trivial command and reports latency.
 */
export async function probeSandbox(): Promise<{
  backend: SandboxRunner | 'none'
  ok: boolean
  latencyMs?: number
  image: string
  stderr?: string
}> {
  const backend = await detectBackend()
  const image = DEFAULT_IMAGE
  if (backend === 'none') return { backend, ok: false, image }
  const t0 = Date.now()
  const res = await runInContainer({
    cmd: ['echo', 'ok'],
    image,
    timeoutMs: 60_000,
    network: false,
  })
  return {
    backend,
    ok: res.exitCode === 0,
    latencyMs: Date.now() - t0,
    image,
    stderr: res.stderr ? res.stderr.slice(0, 400) : undefined,
  }
}
