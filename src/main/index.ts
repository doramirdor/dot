import {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  Menu,
  Tray,
  nativeImage,
  shell,
  globalShortcut,
} from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { loadAnthropicToken, applyAnthropicCredential } from '../core/config.js'
import { resolveActiveProvider } from '../core/providers.js'
import { openProviderSetupWindow } from './provider-setup.js'
import { runAgent, type AgentHandle, type RunOptions } from '../core/agent.js'
import { closeBrowser } from '../core/browser.js'
import {
  ensureDotDirMigrated,
  ensureMemoryDir,
  isFirstRun,
  ONBOARDING_PROMPT,
  MEMORY_DIR,
  MINDMAP_FILE,
  DOT_DIR,
  NINA_DIR,
} from '../core/memory.js'
import {
  startObservationLoop,
  stopObservationLoop,
  pauseObservation,
  resumeObservation,
  isPaused,
} from '../core/observation.js'
import {
  scheduleDailyReflection,
  stopDailyReflection,
  maybeSeedFarewell,
  runReflection,
} from '../core/reflection.js'
import { scheduleDailyDiary, stopDailyDiary, runDiary } from '../core/diary.js'
import { runMorningRitual } from '../core/morning.js'
import {
  ensureSoulDirs,
  rolloverIfNewDay,
  shouldFireMorningRitual,
  getTokensRemaining,
  loadFarewellMessage,
  markQuitGraceful,
  touchLastSeen,
  isGrown,
  markGrown,
  isOnboardingActive,
  startOnboarding,
  endOnboarding,
  incrementOnboardingTurn,
  getOnboardingTurnCount,
  DIARY_DIR,
} from '../core/soul.js'
import { resolvePermissionRequest, cancelAllPending } from '../core/permission-bus.js'
import {
  isCapabilitiesConfigured,
  openCapabilitiesWindow,
} from './capabilities.js'
import { initSemanticMemory } from '../core/semantic-memory.js'
import { startConsolidationLoop, stopConsolidationLoop } from '../core/consolidation.js'
import { initRL, stopRL } from '../core/rl/index.js'
import { loadAllPlugins } from '../core/plugin-loader.js'
import { registerChannel } from '../core/channels/index.js'
import { createTelegramChannel } from '../core/channels/telegram-channel.js'
import {
  createDesktopChannel,
  registerDesktopHandlers,
} from '../core/channels/desktop-channel.js'
import { setProgressCallback } from '../core/embed.js'
import { startClipboardWatcher, stopClipboardWatcher } from '../core/clipboard.js'
import { sendNotification } from '../core/notify.js'
import { ensureConfigFile, loadConfig } from '../core/config.js'
import {
  startScreenWatcher,
  stopScreenWatcher,
  pauseScreenWatcher,
  resumeScreenWatcher,
  isScreenWatcherPaused,
} from '../core/screen-watcher.js'
import { startMissionSupervisor, stopMissionSupervisor, listMissions } from '../core/missions.js'
import {
  startCronSupervisor,
  stopCronSupervisor,
  listTasks as cronListTasks,
  createTask as cronCreateTask,
  updateTask as cronUpdateTask,
} from '../core/cron.js'
import { migrateAll, formatReports } from '../core/migrate.js'
import { startTelegram, stopTelegram, pushToTelegram, readPrimaryChatId } from '../core/telegram.js'
import { shouldPushProactiveToPhone } from '../core/presence.js'
import { logEvent } from '../core/db.js'
import { scanApps } from '../core/app-index.js'
import { registerWindowHandlers } from '../core/window-bus.js'
import { stopAllWatches } from '../core/watch.js'
import {
  speak as voiceSpeak,
  stopSpeaking as voiceStopSpeaking,
  transcribe as voiceTranscribe,
  isVoiceEnabled,
  enableVoice,
  disableVoice,
  getVoiceConfig,
  setSayVoice,
  setSayRate,
  listSayVoices,
  connectGroq as voiceConnectGroq,
  enableGroqStt,
  disableGroqStt,
  disconnectGroq,
  setVoiceProgressCallback,
  type VoiceContext,
} from '../core/voice.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let win: BrowserWindow | null = null
let tray: Tray | null = null
let currentAgent: AgentHandle | null = null

// Queue of user messages that arrived while the agent was busy. Drained
// one-at-a-time after each run completes. Abort clears the queue.
interface QueuedPrompt {
  prompt: string
  preamble?: string
  runOpts?: import('../core/agent.js').RunOptions
}
const promptQueue: QueuedPrompt[] = []

function drainPromptQueue() {
  const next = promptQueue.shift()
  if (!next) return
  win?.webContents.send('pet:queue-size', promptQueue.length)
  void runPrompt(next.prompt, next.preamble, next.runOpts)
}

const WIN_WIDTH = 380
const WIN_HEIGHT = 560
const WINDOW_STATE_FILE = path.join(NINA_DIR, 'window.json')

// ----------- window position persistence -----------

interface WindowState {
  x: number
  y: number
}

function loadWindowState(): WindowState | null {
  try {
    if (!fs.existsSync(WINDOW_STATE_FILE)) return null
    const raw = fs.readFileSync(WINDOW_STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw) as WindowState
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

function saveWindowState() {
  if (!win) return
  try {
    const [x, y] = win.getPosition()
    fs.mkdirSync(NINA_DIR, { recursive: true })
    fs.writeFileSync(WINDOW_STATE_FILE, JSON.stringify({ x, y }), 'utf8')
  } catch {
    // ignore
  }
}

function clampToScreen(x: number, y: number): { x: number; y: number } {
  const displays = screen.getAllDisplays()
  // Ensure the window origin is inside at least one display.
  for (const d of displays) {
    const { x: dx, y: dy, width, height } = d.workArea
    if (
      x >= dx - 20 &&
      x < dx + width - 40 &&
      y >= dy - 20 &&
      y < dy + height - 40
    ) {
      return { x, y }
    }
  }
  const fallback = screen.getPrimaryDisplay().workArea
  return {
    x: fallback.x + fallback.width - WIN_WIDTH - 24,
    y: fallback.y + fallback.height - WIN_HEIGHT - 24,
  }
}

// ----------- window creation -----------

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay()
  const saved = loadWindowState()
  const pos = saved
    ? clampToScreen(saved.x, saved.y)
    : {
        x: workArea.x + workArea.width - WIN_WIDTH - 24,
        y: workArea.y + workArea.height - WIN_HEIGHT - 24,
      }

  win = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    x: pos.x,
    y: pos.y,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true,
    roundedCorners: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  if (process.env['NINA_DEVTOOLS']) {
    win.webContents.openDevTools({ mode: 'detach' })
  }

  // Persist position after moves (debounced).
  let saveTimer: NodeJS.Timeout | null = null
  win.on('moved', () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(saveWindowState, 400)
  })
}

// ----------- tray menu -----------

