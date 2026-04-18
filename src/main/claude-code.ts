import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

/**
 * Resolve the `claude` CLI binary. Tries common locations since Electron's
 * PATH is typically minimal and doesn't include user shell PATH additions.
 */
function resolveClaudeBinary(): string {
  const candidates = [
    process.env['CLAUDE_BIN'],
    path.join(os.homedir(), '.local/bin/claude'),
    path.join(os.homedir(), '.claude/local/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ].filter(Boolean) as string[]

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {}
  }
  return 'claude' // fall back to PATH
}

export interface ClaudeCodeResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Run Claude Code headlessly in a given directory and return its output.
 * Uses the --print flag which runs a single query non-interactively.
 */
export async function runClaudeCode(
  cwd: string,
  prompt: string,
  onChunk?: (text: string) => void,
): Promise<ClaudeCodeResult> {
  // Expand ~ in cwd
  const resolvedCwd = cwd.startsWith('~')
    ? path.join(os.homedir(), cwd.slice(1))
    : path.resolve(cwd)

  if (!fs.existsSync(resolvedCwd)) {
    throw new Error(`Directory not found: ${resolvedCwd}`)
  }

  const bin = resolveClaudeBinary()

  return new Promise((resolve, reject) => {
    const child = spawn(
      bin,
      ['--print', '--permission-mode', 'bypassPermissions', prompt],
      {
        cwd: resolvedCwd,
        env: {
          ...process.env,
          // Make sure the sub-claude can find node/etc
          PATH: `${process.env['PATH'] ?? ''}:/opt/homebrew/bin:/usr/local/bin:${path.join(
            os.homedir(),
            '.local/bin',
          )}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      stdout += text
      onChunk?.(text)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 })
    })
  })
}
