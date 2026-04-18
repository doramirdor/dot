/**
 * Capabilities system — the user's explicit permission grants for Dot.
 *
 * Each capability represents a category of actions Dot can take. The user
 * approves them during onboarding (or later via the tray menu) through a
 * dedicated HTML window showing toggles for each capability.
 *
 * Two modes:
 *   - "full control" — everything enabled, no per-action confirmations
 *   - "manual" — user picks which categories to enable; disabled categories
 *     are either blocked or require per-action confirmation
 *
 * Persisted at ~/.dot/capabilities.json. The trust layer reads this before
 * classifying each tool call.
 */
import fs from 'node:fs'
import path from 'node:path'
import { DOT_DIR } from './memory.js'

const CAPS_FILE = path.join(DOT_DIR, 'capabilities.json')

export interface Capability {
  id: string
  name: string
  description: string
  icon: string
  /** What tools this unlocks (for the trust layer) */
  tools: string[]
  /** Examples of what Dot can do with this */
  examples: string[]
  /** Risk level — shown to the user */
  risk: 'safe' | 'moderate' | 'powerful'
}

export interface CapabilitiesState {
  mode: 'full' | 'manual' | 'unconfigured'
  /** Per-capability enable/disable (only used in manual mode) */
  grants: Record<string, boolean>
  /** When the user last reviewed capabilities */
  lastReviewedAt: string | null
}

// ============ capability definitions ============

export const ALL_CAPABILITIES: Capability[] = [
  {
    id: 'read_files',
    name: 'Read your files',
    description: 'Read files on your Mac (code, documents, configs). Never reads .ssh, .aws, passwords, or credentials.',
    icon: '📂',
    tools: ['Read', 'Glob', 'Grep'],
    examples: ['Read your project code', 'Search files by name', 'Find text in files'],
    risk: 'safe',
  },
  {
    id: 'write_files',
    name: 'Write & edit files',
    description: 'Create and modify files on your Mac. Dot writes to her own memory freely; writing elsewhere asks first.',
    icon: '✏️',
    tools: ['Write', 'Edit'],
    examples: ['Update memory files', 'Create notes', 'Edit configs'],
    risk: 'moderate',
  },
  {
    id: 'run_commands',
    name: 'Run shell commands',
    description: 'Execute terminal commands on your Mac. Safe commands (open, ls, git status) run automatically. Dangerous ones (rm, sudo) always ask first.',
    icon: '💻',
    tools: ['Bash'],
    examples: ['Open apps', 'Check git status', 'Run scripts'],
    risk: 'moderate',
  },
  {
    id: 'browse_web',
    name: 'Browse the web',
    description: "Control a persistent Chrome browser. Login sessions are saved. Dot can navigate, click, fill forms, and read pages.",
    icon: '🌐',
    tools: [
      'mcp__nina__browser_goto', 'mcp__nina__browser_snapshot',
      'mcp__nina__browser_click', 'mcp__nina__browser_type',
      'mcp__nina__browser_press', 'mcp__nina__browser_wait_for',
      'mcp__nina__browser_get_text', 'mcp__nina__browser_close',
    ],
    examples: ['Check in to flights', 'Fill web forms', 'Read articles'],
    risk: 'moderate',
  },
  {
    id: 'see_screen',
    name: 'See your screen',
    description: 'Take screenshots and watch your screen continuously. Pauses automatically for password managers and private browsing.',
    icon: '👁',
    tools: [
      'mcp__nina__screenshot', 'mcp__nina__screen_now',
      'mcp__nina__screen_timeline',
    ],
    examples: ['What am I looking at?', 'Read this error', 'What was I doing earlier?'],
    risk: 'moderate',
  },
  {
    id: 'control_apps',
    name: 'Control native apps',
    description: 'Read and drive native Mac apps via the Accessibility API. Can click buttons, type text, read UI elements in any app.',
    icon: '🪟',
    tools: [
      'mcp__nina__read_native_window', 'mcp__nina__click_native',
      'mcp__nina__type_native', 'mcp__nina__press_key_native',
      'mcp__nina__check_ax_permission',
    ],
    examples: ['Click buttons in Slack', 'Type in Notes', 'Read app menus'],
    risk: 'powerful',
  },
  {
    id: 'drive_mac_apps',
    name: 'Drive any Mac app',
    description: 'Universal access to scriptable Mac apps via AppleScript + keystroke dispatch. Drives Mail, Calendar, Reminders, Notes, Music, Photos, Safari, Messages, Contacts, Finder, Pages, Numbers, Keynote, and anything else with a scripting dictionary. Complement to the Accessibility-based control_apps capability for apps that expose richer APIs.',
    icon: '🎛',
    tools: [
      'mcp__nina__run_applescript',
      'mcp__nina__send_keyboard_shortcut',
      'mcp__nina__open_with_default',
    ],
    examples: [
      'Create a reminder for 3pm',
      'Search my Notes for "investor update"',
      'Play a playlist in Music',
      'Send a message in Messages',
    ],
    risk: 'powerful',
  },
  {
    id: 'system_control',
    name: 'Control your Mac',
    description: 'Volume, brightness, dark mode, WiFi, window management, media playback, app lifecycle (launch/quit), file operations.',
    icon: '⚙️',
    tools: [
      'mcp__nina__system_status', 'mcp__nina__set_volume',
      'mcp__nina__set_dark_mode', 'mcp__nina__set_wifi',
      'mcp__nina__media_control', 'mcp__nina__manage_windows',
      'mcp__nina__manage_apps', 'mcp__nina__file_action',
      'mcp__nina__lock_screen',
    ],
    examples: ['Volume 30', 'Dark mode', 'Tile Chrome and Slack', 'Launch Figma', 'Quit Spotify'],
    risk: 'moderate',
  },
  {
    id: 'email',
    name: 'Read & send email',
    description: 'Access Gmail via API. Read, search, and send emails. Sending always asks for confirmation.',
    icon: '✉️',
    tools: [
      'mcp__nina__gmail_search', 'mcp__nina__gmail_read',
      'mcp__nina__gmail_send', 'mcp__nina__gmail_unread_count',
      'mcp__nina__gmail_labels', 'mcp__nina__gmail_setup_auth',
      'mcp__nina__mail_unread_count', 'mcp__nina__mail_recent',
      'mcp__nina__mail_search', 'mcp__nina__mail_read_body',
    ],
    examples: ['Check inbox', 'Search for flight emails', 'Send a reply'],
    risk: 'powerful',
  },
  {
    id: 'calendar',
    name: 'Read & manage calendar',
    description: 'Access your calendar. Read events, search, and create new events. Creating events asks for confirmation.',
    icon: '📅',
    tools: [
      'mcp__nina__calendar_today', 'mcp__nina__calendar_upcoming',
      'mcp__nina__calendar_search', 'mcp__nina__calendar_list_calendars',
      'mcp__nina__calendar_create_event',
    ],
    examples: ["What's on my calendar?", "When's my next meeting?", 'Schedule a call'],
    risk: 'moderate',
  },
  // (clipboard capability removed in the focus refactor — watcher still
  //  populates memory passively, but the clipboard_history/search tools
  //  were cut. Re-add here if the tool surface returns.)
  {
    id: 'shortcuts',
    name: 'Run macOS Shortcuts',
    description: 'List and run your macOS Shortcuts. Gives Dot access to HomeKit, Reminders, and anything you\'ve automated.',
    icon: '⚡',
    tools: ['mcp__nina__run_shortcut', 'mcp__nina__list_shortcuts'],
    examples: ['Turn off the lights', 'Set a reminder', 'Run my morning routine'],
    risk: 'powerful',
  },
  // (code_delegate capability removed — run_claude_code tool was cut in
  //  the focus refactor. See mcp-tools.ts. Re-add if Dot ever re-enables
  //  coding sub-agent spawning.)
  {
    id: 'missions',
    name: 'Long-running missions',
    description: 'Create background tasks that Dot works on over hours or days, taking one step at a time.',
    icon: '🚩',
    tools: [
      'mcp__nina__mission_create', 'mcp__nina__mission_list',
      'mcp__nina__mission_status', 'mcp__nina__mission_step',
      'mcp__nina__mission_close',
    ],
    examples: ['Research X and report back', 'Monitor Y for changes'],
    risk: 'moderate',
  },
  {
    id: 'web_search',
    name: 'Search the web',
    description: 'Search the web and fetch pages for information.',
    icon: '🔍',
    tools: ['WebFetch', 'WebSearch'],
    examples: ["What's the weather?", 'Look up this error', 'Find docs for X'],
    risk: 'safe',
  },
]

