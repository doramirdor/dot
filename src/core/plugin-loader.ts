/**
 * core/plugin-loader.ts — load user + community plugins from ~/.dot/plugins.
 *
 * Each plugin lives at:
 *   ~/.dot/plugins/<name>/plugin.js         (ESM or CJS, user-authored or built)
 *   ~/.dot/plugins/<name>/plugin.mjs        (alternative name)
 *   ~/.dot/plugins/<name>/package.json      (optional, read for `main` and metadata)
 *
 * A plugin exports an object matching the `DotPlugin` interface below.
 * The key piece is `tools: ToolDef[]` — each tool has the same shape as
 * the tuple `(name, description, zodSchema, handler)` used in
 * mcp-tools.ts, but expressed as an object so plugin authors don't need
 * to import `tool()` from the Agent SDK.
 *
 * Safety:
 *   - We load plugins with dynamic import. No sandboxing today (M6
 *     sandbox only covers self-rewrite subprocesses, not in-process
 *     plugin code). The trust layer classifies every plugin tool as
 *     `confirm` by default — plugins cannot self-declare auto-tier.
 *   - Scanning is best-effort: a broken plugin prints a warning and
 *     is skipped, never crashes Dot.
 *   - All plugin-contributed tools are namespaced under
 *     `mcp__nina__plugin__<pluginName>__<toolName>` so they can't
 *     collide with built-ins.
 *
 * This module is consumed by mcp-tools.ts at MCP-server-build time.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z, type ZodRawShape } from 'zod'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { NINA_DIR } from './memory.js'

export const PLUGINS_DIR = path.join(NINA_DIR, 'plugins')

export interface PluginToolDef {
  /** Local tool name. Final MCP name: `mcp__nina__plugin__<plugin>__<this>`. */
  name: string
  /** Human-facing description (rendered into the agent's tool list). */
  description: string
  /** Zod raw shape, e.g. `{ query: z.string() }` — NOT a full `z.object()`. */
  inputSchema: ZodRawShape
  /** The handler receives the parsed input and returns an MCP result. */
  handler: (input: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  }>
}

export interface DotPlugin {
  /** Stable id used in the tool prefix. a-z0-9 only, no slashes. */
  name: string
  /** Semver-ish version string for the dashboard. */
  version?: string
  /** One-line description shown in the tool list / dashboard. */
  description?: string
  /** Optional setup hook — called once at load time. Return false to
   *  disable the plugin (e.g. missing credentials). */
  init?: () => Promise<boolean> | boolean
  /** The tools this plugin contributes. */
  tools: PluginToolDef[]
}

export interface LoadedPlugin {
  plugin: DotPlugin
  sourcePath: string
  loadedAt: string
  error?: string
  enabled: boolean
}

const loaded: LoadedPlugin[] = []

export function pluginsDir(): string {
  return PLUGINS_DIR
}

export function ensurePluginsDir(): void {
  try {
    fs.mkdirSync(PLUGINS_DIR, { recursive: true })
    const readme = path.join(PLUGINS_DIR, 'README.md')
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme, PLUGIN_README, 'utf8')
    }
  } catch {
    // ignore — plugin loader is best-effort
  }
}

async function tryLoadPlugin(dir: string): Promise<LoadedPlugin | null> {
  const candidates = ['plugin.mjs', 'plugin.js', 'index.mjs', 'index.js']
  let sourcePath: string | null = null
  // If there's a package.json, honor its main.
  const pkgPath = path.join(dir, 'package.json')
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { main?: string }
      if (pkg.main) {
        const p = path.join(dir, pkg.main)
        if (fs.existsSync(p)) sourcePath = p
      }
    } catch {
      // ignore
    }
  }
  if (!sourcePath) {
    for (const c of candidates) {
      const p = path.join(dir, c)
      if (fs.existsSync(p)) {
        sourcePath = p
        break
      }
    }
  }
  if (!sourcePath) return null

  try {
    const mod = (await import(pathToFileURL(sourcePath).href)) as { default?: unknown }
    const candidate = (mod.default ?? mod) as unknown
    if (!isDotPlugin(candidate)) {
      return {
        plugin: { name: path.basename(dir), tools: [] },
        sourcePath,
        loadedAt: new Date().toISOString(),
        error: 'module did not export a valid DotPlugin (need { name, tools: [] })',
        enabled: false,
      }
    }
    const enabled = candidate.init ? await Promise.resolve(candidate.init()) !== false : true
    return {
      plugin: candidate,
      sourcePath,
      loadedAt: new Date().toISOString(),
      enabled,
    }
  } catch (err) {
    return {
      plugin: { name: path.basename(dir), tools: [] },
      sourcePath,
      loadedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
      enabled: false,
    }
  }
}

