/**
 * Native accessibility bridge — wraps the compiled nina-ax Swift helper.
 *
 * On first use:
 *   1. Copy assets/native/nina-ax.swift to ~/.nina/bin/nina-ax.swift
 *   2. Compile it with `swiftc` to ~/.nina/bin/nina-ax
 *   3. Run it — the first run triggers macOS's Accessibility TCC prompt
 *
 * The compiled binary outputs JSON to stdout. We parse it and return a
 * compact text representation for the agent.
 */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { NINA_DIR } from './memory.js'

const execFileP = promisify(execFile)

const BIN_DIR = path.join(NINA_DIR, 'bin')
const SRC_PATH = path.join(BIN_DIR, 'nina-ax.swift')
const BIN_PATH = path.join(BIN_DIR, 'nina-ax')

/**
 * Locate the bundled Swift source. In dev, it's in assets/native/nina-ax.swift
 * relative to the repo root. In a packaged build, it ships inside resources.
 */
function findSourceFile(): string | null {
  // Walk up from this file's directory looking for assets/native/nina-ax.swift
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.resolve(__dirname, '../../assets/native/nina-ax.swift'),
    path.resolve(__dirname, '../../../assets/native/nina-ax.swift'),
    path.resolve(process.cwd(), 'assets/native/nina-ax.swift'),
    // Packaged build (electron-vite copies to resources/)
    path.resolve(process.resourcesPath ?? '', 'assets/native/nina-ax.swift'),
  ]
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      // ignore
    }
  }
  return null
}

let compilePromise: Promise<void> | null = null

/**
 * Ensure the helper binary exists and is up to date with the source. Compiles
 * with swiftc on first run or whenever the source is newer than the binary.
 */
async function ensureCompiled(): Promise<void> {
  if (compilePromise) return compilePromise
  compilePromise = (async () => {
    fs.mkdirSync(BIN_DIR, { recursive: true })

    const sourceFile = findSourceFile()
    if (!sourceFile) {
      throw new Error('nina-ax.swift source not found')
    }

    // Copy source into ~/.nina/bin for provenance
    const dstSrc = SRC_PATH
    try {
      fs.copyFileSync(sourceFile, dstSrc)
    } catch (err) {
      console.warn('[nina-ax] Failed to copy source:', err)
    }

    // Skip compile if binary exists and is newer than source
    try {
      const srcStat = fs.statSync(dstSrc)
      const binStat = fs.statSync(BIN_PATH)
      if (binStat.mtimeMs >= srcStat.mtimeMs) return
    } catch {
      // binary doesn't exist — compile
    }

    // Locate swiftc (usually at /usr/bin/swiftc on systems with command-line tools)
    const swiftc = fs.existsSync('/usr/bin/swiftc')
      ? '/usr/bin/swiftc'
      : 'swiftc'

    await execFileP(
      swiftc,
      ['-O', '-o', BIN_PATH, dstSrc],
      { timeout: 60_000 },
    )

    // Make sure it's executable
    fs.chmodSync(BIN_PATH, 0o755)
  })().catch((err) => {
    compilePromise = null
    throw err
  })
  return compilePromise
}

/**
 * Run the helper. Returns the parsed JSON. Throws on spawn failures, not on
 * {error:...} payloads — those are returned as-is so the caller can present
 * a helpful message.
 */
async function runHelper(args: string[] = []): Promise<Record<string, unknown>> {
  await ensureCompiled()

  return new Promise((resolve, reject) => {
    const child = spawn(BIN_PATH, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      if (code !== 0 && !stdout) {
        return reject(
          new Error(
            `nina-ax exited with code ${code}${stderr ? `: ${stderr.slice(0, 200)}` : ''}`,
          ),
        )
      }
      try {
        const parsed = JSON.parse(stdout.trim())
        resolve(parsed)
      } catch (err) {
        reject(
          new Error(
            `failed to parse nina-ax output: ${err}. stdout: ${stdout.slice(0, 200)}`,
          ),
        )
      }
    })
  })
}

export interface AxCheckResult {
  trusted: boolean
  compiled: boolean
  error?: string
}