// ============ state management ============

function defaultState(): CapabilitiesState {
  return { mode: 'unconfigured', grants: {}, lastReviewedAt: null }
}

export function loadCapabilities(): CapabilitiesState {
  try {
    if (!fs.existsSync(CAPS_FILE)) return defaultState()
    const raw = JSON.parse(fs.readFileSync(CAPS_FILE, 'utf8'))
    return { ...defaultState(), ...raw }
  } catch {
    return defaultState()
  }
}

export function saveCapabilities(state: CapabilitiesState): void {
  try {
    const dir = path.dirname(CAPS_FILE)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(CAPS_FILE, JSON.stringify(state, null, 2), 'utf8')
  } catch (err) {
    console.warn('[nina] Failed to save capabilities:', err)
  }
}

export function isCapabilitiesConfigured(): boolean {
  return loadCapabilities().mode !== 'unconfigured'
}

export function grantFullControl(): void {
  const state = loadCapabilities()
  state.mode = 'full'
  for (const cap of ALL_CAPABILITIES) {
    state.grants[cap.id] = true
  }
  state.lastReviewedAt = new Date().toISOString()
  saveCapabilities(state)
}

export function setManualGrants(grants: Record<string, boolean>): void {
  const state = loadCapabilities()
  state.mode = 'manual'
  state.grants = grants
  state.lastReviewedAt = new Date().toISOString()
  saveCapabilities(state)
}

/**
 * Check if a specific tool is allowed by the current capabilities config.
 * Returns:
 *   - 'allowed' — tool is in an enabled capability
 *   - 'blocked' — tool is in a disabled capability
 *   - 'unconfigured' — capabilities haven't been set up yet (default to allowed)
 *   - 'unknown' — tool isn't in any capability definition (default to allowed)
 */
export function isToolAllowed(toolName: string): 'allowed' | 'blocked' | 'unconfigured' | 'unknown' {
  const state = loadCapabilities()

  if (state.mode === 'unconfigured') return 'unconfigured'
  if (state.mode === 'full') return 'allowed'

  // Manual mode: find which capability owns this tool
  for (const cap of ALL_CAPABILITIES) {
    if (cap.tools.includes(toolName)) {
      return state.grants[cap.id] ? 'allowed' : 'blocked'
    }
  }

  // Tool not in any capability definition — allow by default
  return 'unknown'
}
