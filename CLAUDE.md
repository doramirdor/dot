# Dot

Tiny desktop companion powered by Claude. Electron + React + TypeScript app that lives as a transparent always-on-top pixel sprite in the corner of your screen. Also runs headless under launchd as a background daemon, and speaks over Telegram as a mobile client. Uses Claude Agent SDK for all AI capabilities.

## Quick Context

Electron main process runs Claude Agent SDK with MCP tools for screen control, browser automation, calendar, Gmail, memory, native accessibility, cron, and Telegram. Renderer is a React pixel-pet UI with speech bubbles. Data stored in `~/.nina/` (SQLite DB, memory, missions, trash, dashboard). The project codename is "nina" but the companion's name is **Dot**.

**Data directory is `~/.nina/`** — earlier docs called it `~/.dot/` but the actual path is `~/.nina/`. Always check the real paths in `src/main/memory.ts` (`NINA_DIR`) and `src/main/db.ts`.

## Run modes

```bash
npm run dev                                    # Electron dev server with hot reload
npm run build                                  # Production build
npm run typecheck                              # Type checking

# Direct invocations (after npm run build):
./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
    ./out/main/index.js                        # Normal: window + tray + proactive
./node_modules/.../Electron ./out/main/index.js --headless    # Daemon mode
./node_modules/.../Electron ./out/main/index.js --migrate     # One-shot import from openclaw/nanoclaw

# launchd management:
./bin/launchd-install.sh install               # Install LaunchAgent, starts on login
./bin/launchd-install.sh uninstall             # Remove
./bin/launchd-install.sh status                # Is it running?
./bin/launchd-install.sh tail                  # Live-tail logs
```

**Note for launchd:** use the real Electron binary path inside `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`, NOT the `node_modules/.bin/electron` shim. The shim is a sh script that launchd cannot resolve under its restricted spawn context.

## Key files (updated)

| File | Purpose |
|------|---------|
| `src/main/index.ts` | Electron main, window + tray wiring, `--headless` + `--migrate` flags, startup orchestration |
| `src/main/agent.ts` | Claude Agent SDK wrapper, system prompt, trust-layer callback |
| `src/main/config.ts` | Config load from `~/.nina/config.json`, Anthropic credential loading |
| `src/main/db.ts` | SQLite: conversations, tool_calls, events, token_usage, **undo_log** |
| `src/main/memory.ts` | Memory index (MEMORY.md), personality, mindmap, `NINA_DIR` constant |
| `src/main/semantic-memory.ts` | Embedding-based recall via sqlite-vec + Xenova transformers |
| `src/main/embed.ts` | Embedding model loader (Xenova/all-MiniLM-L6-v2, 384-dim) |
| `src/main/mcp-tools.ts` | MCP tool server — all agent-facing tools registered here |
| `src/main/native-ax.ts` | Native macOS accessibility (Swift shim) |
| `src/main/soul.ts` | Personality / onboarding system |
| `src/main/gmail.ts` | Gmail integration (OAuth, read/send/label) |
| `src/main/calendar.ts` | Google Calendar integration |
| `src/main/mail.ts` | macOS Mail.app via AppleScript |
| `src/main/browser.ts` | Playwright browser automation with persistent profile |
| `src/main/claude-code.ts` | Bridge to `claude-code` CLI for coding tasks |
| `src/main/autonomy.ts` | Autonomous behavior loop |
| `src/main/proactive.ts` | Proactive suggestions, rate-limited |
| `src/main/observation.ts` | Screen/activity watcher wiring |
| `src/main/screen-watcher.ts` | Continuous screen snapshotting |
| `src/main/clipboard.ts` | Clipboard history |
| `src/main/missions.ts` | Long-running missions with check-ins |
| `src/main/morning.ts` | Morning ritual |
| `src/main/diary.ts` | Daily diary |
| `src/main/reflection.ts` | Daily reflection |
| `src/main/trust.ts` | Tool call classification (auto / confirm / deny) |
| `src/main/permission-bus.ts` | UI-side permission prompt bus |
| `src/main/nadirclaw.ts` | Read-only stats from NadirClaw LLM router |
| `src/main/system-control.ts` | Volume, dark mode, wifi, windows, apps, files |
| `src/main/shortcuts-bus.ts` | macOS Shortcuts runner |
| `src/main/notify.ts` | Native macOS notifications |
| `src/main/presence.ts` | Presence detection |
| `src/main/capabilities.ts` | First-run capabilities window |
| `src/main/cron.ts` | **NEW:** Recurring scheduled tasks, 5-field cron, state in `~/.nina/cron.json` |
| `src/main/bg-queue.ts` | **NEW:** Serialized background-agent queue with daily-budget gate |
| `src/main/migrate.ts` | **NEW:** Import state from `~/.openclaw` and `~/.nanoclaw` |
| `src/main/telegram.ts` | **NEW:** Telegram Bot channel (long-poll, per-chat memory, photo replies, proactive push) |
| `src/main/dashboard.ts` | **NEW:** Observability — generates HTML dashboard at `~/.nina/dashboard.html` |
| `src/main/safe-ops.ts` | **NEW:** Reversible destructive ops — trashing, snapshot-before-write, undo log |
| `src/main/app-index.ts` | **NEW:** Installed-apps index with fuzzy resolution, persistence, and self-heal on miss |
| `src/main/keychain.ts` | **NEW (by user):** macOS Keychain bridge — stores Anthropic + Telegram tokens outside config.json |
| `src/renderer/App.tsx` | React UI: state, IPC, input handling |
| `src/renderer/Pet.tsx` | Pixel sprite component |
| `bin/launchd-install.sh` | **NEW:** macOS launchd agent installer for daemon mode |
| `MOBILE.md` | **NEW:** Mobile architecture design doc, options A-D analyzed |
| `STATUS.md` | **NEW:** Current project state, capabilities, gaps |

