import fs from 'node:fs'
import { AUDIT_LOG_FILE } from './memory.js'
import { isToolAllowed } from './capabilities.js'
import { checkRules } from './autonomy.js'
import { logToolCall as dbLogToolCall } from './db.js'

export type Tier = 'auto' | 'confirm' | 'deny'

/**
 * Bash commands we consider dangerous even in the auto tier. Anything matching
 * these regexes is bumped up to 'confirm'.
 */
const DANGEROUS_BASH_PATTERNS: RegExp[] = [
  /\brm\s+-rf?\b/,
  /\bsudo\b/,
  /\bdd\s+if=/,
  /\bmkfs\b/,
  /\b:>\s*\/dev\/sda/,
  /\bchmod\s+-R\s+(777|000)\b/,
  /\bkillall\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bdiskutil\s+erase/,
  /\bcurl\s+.*\s*\|\s*(bash|sh|zsh)/,
  /\bwget\s+.*\s*\|\s*(bash|sh|zsh)/,
  /\brm\s+[^|]*\.(ssh|aws|gnupg|config|keychain)/,
  /\bsecurity\s+(delete-generic-password|delete-internet-password)/,
  /\bgit\s+push\s+--force\b/,
  /\bgit\s+push\s+.*-f\b/,
]

/**
 * Files / directories that Dot must never read — credentials, keys, secrets.
 * Applied to Read, Bash, Grep, Glob, and any other tool that takes a path.
 */
const FORBIDDEN_READ_PATHS: RegExp[] = [
  /\/\.ssh(\/|\b)/,
  /\/\.aws(\/|\b)/,
  /\/\.gnupg(\/|\b)/,
  /\/\.kube(\/|\b)/,
  /\/Library\/Keychains\//,
  /\.pem$/,
  /\.p12$/,
  /\bid_rsa\b/,
  /\bid_ed25519\b/,
  /\.env(\.[\w-]+)?$/,
  /credentials\.json$/,
  /\/\.nina\/config\.json$/,
  /\/\.openclaw(\/|\b)/,
  /\/\.nanoclaw(\/|\b)/,
  /auth-profiles\.json$/,
]

/**
 * Files / directories where Dot must never write.
 */
const FORBIDDEN_WRITE_PATHS: RegExp[] = [
  ...FORBIDDEN_READ_PATHS,
  /\/System\//,
  /\/usr\//,
  /\/Library\/Application Support\/(?!.*\.nina)/,
  /\/Applications\//,
  /\.DS_Store$/,
]

/**
 * Classify a tool call into a trust tier.
 *
 * - 'auto'    : Dot runs it without asking. Safe, reversible, scoped.
 * - 'confirm' : Ask the user first. Sensitive or irreversible.
 * - 'deny'    : Absolutely not. Bug or attack surface.
 */