function rebuildTrayMenu() {
  if (!tray) return
  const activeMissions = listMissions().filter((m) => m.status === 'active')
  const missionLabel =
    activeMissions.length === 0
      ? 'No active missions'
      : `${activeMissions.length} active mission${activeMissions.length === 1 ? '' : 's'}`
  const menu = Menu.buildFromTemplate([
    { label: win?.isVisible() ? 'Hide Dot' : 'Show Dot', click: () => toggleWindow() },
    { type: 'separator' },
    { label: 'Onboard me', click: () => runOnboarding() },
    { label: 'Read her diary', click: () => shell.openPath(DIARY_DIR) },
    { label: 'Show memory folder', click: () => shell.openPath(MEMORY_DIR) },
    { label: 'Show mind map', click: () => openMindMap() },
    { type: 'separator' },
    { label: missionLabel, enabled: false },
    { type: 'separator' },
    {
      label: 'Stats',
      click: async () => {
        if (!win) return
        showWindow()
        win.webContents.send('pet:clear')
        win.webContents.send('pet:state', 'thinking')
        // Trigger the token_stats tool via a normal prompt
        await runPrompt('show me my token stats')
      },
    },
    {
      label: 'Manage capabilities',
      click: () => openCapabilitiesWindow(() => rebuildTrayMenu()),
    },
    {
      label: 'Setup provider…',
      click: () => {
        void ensureProviderReady(true).then((ok) => {
          if (ok) {
            win?.webContents.send('pet:stream', 'provider saved ✓')
          }
        })
      },
    },
    {
      label: 'Reflect now',
      click: async () => {
        tray?.setToolTip('Dot · reflecting…')
        const result = await runReflection()
        if (result.error) tray?.setToolTip(`Dot · reflection failed`)
        else if (result.summary) tray?.setToolTip(`Dot · ${result.summary}`)
      },
    },
    {
      label: 'Write diary now',
      click: async () => {
        tray?.setToolTip('Dot · writing diary…')
        const result = await runDiary()
        tray?.setToolTip(result.error ? `Dot · diary failed` : `Dot · diary written ✓`)
      },
    },
    { type: 'separator' },
    {
      label: isPaused() ? 'Resume observation' : 'Pause observation',
      click: () => {
        if (isPaused()) resumeObservation()
        else pauseObservation()
        rebuildTrayMenu()
      },
    },
    {
      label: isScreenWatcherPaused() ? 'Resume screen watcher' : 'Pause screen watcher',
      click: () => {
        if (isScreenWatcherPaused()) resumeScreenWatcher()
        else pauseScreenWatcher()
        rebuildTrayMenu()
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ])
  tray.setContextMenu(menu)
}

// Dot's public-facing state, shown in the menu bar.
type DotState = 'idle' | 'thinking' | 'talking' | 'alert'
let ninaState: DotState = 'idle'

/**
 * Update the menu bar glyph based on Dot's state and any active work.
 * The prefix character acts as a live status indicator without needing
 * bundled PNG icons.
 */
function updateTrayGlyph() {
  if (!tray) return
  const missionCount = listMissions().filter((m) => m.status === 'active').length
  const missionSuffix = missionCount > 0 ? ` ${missionCount}·` : ''

  let title: string
  switch (ninaState) {
    case 'thinking':
      title = `◌  D${missionSuffix}` // dotted circle = processing
      break
    case 'talking':
      title = `◉  D${missionSuffix}` // filled = active speech
      break
    case 'alert':
      title = `●  D${missionSuffix}` // solid dot = attention
      break
    case 'idle':
    default:
      title = `◯  D${missionSuffix}` // empty circle = calm
  }
  tray.setTitle(title)
}

function setDotState(state: DotState) {
  ninaState = state
  updateTrayGlyph()
}

function createTray() {
  const image = nativeImage.createEmpty()
  tray = new Tray(image)
  rebuildTrayMenu()
  updateTrayGlyph()
}

function showWindow() {
  if (!win) return
  win.show()
  win.focus()
  rebuildTrayMenu()
}

function hideWindow() {
  if (!win) return
  win.hide()
  rebuildTrayMenu()
}

function toggleWindow() {
  if (!win) return
  if (win.isVisible()) hideWindow()
  else showWindow()
}

// ----------- mindmap viewer -----------

function openMindMap() {
  try {
    if (!fs.existsSync(MINDMAP_FILE)) {
      ensureMemoryDir()
    }
    const md = fs.readFileSync(MINDMAP_FILE, 'utf8')
    const match = md.match(/```mermaid\s*([\s\S]*?)```/)
    const diagram = match?.[1]?.trim() ?? 'mindmap\n  root((you))\n    unknown'

    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Dot · Mind Map</title>
<style>
  body {
    margin: 0;
    background: #1a1a2e;
    color: #fffdf5;
    font-family: -apple-system, sans-serif;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 40px 20px;
  }
  h1 { font-weight: 400; margin: 0 0 20px; color: #9fe0f5; }
  .card {
    background: #fffdf5;
    color: #1a1a2e;
    border-radius: 12px;
    padding: 24px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    max-width: 1000px;
    width: 100%;
  }
  .mermaid { display: flex; justify-content: center; }
  footer { margin-top: 24px; font-size: 12px; opacity: 0.5; }
</style>
</head>
<body>
  <h1>Dot · Mind Map</h1>
  <div class="card">
    <pre class="mermaid">${diagram.replace(/[<&>]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!))}</pre>
  </div>
  <footer>Updated live by Dot · ~/.dot/memory/mindmap.md</footer>
  <script type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'
    mermaid.initialize({ startOnLoad: true, theme: 'default' })
  </script>
</body>
</html>`

    const outDir = path.join(os.tmpdir(), 'nina-mindmap')
    fs.mkdirSync(outDir, { recursive: true })
    const outFile = path.join(outDir, 'index.html')
    fs.writeFileSync(outFile, html, 'utf8')
    shell.openPath(outFile)
  } catch (err) {
    console.error('[dot] Failed to open mindmap:', err)
  }
}

// ----------- onboarding -----------

function runOnboarding() {
  if (!win) return
  console.log('[dot] onboarding triggered from menu — starting multi-turn discovery')
  showWindow()
  startOnboarding()
  runPrompt(ONBOARDING_PROMPT, 'setting up — give me a few moments ✨', { freshSession: true })
}

/**
 * Mark Dot as grown and broadcast the transition to the renderer.
 * Idempotent — safe to call multiple times.
 */
function growUp() {
  const was = isGrown()
  markGrown()
  if (!was) {
    console.log('[dot] she grew up 🌱 → 💙')
    win?.webContents.send('pet:grown', true)
  }
}

/**
 * End active onboarding. Marks her as grown, clears the flag, and (once) sends
 * a warm "ok i think i've got you" line to the renderer.
 */
function finishOnboarding(reason: 'nina-ready' | 'user-signal' | 'turn-cap') {
  if (!isOnboardingActive()) return
  console.log(`[dot] onboarding complete (${reason})`)
  endOnboarding()
  growUp()
}

// ----------- tool call formatting -----------

function formatToolCall(name: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>
  switch (name) {
    case 'Bash':
      return `$ ${String(args['command'] ?? '').slice(0, 80)}`
    case 'WebFetch':
      return `fetch ${args['url']}`
    case 'WebSearch':
      return `search "${args['query']}"`
    case 'Read':
      return `read ${args['file_path']}`
    case 'Write':
      return `write ${args['file_path']}`
    case 'Edit':
      return `edit ${args['file_path']}`
    case 'Glob':
      return `glob ${args['pattern']}`
    case 'Grep':
      return `grep ${args['pattern']}`
    case 'mcp__nina__screenshot':
      return `📸 screenshot (${args['mode'] ?? 'full'})`
    case 'mcp__nina__calendar_today':
      return `📅 today's events`
    case 'mcp__nina__calendar_upcoming':
      return `📅 next ${args['hours'] ?? 24}h`
    case 'mcp__nina__calendar_search':
      return `📅 search "${args['query']}"`
    case 'mcp__nina__calendar_list_calendars':
      return `📅 list calendars`
    case 'mcp__nina__calendar_create_event':
      return `📅 create "${String(args['title'] ?? '').slice(0, 40)}"`
    case 'mcp__nina__mail_unread_count':
      return `✉️  unread count`
    case 'mcp__nina__mail_recent':
      return `✉️  recent (${args['count'] ?? 10})`
    case 'mcp__nina__mail_search':
      return `✉️  search "${args['query']}"`
    case 'mcp__nina__mail_read_body':
      return `✉️  read ${String(args['message_id'] ?? '').slice(0, 12)}…`
    case 'mcp__nina__run_shortcut':
      return `⚡ ${args['name']}`
    case 'mcp__nina__list_shortcuts':
      return `⚡ list shortcuts`
    case 'mcp__nina__read_native_window':
      return `🪟 read native window`
    case 'mcp__nina__click_native':
      return `🪟 click ${args['title'] ?? args['role'] ?? ''}`
    case 'mcp__nina__type_native':
      return `🪟 type "${String(args['text'] ?? '').slice(0, 30)}"`
    case 'mcp__nina__press_key_native':
      return `🪟 press ${args['key']}`
    case 'mcp__nina__check_ax_permission':
      return `🔐 check ax permission`
    case 'mcp__nina__mission_create':
      return `🚩 new mission "${String(args['goal'] ?? '').slice(0, 40)}"`
    case 'mcp__nina__mission_list':
      return `🚩 list missions`
    case 'mcp__nina__mission_status':
      return `🚩 status ${args['id']}`
    case 'mcp__nina__mission_step':
      return `🚩 step ${args['id']}`
    case 'mcp__nina__mission_close':
      return `🚩 close ${args['id']} → ${args['status']}`
    case 'mcp__nina__screen_now':
      return `👁  latest frame`
    case 'mcp__nina__screen_timeline':
      return `👁  timeline`
    case 'mcp__nina__system_status':
      return `⚙️  system status`
    case 'mcp__nina__set_volume':
      return `🔊 volume ${args['level'] ?? (args['mute'] ? 'mute' : '')}`
    case 'mcp__nina__set_dark_mode':
      return `🌙 dark mode`
    case 'mcp__nina__set_wifi':
      return `📶 wifi ${args['on'] ? 'on' : 'off'}`
    case 'mcp__nina__media_control':
      return `🎵 ${args['action']}`
    case 'mcp__nina__manage_windows':
      return `🪟 ${args['action']} ${args['app'] ?? ''}`
    case 'mcp__nina__manage_apps':
      return `📱 ${args['action']} ${args['app'] ?? ''}`
    case 'mcp__nina__file_action':
      return `📂 ${args['action']} ${String(args['path'] ?? '').split('/').pop()}`
    case 'mcp__nina__lock_screen':
      return `🔒 lock screen`
    case 'mcp__nina__token_stats':
      return `📊 token stats`
    case 'mcp__nina__gmail_search':
      return `✉️  gmail: "${args['query']}"`
    case 'mcp__nina__gmail_read':
      return `✉️  read ${String(args['message_id'] ?? '').slice(0, 12)}…`
    case 'mcp__nina__gmail_send':
      return `✉️  send to ${args['to']}`
    case 'mcp__nina__gmail_unread_count':
      return `✉️  unread count`
    case 'mcp__nina__gmail_labels':
      return `✉️  labels`
    case 'mcp__nina__gmail_setup_auth':
      return `✉️  gmail oauth setup`
    case 'mcp__nina__browser_goto':
      return `→ ${args['url']}`
    case 'mcp__nina__browser_snapshot':
      return `reading page…`
    case 'mcp__nina__browser_click':
      return `click ${args['ref']}`
    case 'mcp__nina__browser_type':
      return `type "${String(args['text'] ?? '').slice(0, 40)}"`
    case 'mcp__nina__browser_press':
      return `press ${args['key']}`
    case 'mcp__nina__browser_wait_for':
      return `wait for "${args['text']}"`
    case 'mcp__nina__browser_get_text':
      return `reading text…`
    case 'mcp__nina__browser_close':
      return `closing browser`
    default:
      return name.replace(/^mcp__nina__/, '')
  }
}

// ----------- agent runner helper -----------

// Match READY_TO_GROW anywhere in the text — not just at the end.
// Claude sometimes puts text after the marker or embeds it mid-sentence.
const READY_TO_GROW_RE = /READY_TO_GROW/

async function runPrompt(
  prompt: string,
  preamble?: string,
  runOpts?: import('../core/agent.js').RunOptions,
) {
  if (!win) return
  if (currentAgent) {
    // Agent is busy — queue this message instead of aborting.
    promptQueue.push({ prompt, preamble, runOpts })
    win.webContents.send('pet:queue-size', promptQueue.length)
    win.webContents.send('pet:queued', prompt)
    return
  }

  setDotState('thinking')
  win.webContents.send('pet:state', 'thinking')
  win.webContents.send('pet:clear')

  // Optional preamble — shown immediately so the user knows something is
  // happening before the agent streams its first token.
  if (preamble) {
    win.webContents.send('pet:stream', preamble)
  }

  // Opportunistic farewell seeding: capture the last short assistant line
  // and stash it as a fallback "one good thing".
  let lastText = ''
  // Buffer for detecting the READY_TO_GROW marker anywhere in the stream.
  let fullText = ''
  // Cleaned (marker-stripped) version of the full assistant text — fed to TTS
  // on done, so Dot never reads "READY_TO_GROW" aloud.
  let cleanedText = ''
  let saw_ready_marker = false

  // A fresh prompt always cuts off anything Dot is currently saying so she
  // doesn't talk over herself when the user keeps typing.
  voiceStopSpeaking()

  currentAgent = await runAgent(prompt, {
    onText: (text) => {
      fullText += text
      // If the model is about to emit READY_TO_GROW, hide it from the user —
      // strip the marker from displayed text.
      const visible = text.replace(READY_TO_GROW_RE, '').replace(/READY_TO_GROW/g, '')
      if (text.includes('READY_TO_GROW')) saw_ready_marker = true
      if (visible) {
        lastText = visible
        cleanedText += visible
        setDotState('talking')
        win?.webContents.send('pet:state', 'talking')
        win?.webContents.send('pet:stream', visible)
      }
    },
    onTool: (name, input) => {
      win?.webContents.send('pet:tool', formatToolCall(name, input))
    },
    onPermissionRequest: (payload) => {
      setDotState('alert')
      showWindow()
      win?.webContents.send('pet:permission-request', payload)
    },
    onDone: () => {
      setDotState('idle')
      win?.webContents.send('pet:state', 'idle')
      win?.webContents.send('pet:done')
      if (lastText) maybeSeedFarewell(lastText)

      // Speak the reply if the user has opted desktop voice in. Fire and
      // forget — TTS errors shouldn't block the next turn. Strip the
      // READY_TO_GROW marker first so Dot never reads it aloud.
      const toSpeak = cleanedText.trim()
      if (toSpeak && isVoiceEnabled('desktop')) {
        void voiceSpeak(toSpeak).catch((err) =>
          console.warn('[voice] speak failed:', err),
        )
      }

      // If the model signaled it's ready to grow, end onboarding with a
      // short delay so her final words land before the visual pop.
      if (saw_ready_marker || READY_TO_GROW_RE.test(fullText)) {
        console.log('[dot] READY_TO_GROW marker detected in response')
        setTimeout(() => finishOnboarding('nina-ready'), 1200)
      }

      currentAgent = null
      drainPromptQueue()
    },
    onError: (err) => {
      setDotState('idle')
      win?.webContents.send('pet:state', 'idle')
      win?.webContents.send('pet:error', err)
      currentAgent = null
      drainPromptQueue()
    },
  }, {
    ...runOpts,
    channelContext: runOpts?.channelContext ?? {
      channel: 'desktop',
      label: 'pet-chat',
    },
  })
}

// ----------- soul: tokens + morning ritual + farewell -----------

function broadcastTokens() {
  win?.webContents.send('pet:tokens', getTokensRemaining())
}

/**
 * Called when the user first interacts with Dot on a new day (taps her,
 * sends a command, or hits the hotkey). Fires the morning ritual exactly
 * once per local day.
 */
async function maybeFireMorningRitual() {
  if (!win) return
  if (!shouldFireMorningRitual()) return

  // Don't run concurrently with another agent.
  if (currentAgent) return

  showWindow()
  win.webContents.send('pet:state', 'thinking')
  win.webContents.send('pet:clear')

  await runMorningRitual((text) => {
    win?.webContents.send('pet:state', 'talking')
    win?.webContents.send('pet:stream', text)
    maybeSeedFarewell(text)
  })

  win?.webContents.send('pet:state', 'idle')
  win?.webContents.send('pet:done')
}

// ----------- app lifecycle -----------

const HEADLESS = process.argv.includes('--headless')

// --migrate flag: run one-shot migration from openclaw/nanoclaw and exit.
// Runs before the window opens so it works headless from the CLI.
if (process.argv.includes('--migrate')) {
  app.whenReady().then(() => {
    try {
      const reports = migrateAll()
      console.log(formatReports(reports))
      console.log(
        `\n[migrate] done. total items imported: ${reports.reduce((n, r) => n + r.itemsImported, 0)}`,
      )
    } catch (err) {
      console.error('[migrate] failed:', err)
      app.exit(1)
      return
    }
    app.exit(0)
  })
}

/**
 * Gate on a ready provider. In HEADLESS mode (no UI surface to prompt on)
 * we just log and let the first agent call surface the SDK error. In
 * windowed mode we open the provider-setup window and await its close.
 * Idempotent — safe to call multiple times (menu / command re-entry).
 */
async function ensureProviderReady(forcePrompt = false): Promise<boolean> {
  const active = resolveActiveProvider()
  if (active.ready && !forcePrompt) {
    const token = loadAnthropicToken()
    if (token) applyAnthropicCredential(token)
    return true
  }
  if (HEADLESS) {
    console.warn(
      '[dot] no provider credential — headless mode cannot prompt. Run `npm run dev` once to configure, or set CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY.',
    )
    return false
  }
  const result = await openProviderSetupWindow()
  if (result.saved) {
    const token = loadAnthropicToken()
    if (token) applyAnthropicCredential(token)
    console.log(`[dot] provider configured: ${result.providerId}`)
    return true
  }
  return false
}

app.whenReady().then(async () => {
  // First thing, before ANY file I/O: migrate the legacy ~/.dot data
  // directory to ~/.dot if we haven't already. Idempotent, safe on fresh
  // installs. See ensureDotDirMigrated() for the contract.
  ensureDotDirMigrated()

  if (process.argv.includes('--migrate')) return
  // Credential gate. Block startup only in windowed mode when no provider is
  // ready — show the setup window and await a choice. In headless mode just
  // log; the first call will fail loudly rather than silently.
  const ready = await ensureProviderReady()
  if (!ready && !HEADLESS) {
    // User cancelled the setup window. Let them open the pet anyway — the
    // first turn will emit a clear error and they can retry via the tray
    // "Setup provider…" item or `/provider`.
    app.once('browser-window-created', () => {
      setTimeout(() => {
        win?.webContents.send(
          'pet:error',
          'no provider configured. open the tray menu → "Setup provider…" or type /provider to connect one.',
        )
      }, 2000)
    })
  }

  ensureMemoryDir()
  ensureSoulDirs()
  rolloverIfNewDay()

  // Assume graceful quit unless we prove otherwise when the farewell runs.
  markQuitGraceful(false)

  if (!HEADLESS) {
    createWindow()
    createTray()

    // Expose hide/show to core tools (hide_self, proactive push, etc.).
    registerWindowHandlers({
      hide: () => hideWindow(),
      show: () => showWindow(),
      setCharacter: (id: string) => {
        win?.webContents.send('pet:character', id)
      },
    })

    // Global hotkey ⌘⇧Space → toggle window + focus input
    const ok = globalShortcut.register('CommandOrControl+Shift+Space', () => {
      if (!win) return
      if (win.isVisible() && win.isFocused()) {
        hideWindow()
      } else {
        showWindow()
        win.webContents.send('pet:focus-input')
      }
    })
    if (!ok) console.warn('[dot] Failed to register global hotkey ⌘⇧Space')

    // Push-to-talk ⌘⇧V → renderer toggles mic recording. Auto-enables
    // desktop voice the first time so the hotkey feels like it "just works"
    // instead of silently doing nothing.
    const voiceHotkey = globalShortcut.register('CommandOrControl+Shift+V', () => {
      if (!win) return
      if (!isVoiceEnabled(DESKTOP_VOICE)) {
        enableVoice(DESKTOP_VOICE)
        broadcastVoiceStatus()
      }
      showWindow()
      win.webContents.send('pet:voice-listen')
    })
    if (!voiceHotkey) console.warn('[dot] Failed to register push-to-talk hotkey ⌘⇧V')
  } else {
    console.log('[dot] headless mode — no window, tray, hotkey, or UI watchers')
    // Hide dock icon on macOS so Dot runs as a true background service
    try {
      app.dock?.hide()
    } catch {}
  }

  ensureConfigFile()

  // Initialize semantic memory (loads embedding model in background).
  // Broadcast download progress to the renderer so the user sees what's happening.
  setProgressCallback((info) => {
    win?.webContents.send('pet:loading', info)
  })
  // Voice (Whisper) shares the loading-bar UI for its first-use download.
  setVoiceProgressCallback((info) => {
    win?.webContents.send('pet:loading', info)
  })
  // RL: contextual-bandit self-learning. Init before anything that might
  // call runTurn. Starts its own periodic sweeper + policy rebuild.
  try {
    initRL()
  } catch (err) {
    console.warn('[dot] RL init failed (non-critical):', err)
  }
  // Plugins: scan ~/.dot/plugins so contributed tools are present by
  // the first turn. Fire-and-forget — dynamic import is async but the
  // renderer spinner doesn't need to wait on it.
  loadAllPlugins()
    .then((ps) => {
      if (ps.length > 0) console.log(`[dot] loaded ${ps.length} plugin(s)`)
    })
    .catch((err) => console.warn('[dot] plugin load failed (non-critical):', err))

  // Channels: register Desktop + Telegram adapters. The telegram adapter
  // wraps the existing telegram.ts transport — start/stop below still go
  // through that module directly (no behavior change). The registry is
  // there so new channels plug in without editing turn.ts or agent.ts.
  registerDesktopHandlers({
    notify: (text: string) => {
      try {
        win?.webContents.send('pet:stream', text)
      } catch {
        // ignore
      }
    },
    statusProbe: () => ({ windowVisible: !!win && win.isVisible() }),
  })
  registerChannel(createDesktopChannel())
  registerChannel(createTelegramChannel())
  initSemanticMemory()
    .then(() => {
      win?.webContents.send('pet:loading', { status: 'ready', progress: 100 })
    })
    .catch((err) => {
      console.warn('[dot] Semantic memory init failed (will retry on first use):', err)
      win?.webContents.send('pet:loading', {
        status: 'error',
        progress: 0,
        file: String(err),
      })
    })

  // Background observation + daily reflection + diary
  // In headless mode, proactive interrupts become native notifications instead
  // of speech-bubble pops, and the screen/clipboard watchers are skipped.
  if (!HEADLESS) {
    startObservationLoop(
      undefined,
      (message: string) => {
        // Proactive interrupt: Dot decided to say something unprompted.
        if (!win) return
        setDotState('alert')

        // If Dot's window is hidden, send a native macOS notification too
        // so the user actually sees it in whatever app they're in.
        if (!win.isVisible()) {
          void sendNotification(message)
          // Push to Telegram only when the Mac is away (locked or idle 30+ min).
          // Otherwise you're physically present and the notification is enough.
          const primary = readPrimaryChatId()
          if (primary !== null) {
            const gate = shouldPushProactiveToPhone()
            if (gate.push) {
              void pushToTelegram(primary, `💭 ${message}`)
              logEvent('proactive.push_telegram', { reason: gate.reason })
            } else {
              logEvent('proactive.push_skipped', { reason: gate.reason })
            }
          }
        }

        showWindow()
        win.webContents.send('pet:state', 'talking')
        win.webContents.send('pet:stream', message)
        maybeSeedFarewell(message)
        // Revert to idle after a beat
        setTimeout(() => setDotState('idle'), 15_000)
      },
      (ev) => {
        // Visible heartbeat — fires every tick so the user can see Dot "blink"
        // even when nothing is said. `escalated` is true when the tick called
        // the advisory LLM.
        win?.webContents.send('pet:tick', ev)
      },
    )

    // Continuous screen watcher (background, privacy-gated)
    startScreenWatcher()

    // Clipboard watcher
    startClipboardWatcher()
  } else {
    // Headless mode: there's no window to show, so native notifications
    // are the primary surface. Telegram push is gated on the Mac being
    // actually away — otherwise a notification is enough.
    startObservationLoop(
      undefined,
      (message: string) => {
        void sendNotification(message)
        const primary = readPrimaryChatId()
        if (primary !== null) {
          const gate = shouldPushProactiveToPhone()
          if (gate.push) {
            void pushToTelegram(primary, `💭 ${message}`)
            logEvent('proactive.push_telegram', {
              mode: 'headless',
              reason: gate.reason,
            })
          } else {
            logEvent('proactive.push_skipped', {
              mode: 'headless',
              reason: gate.reason,
            })
          }
        }
      },
      () => {},
    )
  }

  // Mission supervisor (background, runs one due step every few minutes)
  startMissionSupervisor(2 * 60 * 1000, (id, result) => {
    console.log(`[missions] ${id} → ${result.status}: ${result.summary}`)
    if (!HEADLESS) {
      rebuildTrayMenu()
      updateTrayGlyph()
    }
  })

  // Cron supervisor (recurring scheduled prompts)
  startCronSupervisor((task, status, summary) => {
    console.log(`[cron] ${task.name} → ${status}: ${summary.slice(0, 120)}`)
  })

  // Seed the Morning Loop cron template on first boot. Created disabled
  // so the user has to opt in — no surprise 7am mail drafts. The prompt
  // is a sentinel string; cron.ts dispatches on it via runAgent, but for
  // the Morning Loop we want a hardcoded JS path. A follow-up wire in
  // cron.ts could special-case the sentinel, but for now the user can
  // toggle this task on and it will run the drafting prompt through the
  // normal bg-queue path (which calls the drafter with the right channel
  // context). Sends still happen out-of-band via askTelegramConfirm.
  try {
    const existing = cronListTasks().some((t) => t.name === 'morning-loop')
    if (!existing) {
      cronCreateTask({
        name: 'morning-loop',
        cron: '0 7 * * *',
        prompt:
          '[MORNING_LOOP_RUN] — Morning Loop: drafts replies to unread mail and pushes ' +
          'to Telegram for approval. The main process intercepts cron tasks with this ' +
          'name and runs runMorningLoop() from morning-loop.ts instead of dispatching ' +
          'this prompt. If you see this text in a log, the intercept is broken.',
      })
      // Cron creates enabled=true by default; flip it off so users opt in.
      const seeded = cronListTasks().find((t) => t.name === 'morning-loop')
      if (seeded) cronUpdateTask(seeded.id, { enabled: false })
      console.log('[morning-loop] seeded cron template (disabled — enable in tray or via cron_toggle)')
    }
  } catch (err) {
    console.warn('[morning-loop] seed failed:', (err as Error).message)
  }

  // Telegram channel — no-op if no token configured
  void startTelegram()

  // Scan installed apps on startup so the index is ready before the first
  // agent call that tries to launch/resolve an app. Fire-and-forget.
  // The index also refreshes each morning (morning.ts) and self-heals
  // on a missed lookup (app-index.ts findApp).
  void scanApps()
    .then((idx) => console.log(`[app-index] scanned ${idx.apps.length} installed apps`))
    .catch((err) => console.warn('[app-index] startup scan failed:', err))

  // Daily freshness check. In headless daemon mode the morning ritual
  // may never fire (no window load event), so we need a tick-based
  // fallback. Every hour check whether the index is ≥ 23h old; if so,
  // rescan. Covers users who installed new apps while the daemon ran.
  setInterval(
    () => {
      void (async () => {
        try {
          const { getIndexAgeSeconds, scanApps: rescan } = await import('../core/app-index.js')
          const ageSec = getIndexAgeSeconds()
          if (ageSec !== null && ageSec < 23 * 3600) return
          const idx = await rescan()
          console.log(`[app-index] daily rescan → ${idx.apps.length} apps`)
        } catch (err) {
          console.warn('[app-index] daily rescan failed:', err)
        }
      })()
    },
    60 * 60 * 1000, // hourly check
  )

  // Short-tick consolidation: runs every 20 min, extracts facts from
  // the last 2 hours of conversation and regenerates the mindmap.
  // Keeps long-term memory and the mindmap evolving continuously —
  // the daily reflection at 9pm still runs for the deeper pass.
  startConsolidationLoop()

  scheduleDailyReflection(21, (result) => {
    if (result.error) {
      console.warn('[dot] Reflection failed:', result.error)
    } else {
      console.log('[dot] Reflection:', result.summary)
    }
    if (tray && result.summary) tray.setToolTip(`Dot · ${result.summary}`)
  })
  scheduleDailyDiary(22, 30, (result) => {
    if (result.error) {
      console.warn('[dot] Diary failed:', result.error)
    } else {
      console.log('[dot] Diary written')
    }
  })

  // Broadcast initial grown state to the renderer so the sprite comes up in
  // the right form on every launch.
  win?.webContents.once('did-finish-load', () => {
    win?.webContents.send('pet:grown', isGrown())
    broadcastTokens()
  })

  if (isFirstRun()) {
    win?.webContents.once('did-finish-load', () => {
      // On first run, show the capabilities window FIRST so the user chooses
      // what Dot can do, THEN show the onboarding hint.
      if (!isCapabilitiesConfigured()) {
        openCapabilitiesWindow(() => {
          console.log('[dot] capabilities configured — showing onboarding hint')
          win?.webContents.send('pet:first-run')
        })
      } else {
        win?.webContents.send('pet:first-run')
      }
    })
  } else {
    // Existing user: maybe run the morning ritual after the window loads.
    win?.webContents.once('did-finish-load', () => {
      void maybeFireMorningRitual()
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Track whether quit was triggered by SIGINT (Ctrl+C) — skip farewell animation
let sigintQuit = false

process.on('SIGINT', () => {
  sigintQuit = true
  app.quit()
})

// Farewell: intercept the first quit, show the ritual, then actually quit.
let farewellStarted = false

app.on('before-quit', async (e) => {
  // Skip farewell animation on Ctrl+C — just clean up and exit fast
  if (
    !sigintQuit &&
    !farewellStarted &&
    win &&
    !win.isDestroyed() &&
    win.isVisible()
  ) {
    e.preventDefault()
    farewellStarted = true

    try {
      const line = loadFarewellMessage()
      win.webContents.send('pet:farewell', line)
      // Give the renderer time to play the farewell animation.
      await new Promise((r) => setTimeout(r, 3500))
      markQuitGraceful(true)
    } catch {
      // Window may have been destroyed during the wait — that's fine
    }
  }

  // Clean up everything
  saveWindowState()
  stopObservationLoop()
  stopDailyReflection()
  stopDailyDiary()
  stopConsolidationLoop()
  stopScreenWatcher()
  stopClipboardWatcher()
  stopMissionSupervisor()
  stopAllWatches()
  stopCronSupervisor()
  stopTelegram()
  try {
    stopRL()
  } catch {}
  try {
    const { closeDb } = await import('../core/db.js')
    closeDb()
  } catch {}
  globalShortcut.unregisterAll()
  // Don't call closeBrowser() — it triggers Chromium's graceful shutdown
  // which briefly flashes the last visited page (e.g. getnadir.com).
  // The browser profile persists at ~/.dot/browser-profile/ regardless,
  // and the OS kills the Chromium process when Electron exits.

  if (farewellStarted || sigintQuit) {
    app.exit(0)
  }
})

// ----------- IPC -----------

const HIDE_COMMANDS = new Set(['hide', 'bye', 'go away', 'sleep', '/hide'])
const SHOW_MEMORY_COMMANDS = new Set(['show memory', '/memory', 'memory'])
const SHOW_MINDMAP_COMMANDS = new Set(['show mind map', 'show mindmap', '/mindmap', 'mindmap'])
const ONBOARD_COMMANDS = new Set(['onboard me', 'onboarding', '/onboard', 'onboard'])

const READ_DIARY_COMMANDS = new Set([
  'read her diary',
  'read diary',
  'show diary',
  '/diary',
  'diary',
])

const CAPABILITIES_COMMANDS = new Set([
  'capabilities',
  'manage capabilities',
  'permissions',
  'settings',
  '/capabilities',
  '/permissions',
  '/settings',
])

const PROVIDER_COMMANDS = new Set([
  '/provider',
  '/providers',
  '/setup',
  'setup provider',
  'change provider',
  'switch provider',
  'connect api',
  'connect api key',
])

const END_ONBOARDING_COMMANDS = new Set([
  'done',
  "i'm done",
  'im done',
  'that is enough',
  "that's enough",
  'thats enough',
  'grow up',
  'ready',
  "i'm ready",
  'im ready',
  'enough onboarding',
  'finish onboarding',
  '/grow',
])

const DESKTOP_VOICE: VoiceContext = 'desktop'

function broadcastVoiceStatus() {
  if (!win) return
  const cfg = getVoiceConfig()
  win.webContents.send('pet:voice-status', {
    enabled: isVoiceEnabled(DESKTOP_VOICE),
    preferGroq: cfg.preferGroq,
    groqConnected: cfg.groqConnected,
    sayVoice: cfg.sayVoice,
    sayRate: cfg.sayRate,
  })
}

/**
 * Handle `/voice ...` commands. Returns true if the command was a voice
 * command (and has been handled) so the caller should NOT dispatch it to
 * the agent. `raw` preserves original casing so voice names like "Daniel"
 * survive; `normalized` is for the dispatch keyword only.
 */
function handleVoiceCommand(normalized: string, raw: string): boolean {
  if (!normalized.startsWith('/voice') && normalized !== 'voice') return false
  const rawParts = raw.trim().split(/\s+/).slice(1) // drop '/voice'
  const parts = normalized.split(/\s+/).slice(1)
  const sub = parts[0] ?? 'status'

  const say = (line: string) => win?.webContents.send('pet:stream', line)

  switch (sub) {
    case 'on': {
      enableVoice(DESKTOP_VOICE)
      say('voice on 🎙️ — tap the mic or press ⌘⇧V to talk to me')
      broadcastVoiceStatus()
      return true
    }
    case 'off': {
      disableVoice(DESKTOP_VOICE)
      voiceStopSpeaking()
      say('voice off. back to typing.')
      broadcastVoiceStatus()
      return true
    }
    case 'status': {
      const cfg = getVoiceConfig()
      const state = isVoiceEnabled(DESKTOP_VOICE) ? 'on' : 'off'
      const stt = cfg.preferGroq && cfg.groqConnected ? 'groq' : 'local whisper'
      say(`voice ${state} · stt: ${stt}${cfg.groqConnected ? ' · groq key saved' : ''}`)
      return true
    }
    case 'connect':
    case 'onboard': {
      if (parts[1] === 'groq') {
        const key = parts.slice(2).join(' ').trim()
        if (!key) {
          say('paste your groq api key: `/voice connect groq <key>` — i\'ll stash it in the macOS keychain.')
          return true
        }
        const ok = voiceConnectGroq(key)
        if (ok) {
          say('groq key saved to keychain. say `/voice use groq` to switch stt over.')
        } else {
          say('couldn\'t save the groq key — keychain refused. try again?')
        }
        broadcastVoiceStatus()
        return true
      }
      say('usage: `/voice connect groq <api-key>`')
      return true
    }
    case 'use': {
      if (parts[1] === 'groq') {
        const ok = enableGroqStt()
        say(ok ? 'stt → groq 🌩' : 'no groq key on file. run `/voice connect groq <key>` first.')
        broadcastVoiceStatus()
        return true
      }
      if (parts[1] === 'local') {
        disableGroqStt()
        say('stt → local whisper 🧠')
        broadcastVoiceStatus()
        return true
      }
      say('usage: `/voice use local` or `/voice use groq`')
      return true
    }
    case 'disconnect': {
      if (parts[1] === 'groq') {
        disconnectGroq()
        say('forgot the groq key. back to local whisper.')
        broadcastVoiceStatus()
        return true
      }
      say('usage: `/voice disconnect groq`')
      return true
    }
    case 'stop':
    case 'shh':
    case 'quiet': {
      voiceStopSpeaking()
      return true
    }
    case 'list':
    case 'voices': {
      void (async () => {
        const voices = await listSayVoices()
        if (voices.length === 0) {
          say('no voices found — try `say -v "?"` in Terminal to see what macOS has.')
          return
        }
        // Group british-flavored first so they're easy to spot.
        const british = voices.filter((v) => v.locale.startsWith('en_GB'))
        const rest = voices.filter((v) => !v.locale.startsWith('en_GB'))
        const fmt = (v: { name: string; locale: string }) => `  ${v.name} (${v.locale})`
        const lines: string[] = []
        if (british.length) {
          lines.push('british voices:')
          lines.push(...british.map(fmt))
        }
        lines.push(`all voices (${voices.length}):`)
        lines.push(...rest.slice(0, 40).map(fmt))
        if (rest.length > 40) lines.push(`  …and ${rest.length - 40} more`)
        lines.push('')
        lines.push('pick one with `/voice set <name>` (e.g., `/voice set Daniel`)')
        say(lines.join('\n'))
      })()
      return true
    }
    case 'set': {
      // rawParts[1..] preserves original casing so "Daniel" survives.
      const name = rawParts.slice(1).join(' ').trim()
      if (!name) {
        say('usage: `/voice set <name>` — run `/voice list` to see options, or `/voice set default` to clear.')
        return true
      }
      if (name.toLowerCase() === 'default' || name.toLowerCase() === 'system') {
        setSayVoice(null)
        say('voice → system default')
        broadcastVoiceStatus()
        void voiceSpeak("okay, back to the default voice.").catch(() => {})
        return true
      }
      setSayVoice(name)
      broadcastVoiceStatus()
      say(`voice → ${name}`)
      void voiceSpeak(`hi, I'm ${name}. this is how I sound.`).catch(() => {})
      return true
    }
    case 'speed':
    case 'rate': {
      const n = Number(parts[1])
      if (!Number.isFinite(n)) {
        say('usage: `/voice speed <wpm>` — try 160 (slow), 185 (default), 220 (fast)')
        return true
      }
      setSayRate(n)
      broadcastVoiceStatus()
      say(`speech rate → ${Math.max(80, Math.min(400, Math.round(n)))} wpm`)
      void voiceSpeak('this is my new speed.').catch(() => {})
      return true
    }
    case 'test':
    case 'try': {
      const cfg = getVoiceConfig()
      const who = cfg.sayVoice ?? 'the system default voice'
      void voiceSpeak(`this is ${who}, speaking at ${cfg.sayRate} words per minute.`).catch(() => {})
      return true
    }
    default:
      say('voice commands: `on`, `off`, `status`, `list`, `set <name>`, `speed <wpm>`, `test`, `connect groq <key>`, `use local|groq`, `disconnect groq`, `stop`')
      return true
  }
}

const REFLECT_NOW_COMMANDS = new Set(['reflect', 'reflect now', '/reflect'])
const SPIN_COMMANDS = new Set([
  'spin',
  'spin her',
  'spin dot',
  '/spin',
  'twirl',
  'do a spin',
  'spin around',
])
const DIARY_NOW_COMMANDS = new Set([
  'write diary',
  'write diary now',
  'diary now',
  '/diary-now',
])

ipcMain.handle('pet:command', async (_e, prompt: string) => {
  touchLastSeen()
  const normalized = prompt.trim().toLowerCase()

  // Handle built-in commands FIRST, before morning ritual. Onboarding and
  // hide/quit shouldn't be preempted by a greeting, and on first run the
  // ritual would try to read empty memory.
  if (HIDE_COMMANDS.has(normalized)) {
    hideWindow()
    return
  }
  if (handleVoiceCommand(normalized, prompt)) return
  if (SPIN_COMMANDS.has(normalized)) {
    // Piggyback on the existing tick-pulse channel the renderer already
    // uses for its hover-spin buttons. `escalated: true` gives a longer,
    // showier twirl (1.25s vs 0.75s).
    showWindow()
    win?.webContents.send('pet:tick', {
      app: null,
      window: null,
      escalated: true,
    })
    return
  }
  if (CAPABILITIES_COMMANDS.has(normalized)) {
    openCapabilitiesWindow(() => rebuildTrayMenu())
    return
  }
  if (PROVIDER_COMMANDS.has(normalized)) {
    win?.webContents.send('pet:stream', 'opening provider setup…')
    const ok = await ensureProviderReady(true)
    win?.webContents.send(
      'pet:stream',
      ok ? 'provider saved ✓ try talking to me now.' : 'no provider configured yet.',
    )
    return
  }
  if (ONBOARD_COMMANDS.has(normalized)) {
    console.log('[dot] onboard command recognized — starting multi-turn onboarding')
    showWindow()
    startOnboarding()
    return runPrompt(ONBOARDING_PROMPT, 'setting up — give me a few moments ✨', { freshSession: true })
  }

  // If the user explicitly ends onboarding, grow her up and drop the flag.
  if (END_ONBOARDING_COMMANDS.has(normalized) && isOnboardingActive()) {
    console.log('[dot] user signaled end of onboarding')
    finishOnboarding('user-signal')
    win?.webContents.send('pet:stream', 'ok — growing up ✨')
    return
  }

  // Morning ritual only fires for existing users (not on first run).
  // Skips gracefully if onboarding hasn't happened yet.
  if (!isFirstRun() && shouldFireMorningRitual()) {
    showWindow()
    win?.webContents.send('pet:clear')
    await runMorningRitual((text) => {
      win?.webContents.send('pet:state', 'talking')
      win?.webContents.send('pet:stream', text)
      maybeSeedFarewell(text)
    })
    win?.webContents.send('pet:done')
    // If the prompt was empty (e.g. hotkey-triggered refresh), stop here.
    if (!prompt || !prompt.trim()) return
  }
  if (SHOW_MEMORY_COMMANDS.has(normalized)) {
    shell.openPath(MEMORY_DIR)
    win?.webContents.send('pet:stream', 'opened memory folder 📂')
    return
  }
  if (SHOW_MINDMAP_COMMANDS.has(normalized)) {
    openMindMap()
    win?.webContents.send('pet:stream', 'opened mind map 🧠')
    return
  }
  if (READ_DIARY_COMMANDS.has(normalized)) {
    shell.openPath(DIARY_DIR)
    win?.webContents.send('pet:stream', 'opened her diary 📖')
    return
  }

  // If we're in onboarding mode, count this as a discovery turn. Hard cap
  // of 8 turns so she doesn't get stuck in discovery forever.
  if (isOnboardingActive()) {
    const turns = incrementOnboardingTurn()
    if (turns > 5) {
      console.log('[dot] onboarding turn cap reached — auto-finishing')
      finishOnboarding('turn-cap')
      // Fall through and still process this turn as a normal command.
    }
  }

  if (REFLECT_NOW_COMMANDS.has(normalized)) {
    win?.webContents.send('pet:stream', 'reflecting…')
    win?.webContents.send('pet:state', 'thinking')
    const result = await runReflection()
    win?.webContents.send('pet:state', 'idle')
    win?.webContents.send(
      'pet:stream',
      result.error ? `reflection failed: ${result.error}` : result.summary || 'done ✓',
    )
    return
  }
  if (DIARY_NOW_COMMANDS.has(normalized)) {
    win?.webContents.send('pet:stream', 'writing the day…')
    win?.webContents.send('pet:state', 'thinking')
    const result = await runDiary()
    win?.webContents.send('pet:state', 'idle')
    win?.webContents.send(
      'pet:stream',
      result.error ? `diary failed: ${result.error}` : 'diary written ✨',
    )
    return
  }
  await runPrompt(prompt)
})

ipcMain.handle('pet:hide', () => hideWindow())
ipcMain.handle('pet:onboard', () => runOnboarding())
ipcMain.handle('pet:show-memory', () => shell.openPath(MEMORY_DIR))
ipcMain.handle('pet:show-mindmap', () => openMindMap())
ipcMain.handle('pet:show-diary', () => shell.openPath(DIARY_DIR))
ipcMain.handle('pet:get-tokens', () => getTokensRemaining())
ipcMain.handle('pet:get-grown', () => isGrown())
ipcMain.handle('pet:drag-start', () => {
  // nothing — renderer tracks the drag and sends pet:drag-to
})
ipcMain.handle('pet:drag-by', (_e, dx: number, dy: number) => {
  if (!win) return
  const [x, y] = win.getPosition()
  win.setPosition(Math.round(x + dx), Math.round(y + dy))
})

ipcMain.handle('pet:resize', (_e, w: number, h: number) => {
  if (!win) return
  const clampedW = Math.max(220, Math.min(700, Math.round(w)))
  const clampedH = Math.max(200, Math.min(900, Math.round(h)))
  const [curW, curH] = win.getSize()
  if (clampedW === curW && clampedH === curH) return
  const [x, y] = win.getPosition()
  // Anchor bottom-right: keep the pet in roughly the same screen spot.
  const newX = x + (curW - clampedW)
  const newY = y + (curH - clampedH)
  win.setBounds({ x: newX, y: newY, width: clampedW, height: clampedH })
})

ipcMain.handle('pet:permission-resolve', (_e, id: string, allowed: boolean) => {
  resolvePermissionRequest(id, allowed)
})

ipcMain.handle('pet:abort', () => {
  // Abort clears the queue — user wants everything stopped.
  promptQueue.length = 0
  win?.webContents.send('pet:queue-size', 0)
  if (currentAgent) {
    currentAgent.abort()
    currentAgent = null
    cancelAllPending()
    win?.webContents.send('pet:state', 'idle')
  }
})

ipcMain.handle('pet:quit', () => app.quit())

// ----------- voice IPC -----------

ipcMain.handle('pet:voice-status', () => {
  const cfg = getVoiceConfig()
  return {
    enabled: isVoiceEnabled(DESKTOP_VOICE),
    preferGroq: cfg.preferGroq,
    groqConnected: cfg.groqConnected,
    sayVoice: cfg.sayVoice,
    sayRate: cfg.sayRate,
  }
})

ipcMain.handle('pet:voice-enable', () => {
  enableVoice(DESKTOP_VOICE)
  broadcastVoiceStatus()
})

ipcMain.handle('pet:voice-disable', () => {
  disableVoice(DESKTOP_VOICE)
  voiceStopSpeaking()
  broadcastVoiceStatus()
})

ipcMain.handle('pet:voice-stop-speaking', () => {
  voiceStopSpeaking()
})

ipcMain.handle('pet:voice-submit-audio', async (_e, pcm: Float32Array) => {
  // Renderer sends raw Float32 PCM at 16 kHz, mono. Electron serializes
  // typed arrays over IPC as plain objects on some versions — normalize.
  const samples =
    pcm instanceof Float32Array
      ? pcm
      : new Float32Array(Array.isArray(pcm) ? pcm : Object.values(pcm as any))

  if (samples.length === 0) return { text: '' }

  try {
    win?.webContents.send('pet:tool', '🎙 transcribing…')
    const text = await voiceTranscribe({ pcm: samples, language: 'english' })
    if (text) {
      win?.webContents.send('pet:voice-transcript', text)
      // Dispatch as a normal user turn so everything downstream (memory,
      // situational frame, queue) behaves identically to typed input.
      void (async () => {
        try {
          await runPrompt(text)
        } catch (err) {
          console.warn('[voice] dispatch failed:', err)
        }
      })()
    } else {
      win?.webContents.send('pet:stream', "(didn't catch that)")
    }
    return { text }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[voice] transcribe failed:', msg)
    win?.webContents.send('pet:error', `transcription failed: ${msg}`)
    return { text: '' }
  }
})

ipcMain.handle('pet:voice-connect-groq', (_e, apiKey: string) => {
  const ok = voiceConnectGroq(apiKey)
  broadcastVoiceStatus()
  return { ok }
})

ipcMain.handle('pet:voice-use-groq', (_e, on: boolean) => {
  if (on) {
    const ok = enableGroqStt()
    broadcastVoiceStatus()
    return ok ? { ok: true } : { ok: false, reason: 'no groq key on file' }
  }
  disableGroqStt()
  broadcastVoiceStatus()
  return { ok: true }
})