## Data directory layout (`~/.nina/`)

```
~/.nina/
├── config.json             # runtime config, budgets (tokens migrated to macOS Keychain)
├── nina.db                 # SQLite: conversations, tool_calls, events, token_usage, undo_log
├── cron.json               # recurring task definitions
├── app-index.json          # installed-apps cache (rescans daily + on miss + on morning ritual)
├── dashboard.html          # observability dashboard (regenerated on demand)
├── memory/
│   ├── MEMORY.md           # memory index (injected into system prompt)
│   ├── PERSONALITY.md      # Dot's character
│   ├── mindmap.md
│   ├── audit.log           # tool call audit trail
│   └── imported/
│       ├── openclaw/       # migrated memory files
│       └── nanoclaw/       # migrated group contexts
├── missions/<id>/          # per-mission markdown + artifacts
│   ├── mission.md
│   ├── log.md
│   └── artifacts/
├── trash/<iso-ts>-<rand>/  # reversible deletions — never rm, always mv here
├── logs/
│   ├── dot.out.log         # launchd stdout
│   └── dot.err.log         # launchd stderr
├── browser-profile/        # Playwright persistent Chromium profile
├── screen-watcher/         # recent screen frames
├── clipboard-history.json
└── .import-marks.json      # migrate.ts idempotency marks
```

## Key config fields (`~/.nina/config.json`)

```jsonc
{
  "observationIntervalMs": 900000,
  "screenWatcherIntervalMs": 45000,
  "reflectionHour": 21,
  "diaryHour": 22,
  "diaryMinute": 30,
  "proactiveMinIntervalMs": 1800000,

  // Budget gate — 0 = no cap. Blocks background (not foreground) jobs when exceeded.
  "dailyBudgetUsd": 0,

  // Telegram channel. telegramBotToken is auto-migrated to macOS Keychain
  // on first boot (see src/main/keychain.ts) and scrubbed from config.json.
  // The allowlist and primary chat stay here in plaintext.
  "telegramAllowedChatIds": [<your chat id>],
  "telegramPrimaryChatId": <your chat id>, // where proactive push goes

  // Voice (Session 1b — not yet wired)
  // If set, enables Groq-hosted Whisper as a fallback for fast STT.
  // Default STT is local Whisper. TTS is local macOS `say`.
  "groqApiKey": "<optional>",
  "voiceDefaultOn": false
}
```

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation: deps, credentials, native build, first run |

