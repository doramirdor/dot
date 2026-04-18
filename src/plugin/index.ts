/**
 * Dot macOS Bridge — OpenClaw plugin entry point.
 *
 * Exposes Dot's native macOS capabilities (accessibility, screen, system,
 * browser, reversible file ops, Shortcuts, presence, app management,
 * Calendar, Mail) as tools available to any OpenClaw agent.
 *
 * Install:   openclaw plugins install -l ./src/plugin
 * Verify:    openclaw plugins inspect dot-mac
 */
// @ts-ignore — OpenClaw is installed globally, not as a local npm dep.
// When loaded by OpenClaw's jiti runtime, this resolves correctly.
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'
import { createDotTools } from './tool-bridge.js'
import { startService, stopService, serviceStatus } from './service.js'

export default definePluginEntry({
  id: 'dot-mac',
  name: 'Dot macOS Bridge',
  description:
    'Native macOS capabilities for OpenClaw agents: accessibility control, screen capture, system settings, persistent browser, reversible file ops, Shortcuts, app management, Calendar, Mail, and presence detection.',

  register(api: any) {
    const tools = createDotTools()
    const log = api.logger

    // Register all tools
    for (const tool of tools) {
      api.registerTool(tool as any)
    }
    log.info(`[dot-mac] Registered ${tools.length} macOS tools`)

    // Register lifecycle service
    api.registerService({
      id: 'dot-mac-lifecycle',
      label: 'Dot macOS Lifecycle',
      async start() {
        const pluginConfig = (api.pluginConfig ?? {}) as Record<string, unknown>
        await startService({
          enableScreenWatcher: pluginConfig.enableScreenWatcher as boolean | undefined,
          screenWatcherIntervalMs: pluginConfig.screenWatcherIntervalMs as number | undefined,
          logger: log,
        })
      },
      async stop() {
        stopService()
        log.info('[dot-mac] Service stopped')
      },
      async status() {
        const s = await serviceStatus()
        return {
          healthy: s.axCompiled,
          details: {
            axCompiled: s.axCompiled,
            axTrusted: s.axTrusted,
            installedApps: s.appsScanned,
            screenWatcher: s.screenWatcherActive ? 'running' : 'stopped',
          },
        }
      },
    })

    // Register /dot-status command
    api.registerCommand({
      name: 'dot-status',
      description: "Show Dot macOS Bridge health: AX permission, app index, screen watcher status",
      async handler() {
        const s = await serviceStatus()
        const lines = [
          '🖥  Dot macOS Bridge Status',
          `   AX binary: ${s.axCompiled ? '✅ compiled' : '❌ not compiled'}`,
          `   AX trusted: ${s.axTrusted ? '✅ yes' : '⚠️  no — grant in System Settings → Accessibility'}`,
          `   App index: ${s.appsScanned} apps`,
          `   Screen watcher: ${s.screenWatcherActive ? '🟢 running' : '⚪ stopped'}`,
        ]
        return lines.join('\n')
      },
    })
  },
})