function isDotPlugin(x: unknown): x is DotPlugin {
  if (!x || typeof x !== 'object') return false
  const y = x as Record<string, unknown>
  if (typeof y['name'] !== 'string') return false
  if (!Array.isArray(y['tools'])) return false
  return (y['tools'] as unknown[]).every(
    (t) =>
      !!t &&
      typeof t === 'object' &&
      typeof (t as Record<string, unknown>)['name'] === 'string' &&
      typeof (t as Record<string, unknown>)['description'] === 'string' &&
      typeof (t as Record<string, unknown>)['handler'] === 'function',
  )
}

export async function loadAllPlugins(): Promise<LoadedPlugin[]> {
  ensurePluginsDir()
  loaded.length = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
  } catch {
    return []
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    if (ent.name.startsWith('.')) continue
    const full = path.join(PLUGINS_DIR, ent.name)
    const res = await tryLoadPlugin(full)
    if (res) loaded.push(res)
  }
  return loaded
}

export function listLoadedPlugins(): LoadedPlugin[] {
  return [...loaded]
}

/**
 * Convert loaded plugins into SDK `tool()` entries ready to merge into
 * the MCP server's tools array. Prefixes every tool name with the
 * plugin id so they can't collide with built-ins or each other.
 */
export function buildPluginTools(): ReturnType<typeof tool>[] {
  const out: ReturnType<typeof tool>[] = []
  for (const lp of loaded) {
    if (!lp.enabled) continue
    for (const td of lp.plugin.tools) {
      const prefixed = `plugin__${lp.plugin.name}__${td.name}`
      // Wrap the handler to add safety — plugins shouldn't be able to
      // throw into the SDK's internals.
      const safeHandler = async (input: unknown) => {
        try {
          return await td.handler((input ?? {}) as Record<string, unknown>)
        } catch (err) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `plugin ${lp.plugin.name} tool ${td.name} threw: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              },
            ],
          }
        }
      }
      out.push(
        tool(
          prefixed,
          `[plugin: ${lp.plugin.name}] ${td.description}`,
          td.inputSchema as ZodRawShape,
          safeHandler as unknown as Parameters<typeof tool>[3],
        ),
      )
    }
  }
  return out
}

const PLUGIN_README = `# Dot plugins

Drop a folder here (\`~/.dot/plugins/<name>/\`) containing either a
\`plugin.mjs\`, \`plugin.js\`, or a \`package.json\` pointing at your
entry file. The module should default-export a \`DotPlugin\`:

\`\`\`js
import { z } from 'zod'

export default {
  name: 'hello-world',            // a-z0-9 only; no slashes
  version: '0.1.0',
  description: 'says hello',
  tools: [
    {
      name: 'greet',
      description: 'Greet the user by name.',
      inputSchema: { name: z.string() },
      async handler({ name }) {
        return { content: [{ type: 'text', text: \`hello, \${name}!\` }] }
      },
    },
  ],
}
\`\`\`

Every plugin-contributed tool is exposed to Dot's agent as
\`mcp__nina__plugin__<pluginName>__<toolName>\` and defaults to
the \`confirm\` trust tier. Plugins cannot declare themselves auto-tier;
the user approves the first call.

Restart Dot after adding a plugin. (Hot reload lives in M4 of the
roadmap and isn't wired yet.)
`