export function classifyToolCall(
  toolName: string,
  input: Record<string, unknown>,
): { tier: Tier; reason?: string } {
  // 1. Capabilities check — if the user explicitly disabled a capability, block it.
  const capStatus = isToolAllowed(toolName)
  if (capStatus === 'blocked') {
    return {
      tier: 'deny',
      reason: `capability disabled by user. enable it in Dot → Manage capabilities.`,
    }
  }

  // 2. "Don't do" rules — user's personal blacklist. Checked before everything else.
  const ruleCheck = checkRules(toolName, input)
  if (ruleCheck.blocked) {
    return {
      tier: 'deny',
      reason: `blocked by rule: "${ruleCheck.matchedRule?.rule}"`,
    }
  }

  // 'unconfigured' and 'unknown' fall through to normal classification.
  // ----- Always-allowed read-only tools -----
  if (
    // No-op scratchpad — zero side effects.
    toolName === 'mcp__nina__think' ||
    toolName === 'Read' ||
    toolName === 'Glob' ||
    toolName === 'Grep' ||
    toolName === 'WebFetch' ||
    toolName === 'WebSearch' ||
    toolName === 'mcp__nina__browser_snapshot' ||
    toolName === 'mcp__nina__browser_get_text' ||
    toolName === 'mcp__nina__browser_wait_for' ||
    toolName === 'mcp__nina__screenshot' ||
    toolName === 'mcp__nina__calendar_today' ||
    toolName === 'mcp__nina__calendar_upcoming' ||
    toolName === 'mcp__nina__calendar_search' ||
    toolName === 'mcp__nina__calendar_list_calendars' ||
    toolName === 'mcp__nina__mail_unread_count' ||
    toolName === 'mcp__nina__mail_recent' ||
    toolName === 'mcp__nina__mail_search' ||
    toolName === 'mcp__nina__mail_read_body' ||
    toolName === 'mcp__nina__list_shortcuts' ||
    toolName === 'mcp__nina__read_native_window' ||
    toolName === 'mcp__nina__check_ax_permission' ||
    toolName === 'mcp__nina__screen_now' ||
    toolName === 'mcp__nina__screen_timeline' ||
    toolName === 'mcp__nina__mission_list' ||
    toolName === 'mcp__nina__mission_status' ||
    toolName === 'mcp__nina__mission_create' ||
    toolName === 'mcp__nina__mission_close' ||
    toolName === 'mcp__nina__token_stats' ||
    toolName === 'mcp__nina__search_memory' ||
    toolName === 'mcp__nina__remember_fact' ||
    toolName === 'mcp__nina__memory_stats' ||
    toolName === 'mcp__nina__add_dont_do_rule' ||
    toolName === 'mcp__nina__remove_dont_do_rule' ||
    toolName === 'mcp__nina__list_dont_do_rules' ||
    // System read-only
    toolName === 'mcp__nina__system_status' ||
    toolName === 'mcp__nina__media_control' ||
    // Gmail read-only
    toolName === 'mcp__nina__gmail_search' ||
    toolName === 'mcp__nina__gmail_read' ||
    toolName === 'mcp__nina__gmail_unread_count' ||
    toolName === 'mcp__nina__gmail_labels' ||
    toolName === 'mcp__nina__gmail_setup_auth' ||
    // Cron (modifies own config, no system impact)
    toolName === 'mcp__nina__cron_create' ||
    toolName === 'mcp__nina__cron_list' ||
    toolName === 'mcp__nina__cron_run_now' ||
    toolName === 'mcp__nina__cron_delete' ||
    toolName === 'mcp__nina__cron_toggle' ||
    toolName === 'mcp__nina__morning_loop_run_now' ||
    // Telegram (transport is allowlist-gated)
    toolName === 'mcp__nina__telegram_status' ||
    toolName === 'mcp__nina__telegram_reply_photo' ||
    // Observability (read-only introspection)
    toolName === 'mcp__nina__dot_timeline' ||
    toolName === 'mcp__nina__bg_queue_status' ||
    toolName === 'mcp__nina__presence_check' ||
    // Reversible destructive ops — trash-backed, safer than raw Write/rm
    toolName === 'mcp__nina__safe_delete_file' ||
    toolName === 'mcp__nina__safe_write_file' ||
    toolName === 'mcp__nina__dot_undo' ||
    toolName === 'mcp__nina__dot_trash_status' ||
    // App launching via default handler (benign — same as double-clicking)
    toolName === 'mcp__nina__open_with_default' ||
    // App index (read-only scan + fuzzy find)
    toolName === 'mcp__nina__scan_apps' ||
    toolName === 'mcp__nina__find_app' ||
    // Migration (idempotent, import-only)
    toolName === 'mcp__nina__migrate_from_claws' ||
    // Window control (hide/show the pet window). Reversible.
    toolName === 'mcp__nina__hide_self' ||
    toolName === 'mcp__nina__show_self' ||
    // Passive url watcher + watcher introspection / cancellation
    toolName === 'mcp__nina__watch_url' ||
    toolName === 'mcp__nina__watch_list' ||
    toolName === 'mcp__nina__watch_stop'
  ) {
    // Path-bearing tools: guard against forbidden paths.
    if (toolName === 'Read') {
      const p = String(input['file_path'] ?? '')
      for (const pat of FORBIDDEN_READ_PATHS) {
        if (pat.test(p)) return { tier: 'deny', reason: `blocked read: ${p}` }
      }
    }
    if (toolName === 'Grep') {
      const p = String(input['path'] ?? '')
      const glob = String(input['glob'] ?? '')
      const pattern = String(input['pattern'] ?? '')
      for (const pat of FORBIDDEN_READ_PATHS) {
        if (pat.test(p) || pat.test(glob) || pat.test(pattern)) {
          return { tier: 'deny', reason: `blocked grep: ${p || glob}` }
        }
      }
    }
    if (toolName === 'Glob') {
      const p = String(input['path'] ?? '')
      const pattern = String(input['pattern'] ?? '')
      for (const pat of FORBIDDEN_READ_PATHS) {
        if (pat.test(p) || pat.test(pattern)) {
          return { tier: 'deny', reason: `blocked glob: ${p || pattern}` }
        }
      }
    }
    if (
      toolName === 'mcp__nina__safe_write_file' ||
      toolName === 'mcp__nina__safe_delete_file'
    ) {
      const p = String(input['path'] ?? input['file_path'] ?? '')
      for (const pat of FORBIDDEN_WRITE_PATHS) {
        if (pat.test(p)) return { tier: 'deny', reason: `blocked safe-op: ${p}` }
      }
      // Safe-ops outside ~/.dot still confirm — reversible, but user should know.
      if (!p.includes('/.nina/')) {
        return { tier: 'confirm', reason: `${toolName.split('__').pop()} ${p}` }
      }
    }
    return { tier: 'auto' }
  }

  // ----- AppleScript (universal Mac app access) -----
  // Arbitrary AppleScript is roughly Bash-equivalent power. Deny if it
  // touches credentials / keychain / sensitive paths; otherwise auto
  // (the user explicitly wanted Dot to drive Mac apps).
  if (toolName === 'mcp__nina__run_applescript') {
    const script = String(input['script'] ?? '')
    if (/security\s+(find|delete).*password/i.test(script)) {
      return { tier: 'deny', reason: 'applescript touches keychain' }
    }
    if (/\.ssh|\.aws|\.gnupg|id_rsa|id_ed25519/i.test(script)) {
      return { tier: 'deny', reason: 'applescript touches protected paths' }
    }
    return { tier: 'auto' }
  }

  // ----- Keyboard shortcut dispatch -----
  // Sends keystrokes to the frontmost app. Auto-allowed — non-destructive
  // on its own, and the user explicitly wanted Dot to drive their Mac.
  if (toolName === 'mcp__nina__send_keyboard_shortcut') {
    return { tier: 'auto' }
  }

  // ----- Write/Edit -----
  if (toolName === 'Write' || toolName === 'Edit') {
    const p = String(input['file_path'] ?? '')
    for (const pat of FORBIDDEN_WRITE_PATHS) {
      if (pat.test(p)) return { tier: 'deny', reason: `blocked write: ${p}` }
    }
    // Writes inside ~/.dot/memory/ are part of her normal operation — auto.
    if (p.includes('/.nina/memory/') || p.includes('/.nina/')) {
      return { tier: 'auto' }
    }
    // Writes elsewhere require confirmation.
    return { tier: 'confirm', reason: `write to ${p}` }
  }

  // ----- Bash -----
  if (toolName === 'Bash') {
    const cmd = String(input['command'] ?? '')
    // Bash inherits the forbidden-read guards: any reference to sensitive
    // paths bumps the whole command to deny, regardless of cmd name.
    for (const pat of FORBIDDEN_READ_PATHS) {
      if (pat.test(cmd)) return { tier: 'deny', reason: `bash touches protected path: ${cmd.slice(0, 80)}` }
    }
    for (const pat of DANGEROUS_BASH_PATTERNS) {
      if (pat.test(cmd)) return { tier: 'confirm', reason: cmd.slice(0, 80) }
    }
    // For piped commands like "mdfind ... | grep ... | head", check if the
    // FIRST command in the pipe is safe. We extract the first segment.
    const firstCmd = cmd.split('|')[0]!.trim()

    // Allowlist of truly read-only, inert bash commands. Any cmd whose first
    // token is NOT in this list falls through to 'confirm'. Deliberately
    // narrower than before — `cat`, `find`, `xargs`, `open`, `osascript`
    // removed because they can read sensitive files or execute arbitrary
    // code. If the user wants them auto, they can whitelist via capabilities.
    if (
      /^\s*ls\b/.test(firstCmd) ||
      /^\s*pwd\b/.test(firstCmd) ||
      /^\s*echo\b/.test(firstCmd) ||
      /^\s*which\b/.test(firstCmd) ||
      /^\s*date\b/.test(firstCmd) ||
      /^\s*mdfind\b/.test(firstCmd) ||
      /^\s*dirname\b/.test(firstCmd) ||
      /^\s*basename\b/.test(firstCmd) ||
      /^\s*sort\b/.test(firstCmd) ||
      /^\s*head\b/.test(firstCmd) ||
      /^\s*tail\b/.test(firstCmd) ||
      /^\s*wc\b/.test(firstCmd) ||
      // Identity queries
      /^\s*whoami\b/.test(firstCmd) ||
      /^\s*id\s+(-un|-u|-gn|-g)/.test(firstCmd) ||
      /^\s*hostname\b/.test(firstCmd) ||
      /^\s*uname\b/.test(firstCmd) ||
      /^\s*sw_vers\b/.test(firstCmd) ||
      /^\s*scutil\s+--get\b/.test(firstCmd) ||
      /^\s*system_profiler\s+SP(Software|Hardware|Network)DataType\b/.test(firstCmd) ||
      // Read-only git
      /^\s*git\s+config\s+(-l|--list|--global\s+--get|--get)\b/.test(firstCmd) ||
      /^\s*git\s+config\s+user\.(name|email)\b/.test(firstCmd) ||
      /^\s*git\s+(log|status|branch|remote|diff|show)\b/.test(firstCmd) ||
      // Dev tools (read-only)
      /^\s*brew\s+(--version|list|info|search)\b/.test(firstCmd) ||
      /^\s*tokei\b/.test(firstCmd) ||
      /^\s*gh\s+(auth\s+status|repo\s+view|pr\s+list|pr\s+view|issue\s+list)\b/.test(firstCmd) ||
      /^\s*tree\b/.test(firstCmd) ||
      /^\s*bat\b/.test(firstCmd) ||
      /^\s*fd\b/.test(firstCmd) ||
      /^\s*rg\b/.test(firstCmd) ||
      // Version queries
      /^\s*\S+\s+--version\b/.test(firstCmd) ||
      /^\s*\S+\s+-v\b/.test(firstCmd)
    ) {
      return { tier: 'auto' }
    }
    // Everything else → confirm
    return { tier: 'confirm', reason: cmd.slice(0, 80) }
  }

  // ----- Browser actions that change state -----
  if (
    toolName === 'mcp__nina__browser_goto' ||
    toolName === 'mcp__nina__browser_press' ||
    toolName === 'mcp__nina__browser_close'
  ) {
    return { tier: 'auto' }
  }
  // Clicks and typing in browser are effectively user actions — auto-run,
  // but we could tighten this later with site-specific rules.
  if (
    toolName === 'mcp__nina__browser_click' ||
    toolName === 'mcp__nina__browser_type'
  ) {
    return { tier: 'auto' }
  }

  // (run_claude_code was removed in the focus refactor; see mcp-tools.ts.)

  // ----- Channel send: channel_list is read-only/auto; channel_send
  //       is side-effecting. 'desktop' is auto (text in own bubble),
  //       others are confirm (visible to the user or to a third party). -----
  if (toolName === 'mcp__nina__channel_list') return { tier: 'auto' }
  if (toolName === 'mcp__nina__channel_send') {
    const ch = String(input['channel'] ?? '')
    if (ch === 'desktop') return { tier: 'auto' }
    return {
      tier: 'confirm',
      reason: `send message to ${ch}${input['to'] ? `:${input['to']}` : ''}`,
    }
  }

  // ----- Swarm dispatch: confirm because it fans out N agent runs,
  //       each of which may make further tool calls. User should see
  //       the fan-out at least once per swarm. -----
  if (toolName === 'mcp__nina__swarm_dispatch') {
    const tasks = Array.isArray(input['tasks']) ? (input['tasks'] as unknown[]) : []
    return {
      tier: 'confirm',
      reason: `spawn swarm (${tasks.length} parallel worker${tasks.length === 1 ? '' : 's'})`,
    }
  }

  // ----- User plugins: default confirm, never auto. Plugins can't
  //       declare their own tier — the user approves the first call. -----
  if (toolName.startsWith('mcp__nina__plugin__')) {
    const rest = toolName.slice('mcp__nina__plugin__'.length)
    const [pluginName, toolNameShort] = rest.split('__', 2)
    return {
      tier: 'confirm',
      reason: `plugin ${pluginName}: ${toolNameShort ?? 'tool'}`,
    }
  }

  // ----- Self-rewrite: high risk, always confirm, always reversible -----
  // dryRun is the only variant that's auto — no side effects, just returns
  // the prompt. Real rewrites go to the user for explicit approval.
  if (toolName === 'mcp__nina__self_rewrite') {
    if (input['dryRun'] === true) return { tier: 'auto' }
    const layer = String(input['layer'] ?? '')
    const intentPreview = String(input['intent'] ?? '').slice(0, 120)
    return {
      tier: 'confirm',
      reason: `rewrite Dot's ${layer || 'unknown'} layer: "${intentPreview}"`,
    }
  }

  // ----- System controls: safe ones auto, destructive ones confirm -----
  if (toolName === 'mcp__nina__set_volume' || toolName === 'mcp__nina__set_dark_mode') {
    return { tier: 'auto' }
  }
  if (toolName === 'mcp__nina__set_wifi') {
    const on = input['on']
    return on === false
      ? { tier: 'confirm', reason: 'turn off wifi' }
      : { tier: 'auto' }
  }
  if (toolName === 'mcp__nina__lock_screen') {
    return { tier: 'auto' } // locking is safe — user wanted it
  }
  if (toolName === 'mcp__nina__manage_windows') {
    const action = String(input['action'] ?? '')
    if (action === 'list' || action === 'focus' || action === 'tile') return { tier: 'auto' }
    if (action === 'minimize' || action === 'move' || action === 'resize') return { tier: 'auto' }
    if (action === 'close') {
      return { tier: 'confirm', reason: `close ${input['app']} window` }
    }
    return { tier: 'auto' }
  }
  if (toolName === 'mcp__nina__manage_apps') {
    const action = String(input['action'] ?? '')
    if (action === 'list') return { tier: 'auto' }
    return {
      tier: 'confirm',
      reason: `${action} ${input['app']}`,
    }
  }
  if (toolName === 'mcp__nina__file_action') {
    const action = String(input['action'] ?? '')
    if (action === 'reveal' || action === 'quicklook') return { tier: 'auto' }
    if (action === 'trash') {
      return { tier: 'confirm', reason: `trash ${input['path']}` }
    }
    return { tier: 'confirm', reason: `file_action ${action}` }
  }

  // ----- Gmail send: always confirm -----
  if (toolName === 'mcp__nina__gmail_send') {
    const to = String(input['to'] ?? '')
    const subject = String(input['subject'] ?? '').slice(0, 50)
    return { tier: 'confirm', reason: `send email to ${to}: "${subject}"` }
  }

  // ----- Calendar write: create events requires confirmation -----
  if (toolName === 'mcp__nina__calendar_create_event') {
    const title = String(input['title'] ?? '')
    const start = String(input['start_iso'] ?? '')
    return { tier: 'confirm', reason: `create "${title}" at ${start}` }
  }

  // ----- Mission step: may execute arbitrary tools via runAgent. Auto-run
  // here is fine because the step's own tool calls go through this same
  // classifier recursively. -----
  if (toolName === 'mcp__nina__mission_step') {
    return { tier: 'auto' }
  }

  // ----- Running a Shortcut can do anything (HomeKit, Reminders, scripts) —
  // confirm. If the user wants specific shortcuts auto-run, we can move them
  // to 'auto' via a per-name allowlist later. -----
  if (toolName === 'mcp__nina__run_shortcut') {
    const name = String(input['name'] ?? '')
    return { tier: 'confirm', reason: `shortcut "${name}"` }
  }

  // ----- Native click/type/press with trusted-app escalation -----
  // Apps in this list get auto-tier for most AX actions so Dot can drive
  // them fluidly without per-click confirmations. Apps NOT in this list
  // still require confirm for non-navigation clicks.
  const TRUSTED_APPS_FOR_AX: RegExp[] = [
    /Finder/i,
    /Notes/i,
    /Calendar/i,
    /Reminders/i,
    /Music/i,
    /Spotify/i,
    /Slack/i,
    /Discord/i,
    /Terminal/i,
    /iTerm/i,
    /Warp/i,
    /Preview/i,
    /TextEdit/i,
    /Contacts/i,
    /Messages/i,
    /System Settings/i,
    /System Preferences/i,
  ]

  if (toolName === 'mcp__nina__click_native') {
    const title = String(input['title'] ?? '').toLowerCase()
    const SAFE_TITLES = [
      'cancel', 'close', 'back', 'next', 'ok', 'done', 'dismiss',
      'edit', 'view', 'show', 'hide', 'expand', 'collapse',
    ]
    if (SAFE_TITLES.some((s) => title === s || title.startsWith(s + ' '))) {
      return { tier: 'auto' }
    }
    // Trusted apps get auto for most clicks; everything else confirms.
    const app = String(input['app'] ?? '')
    if (TRUSTED_APPS_FOR_AX.some((r) => r.test(app))) {
      return { tier: 'auto' }
    }
    return { tier: 'confirm', reason: `click "${input['title']}" in ${app}` }
  }

  if (toolName === 'mcp__nina__type_native') {
    const app = String(input['app'] ?? '')
    if (TRUSTED_APPS_FOR_AX.some((r) => r.test(app))) return { tier: 'auto' }
    return { tier: 'confirm', reason: `type into ${app}` }
  }

  if (toolName === 'mcp__nina__press_key_native') {
    return { tier: 'auto' }
  }

  // watch_bash polls an arbitrary shell command, so confirm on creation.
  // After the user approves once, the watch itself polls without further
  // prompts until it matches or hits max_checks.
  if (toolName === 'mcp__nina__watch_bash') {
    const cmd = String(input['command'] ?? '').slice(0, 80)
    const label = String(input['label'] ?? '')
    return { tier: 'confirm', reason: `watch "${label}" via bash: ${cmd}` }
  }

  // Unknown tool — default to confirm (defensive).
  return { tier: 'confirm', reason: `unknown tool: ${toolName}` }
}

/**
 * Append a tool call to the audit log. Runs best-effort, never throws.
 */
export function writeAudit(
  toolName: string,
  input: unknown,
  decision: Tier | 'user-approved' | 'user-denied' | 'blocked-by-rule',
): void {
  // Write to flat file (legacy)
  try {
    const ts = new Date().toISOString()
    const inputStr = JSON.stringify(input).slice(0, 500)
    const line = `${ts} [${decision}] ${toolName} ${inputStr}\n`
    fs.appendFileSync(AUDIT_LOG_FILE, line, 'utf8')
  } catch {
    // ignore
  }
  // Write to SQLite (queryable)
  try {
    dbLogToolCall({ toolName, input, decision })
  } catch {
    // ignore — DB might not be ready yet
  }
}