## Auth

Dot reads Anthropic credentials in this order:
1. `~/.openclaw/agents/main/agent/auth-profiles.json` → `anthropic:default` profile
2. `CLAUDE_CODE_OAUTH_TOKEN` env var
3. `ANTHROPIC_API_KEY` env var

## Current capabilities summary

Dot can:
- Run in the corner of your screen as an always-on pet, OR headless as a launchd daemon
- Answer on Telegram from your phone, with per-chat memory separated from desktop memory
- Reply with photos on Telegram (screenshot tool auto-relays PNG when called in a Telegram context)
- Push proactive messages to your phone when it decides to say something (gated on presence — only when Mac is away)
- Run recurring scheduled tasks (cron) with full tool access
- Import legacy state from openClaw + nanoClaw (`--migrate`)
- Reversibly delete and overwrite files — every destructive op goes through `safe-ops.ts` and is logged to `undo_log` so `dot_undo <id>` can restore
- Regenerate an HTML observability dashboard showing cost, queue, cron, missions, trash, events, conversations, tool calls
- Enforce a soft daily spend cap that blocks background jobs but never blocks user chat
- **Drive ANY scriptable macOS app via AppleScript** (`run_applescript`) — Mail, Calendar, Reminders, Notes, Music, Photos, Safari, Chrome, Messages, Contacts, Finder, Pages, Numbers, Keynote, and anything else with a scripting dictionary
- **Launch, activate, quit, or list any installed app** (`manage_apps` with `launch` / `list_installed` / `activate` actions)
- **Send keyboard shortcuts to the frontmost app** (`send_keyboard_shortcut`) for apps that aren't fully scriptable
- **Open any URL or file with the system default handler** (`open_with_default`)
- Control browser, screen, native windows, Gmail, Calendar, macOS Mail, system settings, Shortcuts, clipboard
- Remember across days via semantic memory + personality + mindmap files

Dot CANNOT (yet):
- Run inline-keyboard confirmation flows on Telegram
- Process voice notes (STT) or reply with voice (TTS)
- Handle file/photo/document uploads from Telegram
- Multi-model fallover (hardcoded to Anthropic)
- True shadow-workspace sandboxing (reversibility is the current substitute)
- Full test coverage (zero tests exist)
- Multi-user auth / trust tiers
- Per-channel tone beyond Telegram (desktop and cron inherit base personality)

See `STATUS.md` for the full living snapshot and `MOBILE.md` for the mobile roadmap.

## Development principles

1. **No half-finished implementations.** Prefer shipping one thing correctly over three things 80% done.
2. **Reversibility over cleverness.** Every destructive op should be recoverable. Disk is cheap, regrets are expensive.
3. **Foreground never blocks.** User chat always runs. Background jobs (cron, missions, autonomy) can be gated, queued, or capped, but typing at Dot always works.
4. **Daemon mode is first-class.** If it only works in windowed mode, it's half-built.
5. **Path constants are the source of truth.** Don't hardcode `~/.nina/...` — import from `memory.ts`.
6. **Every destructive MCP tool must have a reversible variant.** Regular `Write` / `Edit` / `Bash rm` should be replaced with `safe_write_file` / `safe_delete_file` in paths where users might want to roll back.

## Fixed decisions (do not revisit without explicit user request)

- **Dot is single-user.** No multi-user, no family, no collaborators. Trust and auth stay solo.
- **STT/TTS is local-first.** Default: Whisper locally, macOS TTS locally. Optional fallback to Groq for hosted Whisper when `groqApiKey` is set in config. Never send voice to any other provider silently.
- **Proactive push to Telegram only when Mac is away.** Gate on: screen locked, machine asleep, OR user idle ≥ 30 minutes. Presence detection module is a prerequisite before full proactive push is enabled.
- **Voice defaults off.** `/voice on` per chat opts in. Desktop Dot does not speak unless explicitly asked.