/** Check if accessibility is granted AND the helper is compiled. */
export async function checkAccessibility(): Promise<AxCheckResult> {
  try {
    await ensureCompiled()
  } catch (err) {
    return {
      trusted: false,
      compiled: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
  try {
    const result = await runHelper(['--check'])
    return { trusted: Boolean(result['trusted']), compiled: true }
  } catch (err) {
    return {
      trusted: false,
      compiled: true,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export interface NativeWindowRead {
  app: string
  bundle: string
  pid: number
  nodeCount: number
  tree: unknown
  error?: string
  message?: string
}

/**
 * Read the accessibility tree of the frontmost native-app window.
 * Returns either the tree or an error object.
 */
export async function readNativeWindow(options?: {
  depth?: number
  maxNodes?: number
}): Promise<NativeWindowRead> {
  const args: string[] = ['read']
  if (options?.depth !== undefined) args.push('--depth', String(options.depth))
  if (options?.maxNodes !== undefined) args.push('--max-nodes', String(options.maxNodes))
  const result = await runHelper(args)
  return result as unknown as NativeWindowRead
}

export interface AxActionResult {
  ok?: boolean
  error?: string
  message?: string
  method?: string
  role?: string
  title?: string
  length?: number
}

/**
 * Click an element in the frontmost app. Prefer role + title; fall back
 * to explicit x/y coordinates.
 */
export async function clickNative(params: {
  role?: string
  title?: string
  x?: number
  y?: number
}): Promise<AxActionResult> {
  const args: string[] = ['click']
  if (params.role) args.push('--role', params.role)
  if (params.title) args.push('--title', params.title)
  if (params.x !== undefined) args.push('--x', String(params.x))
  if (params.y !== undefined) args.push('--y', String(params.y))
  const result = await runHelper(args)
  return result as unknown as AxActionResult
}

/**
 * Type text into a field. Same addressing options as clickNative.
 */
export async function typeNative(params: {
  text: string
  role?: string
  title?: string
  x?: number
  y?: number
}): Promise<AxActionResult> {
  const args: string[] = ['type', '--text', params.text]
  if (params.role) args.push('--role', params.role)
  if (params.title) args.push('--title', params.title)
  if (params.x !== undefined) args.push('--x', String(params.x))
  if (params.y !== undefined) args.push('--y', String(params.y))
  const result = await runHelper(args)
  return result as unknown as AxActionResult
}

/**
 * Press a keyboard key system-wide (Return, Escape, Tab, etc.).
 */
export async function pressNativeKey(key: string): Promise<AxActionResult> {
  const result = await runHelper(['press', '--key', key])
  return result as unknown as AxActionResult
}

/**
 * Render a JSON AX tree as a compact, Claude-friendly outline. Recursive.
 */
export function formatAxTree(result: NativeWindowRead): string {
  if (result.error) {
    return `AX error: ${result.error}${result.message ? ' — ' + result.message : ''}`
  }

  const lines: string[] = []
  lines.push(`app: ${result.app} (${result.bundle})`)
  lines.push(`nodes: ${result.nodeCount}`)
  lines.push('')

  function walk(node: Record<string, unknown>, depth: number): void {
    const indent = '  '.repeat(depth)
    const role = String(node['role'] ?? '').replace(/^AX/, '')
    const parts: string[] = [role]
    const title = node['title'] ?? node['description'] ?? node['roledescription']
    if (title) parts.push(`"${String(title).slice(0, 80)}"`)
    const value = node['value']
    if (value && typeof value !== 'boolean') parts.push(`[${String(value).slice(0, 60)}]`)
    const placeholder = node['placeholdervalue']
    if (placeholder) parts.push(`placeholder="${String(placeholder).slice(0, 40)}"`)
    if (node['selected'] === true) parts.push('(selected)')
    if (node['enabled'] === false) parts.push('(disabled)')
    lines.push(indent + parts.join(' '))

    const children = node['children']
    if (Array.isArray(children)) {
      for (const child of children) {
        if (typeof child === 'object' && child !== null) {
          walk(child as Record<string, unknown>, depth + 1)
        }
      }
    }
  }

  if (typeof result.tree === 'object' && result.tree !== null) {
    walk(result.tree as Record<string, unknown>, 0)
  }

  // Soft cap output length
  const full = lines.join('\n')
  if (full.length > 8000) {
    return full.slice(0, 8000) + '\n… (truncated)'
  }
  return full
}
