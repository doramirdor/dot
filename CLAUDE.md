# Dot

Tiny desktop companion powered by Claude. Electron + React + TypeScript. Lives as a transparent always-on-top pixel sprite in the corner of your screen; also runs headless under launchd as a background daemon; also speaks over Telegram as a mobile client. One memory across all three. Uses `@anthropic-ai/claude-agent-sdk` for all LLM work.

**Codename is "nina", companion's name is Dot.** Data lives in `~/.nina/`.

## Quick context

- Electron main (`src/main/`) owns the window, tray, launchd daemon mode, and startup orchestration.
- Core logic (`src/core/`) is where almost every module lives. The one-line rule: if it's framework-agnostic, it goes in `src/core/`.
- Every agent turn — from desktop chat, Telegram, cron, missions, proactive, morning/diary/reflection rituals, swarm workers — funnels through `core/turn.ts` → `core/agent.ts`.
- Renderer (`src/renderer/`) is React. Pixel sprite in `Pet.tsx`, character registry in `characters.ts`.
- Preload bridge (`src/preload/`) exposes `window.nina.*` to the renderer.

## Run modes

```bash
npm run dev                                    # Electron dev with hot reload
npm run build                                  # Production build
npm run typecheck                              # tsc --noEmit

# Direct invocations after npm run build:
./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
    ./out/main/index.js                        # windowed
./node_modules/.../Electron ./out/main/index.js --headless    # launchd daemon
./node_modules/.../Electron ./out/main/index.js --migrate     # one-shot: import ~/.openclaw / ~/.nanoclaw

# launchd (daemon on login):
./bin/launchd-install.sh install
./bin/launchd-install.sh uninstall
./bin/launchd-install.sh status
./bin/launchd-install.sh tail
```

**Launchd gotcha:** use `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`, NOT `node_modules/.bin/electron`. The `.bin` shim is a sh script launchd can't resolve under its restricted spawn context.

## Source tree

All file paths below are relative to the repo root. When CLAUDE.md (old versions, or comments) says `src/main/foo.ts`, check `src/core/foo.ts` — the move happened early and comments sometimes lag.

### `src/main/` — Electron process

| File | Purpose |
|------|---------|
| `index.ts` | Window + tray, `--headless` + `--migrate` flags, startup orchestration, IPC handlers. Wires everything else in. |
| `capabilities.ts` | First-run capabilities window (mic/accessibility/automation prompts). |
| `claude-code.ts` | Bridge to the `claude` CLI used by `self_rewrite`. |

### `src/core/` — framework-agnostic core

#### Entry primitive
- `turn.ts` — **the** unified entry point for every agent run. Collects situational context (time, idle, budget, queue, missions, cron), scores the previous action into RL, wraps callbacks, records the new action after `onDone`.
- `agent.ts` — `claude-agent-sdk` wrapper. Builds system prompt (personality + capabilities + situation + RL advisory + memory + recall + onboarding), picks provider, applies env, calls `query()`, streams results, logs token usage.

#### Memory
- `memory.ts` — path constants (`NINA_DIR`, `MEMORY_DIR`, `INDEX_FILE`, `PERSONALITY_FILE`), seed content, onboarding prompts. **Import paths from here — never hardcode `~/.nina/...`.**
- `memory-service.ts` — facade over recall + remember with query rewriting, recency + type boost, heuristic fact extraction (`reflect()`).
- `semantic-memory.ts` — sqlite-vec embedding store. `Xenova/all-MiniLM-L6-v2`, 384-dim. Exposes `recall`, `remember`, `rememberFact`, `rememberConversation`.
- `embed.ts` — embedding model loader.
- `consolidation.ts` — **20-min background loop.** Heuristic fact extraction over the last 2 hours + mindmap regeneration. No LLM call, no token cost. Keeps memory fresh between nightly reflections.
- `reflection.ts` — nightly deep reflection (runs at `reflectionHour`).
- `diary.ts` — daily diary.
- `morning.ts` + `morning-loop.ts` — morning ritual.
- `soul.ts` — personality + onboarding state machine, quirks, nudge budget, farewell messages.

#### RL — contextual bandit
- `rl/schema.ts` — `~/.nina/rl.db` tables: `replay_buffer`, `daily_summary`, `policy`, `priors`.
- `rl/replay-buffer.ts` — `recordAction`, `updateReward`, state helpers.
- `rl/policy.ts` — `updatePolicy` (SQL `GROUP BY`), `recommendations`, `explorationSuggestion`, `generateReport`, `seedDefaultPriors`.
- `rl/reward-signals.ts` — observable-reward collectors: reply latency, keyword-heuristic sentiment, `/feedback good|bad`, tool-call success/block.
- `rl/index.ts` — `initRL()` on boot (starts 10-min sweeper + 60-min policy rebuild + daily summary writer), `reportForCurrent()`.

#### Providers (multi-model)
- `providers.ts` — `listProviders`, `resolveActiveProvider`, `applyProvider`, `setPreferredProvider`, `storeProviderCredential`. Supported: Anthropic (direct), Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`), Vertex (`CLAUDE_CODE_USE_VERTEX=1`). OpenAI: credential storage only (Agent SDK does not route to it yet).

#### Channels
- `channels/index.ts` — `Channel` interface + registry (`registerChannel`, `getChannel`, `listChannels`).
- `channels/desktop-channel.ts` — adapter over the Electron window IPC.
- `channels/telegram-channel.ts` — adapter over `telegram.ts`.

#### Self-rewrite + sandbox
- `self-rewrite.ts` — four layers: `core` → `src/core/`, `skills` → `~/.nina/plugins/`, `brain` → `~/.nina/memory/`, `heart` → `PERSONALITY.md`. Tar-snapshots the layer into trash, then spawns `claude --print` inside a container (or on host if `allowUnsandboxed`). Reversible via `dot_undo <id>`.
- `sandbox.ts` — generic `runInContainer()`. Backends in preference order: Apple Container (macOS 15+) → Docker → fail-closed (or in-process if `allowUnsandboxed`). `probeSandbox()` round-trips an `echo ok`. Default image: `node:20-slim` (override via `DOT_SANDBOX_IMAGE`).

#### Plugins
- `plugin-loader.ts` — scans `~/.nina/plugins/*/plugin.mjs` at boot, validates `DotPlugin` shape, prefixes tool names `mcp__nina__plugin__<plugin>__<tool>`, merges into MCP server. Defaults to confirm-tier trust.

#### Swarms
- `swarm.ts` — `spawnSwarm(tasks, opts)`. Each worker gets a workspace at `~/.nina/swarm/<runId>/<i>/`, fresh session, tight worker-scope tool allowlist. Bounded concurrency (default 3, max 8), per-task timeout (default 3 min).

#### Trust / audit
- `trust.ts` — `classifyToolCall` — auto / confirm / deny per tool name. Hardcoded bash dangerous-pattern and forbidden-path lists.
- `policy-service.ts` — single `authorize()` funnel: classify → audit → background fail-closed → permission-bus prompt → audit outcome.
- `permission-bus.ts` — IPC-based permission request/response, 2-min timeout.
- `safe-ops.ts` — `safeDeleteFile`, `safeWriteFile`, `undoOperation`, `listRecentOps`, `getTrashStats`. Everything destructive passes through here. Also handles the `self.rewrite` undo case (untar snapshot back into place).

#### Channels / output surfaces (transport)
- `telegram.ts` — long-poll transport, per-chat memory, confirm inline-keyboards, photo replies, proactive push. The `telegram-channel.ts` adapter wraps this.

#### Scheduled + reactive
- `cron.ts` — 5-field cron, state in `~/.nina/cron.json`.
- `missions.ts` — long-running missions with check-ins. State at `~/.nina/missions/<id>/`.
- `autonomy.ts` — autonomous behavior loop.
- `proactive.ts` — rate-limited proactive suggestions.
- `observation.ts` — screen + activity observer wiring.
- `screen-watcher.ts` — continuous screen snapshots.
- `clipboard.ts` — clipboard history.
- `watch.ts` — poll a bash command or URL and ping on match.
- `bg-queue.ts` — serialized background-agent queue with the daily-budget gate.

#### Integrations
- `gmail.ts` — OAuth + search + read + send + labels.
- `calendar.ts` — Google Calendar (OAuth, events, free/busy).
- `mail.ts` — macOS Mail.app via AppleScript fallback.
- `browser.ts` — Playwright w/ persistent Chromium profile.
- `native-ax.ts` — Swift helper for macOS accessibility (click, type, read window).
- `app-index.ts` — installed-apps cache with fuzzy resolution, self-heal on miss.
- `shortcuts-bus.ts` — macOS Shortcuts runner.
- `system-control.ts` — volume, dark mode, wifi, windows, apps, files, AppleScript, keyboard-shortcuts.
- `notify.ts` — native macOS notifications.
- `presence.ts` — idle seconds, screen locked, "Mac is away" gate.
- `voice.ts` — Whisper STT + macOS `say` TTS + optional Groq fallback (M8 wiring in progress).
- `keychain.ts` — `security` CLI wrapper for secrets. Default service `dot`.
- `config.ts` — `~/.nina/config.json` loader with 30s cache. Also the legacy `loadAnthropicToken` (see `providers.ts` for the multi-provider path).

#### Database + observability
- `db.ts` — `~/.nina/nina.db`: `conversations`, `tool_calls`, `events`, `token_usage`, `undo_log`.
- `log.ts` — audit log helper.
- `dashboard.ts` — generates `~/.nina/dashboard.html` with cost, queue, cron, missions, trash, events.
- `nadirclaw.ts` — read-only stats from the NadirClaw LLM router (optional).

#### Migration
- `migrate.ts` — import state from `~/.openclaw` + `~/.nanoclaw` when run with `--migrate`.

### `src/renderer/`

| File | Purpose |
|------|---------|
| `App.tsx` | React UI state + IPC wiring. |
| `Pet.tsx` | Pixel sprite (inline SVG, 16×16 grid × 8px cells). |
| `characters.ts` | Character cast: `dot`, `dot-sleepy`, `dot-focused`, `dot-excited`, `dot-concerned`, `dot-playful`, `dot-rainbow`. Palette + wrap class per form. |
| `styles.css` | CSS animations: per-character wrap classes + one-shot gestures (nuzzle, sparkle, stretch, peek). |
| `voice.ts` | Mic recording + PCM submit to main. |
| `types.d.ts` | `window.nina.*` preload bridge typing. |

## Data directory (`~/.nina/`)

```
~/.nina/
├── config.json             runtime config (provider, budget, cadences)
├── nina.db                 SQLite: conversations, tool_calls, events, token_usage, undo_log
├── rl.db                   SQLite: replay_buffer, daily_summary, policy, priors
├── cron.json               recurring task definitions
├── app-index.json          installed-apps cache (daily + on-miss rescan)
├── dashboard.html          observability dashboard
├── memory/
│   ├── MEMORY.md           memory index — injected into system prompt
│   ├── PERSONALITY.md      Dot's character (heart layer)
│   ├── mindmap.md          auto-refreshed every 20 min by consolidation.ts
│   ├── audit.log           tool-call audit trail
│   └── imported/           migrated openclaw + nanoclaw state
├── missions/<id>/          mission.md + log.md + artifacts/
├── swarm/<runId>/          per-worker workspaces (001/, 002/, ...) + swarm.json index
├── plugins/                user plugins — see plugin-loader.ts
├── trash/<iso-ts>-<rand>/  every destructive op lands here + self-rewrite snapshots
├── logs/                   dot.out.log, dot.err.log (launchd)
├── browser-profile/        Playwright persistent Chromium profile
├── screen-watcher/         recent screen frames
├── clipboard-history.json
└── .import-marks.json      migrate.ts idempotency marks
```

## Config (`~/.nina/config.json`)

```jsonc
{
  // Cadences — all intervals in milliseconds
  "observationIntervalMs": 900000,
  "screenWatcherIntervalMs": 180000,
  "proactiveMinIntervalMs": 1800000,
  "reflectionHour": 21,
  "diaryHour": 22,
  "diaryMinute": 30,

  // Soft daily spend cap (USD). 0 = no cap.
  // Blocks BACKGROUND jobs when exceeded. Foreground chat always runs.
  "dailyBudgetUsd": 0,

  // Provider (multi-model routing via providers.ts).
  "provider": "anthropic",   // or "bedrock" | "vertex"
  "model": "claude-opus-4-7", // optional; SDK default if unset
  "providers": {
    "bedrock": { "model": "us.anthropic.claude-opus-4-20250805-v1:0" }
  },

  // Telegram. telegramBotToken is in macOS Keychain under account "telegram-bot-token".
  // Allowlist + primary chat stay here.
  "telegramAllowedChatIds": [],
  "telegramPrimaryChatId": null,

  // Voice (in progress). STT local via Whisper; fallback Groq when set.
  "groqApiKey": null,
  "voiceDefaultOn": false
}
```

## Auth

Anthropic credential loading order (see `providers.ts`):

1. **macOS Keychain** — service `dot`, account `anthropic-token` (the only long-term home).
2. `CLAUDE_CODE_OAUTH_TOKEN` env var.
3. `ANTHROPIC_API_KEY` env var.

**Dot no longer auto-reads `~/.openclaw/agents/main/agent/auth-profiles.json`.** The setup skill probes for it via `findLegacyOpenclawToken()` and offers an explicit "import into Keychain" action — Dot never steals silently.

At runtime, if no credential is present on boot, Dot opens a **provider-setup window** (`src/main/provider-setup.ts`) that lists Anthropic / Bedrock / Vertex / OpenAI, takes a pasted key, and exposes the openclaw import as an opt-in checkbox. The same window is re-openable anytime from the tray **Setup provider…** item or by typing **`/provider`** (or `/setup`) in the chat. Headless mode skips the prompt and surfaces a clear error on the first failed turn.

Bedrock uses the standard AWS credential chain (`~/.aws/credentials`, env vars, IAM role). Vertex uses `GOOGLE_APPLICATION_CREDENTIALS` or gcloud ADC at `~/.config/gcloud/application_default_credentials.json`.

## Skills

| Skill | When |
|-------|------|
| `/setup` | First-time install — deps, Keychain credential, optional container runtime, optional Telegram, optional provider switch, launchd install. Located at `.claude/skills/setup/SKILL.md`. Walks everything without asking the user to paste commands. |

## What Dot can do

**Ambient presence**: corner pet, headless launchd daemon, Telegram bot — all sharing one memory.

**Self-learning**: contextual bandit over `rl.db`. Rewards observed (reply latency, sentiment, `/feedback`, tool outcomes), never self-reported. Policy advisory, rebuilt hourly.

**Self-modifying**: `self_rewrite` over four layers (core/skills/brain/heart). Tar-snapshot per run. `dot_undo <id>` restores. Runs in Apple Container or Docker; fails closed if no runtime.

**Multi-provider**: route through Anthropic / Bedrock / Vertex via config or the `provider_use` MCP tool.

**Extensible**: drop `~/.nina/plugins/<name>/plugin.mjs` → tools show up on next boot.

**Parallel work**: `swarm_dispatch` fans out up to 8 sub-agents with per-task workspaces.

**Mood expression**: seven character forms (sleepy, focused, excited, concerned, playful, rainbow), one-shot gestures (nuzzle, sparkle, stretch, peek). Dot picks her own via `set_character`.

**Reversible**: every destructive op goes through `safe-ops.ts` → `~/.nina/trash/<ts>/` + an `undo_log` row. `dot_undo <id>` reverses.

**Native mac control**: AppleScript (`run_applescript`), installed-app index (`find_app`, `manage_apps`), Shortcuts (`run_shortcut`), keyboard shortcuts (`send_keyboard_shortcut`), Gmail, Calendar, Mail.app, system settings (volume, dark mode, wifi, windows), screen + clipboard + native accessibility.

**Cadence**: cron, missions, proactive (presence-gated), morning / diary / reflection rituals, 20-min memory consolidation.

## What Dot cannot do (yet)

- **M8 Voice**: Whisper STT + wake word + macOS `say` TTS — scaffolding exists in `voice.ts` and config reserves `groqApiKey`, but the full loop isn't live.
- Inline-keyboard multi-step confirmation flows on Telegram beyond the existing yes/no pattern.
- Telegram inbound file / photo / document uploads.
- Full test coverage (zero tests today — reversibility is the current safety net).
- Multi-user auth / trust tiers (fixed decision: single-user).

## Development principles

1. **No half-finished implementations.** Ship one thing correctly over three at 80%.
2. **Reversibility over cleverness.** Every destructive op is recoverable. Disk is cheap; regrets are expensive.
3. **Foreground never blocks.** Background jobs can be queued, gated, or capped. User chat always runs.
4. **Daemon mode is first-class.** If it only works windowed, it's half-built.
5. **Path constants are the source of truth.** Import from `core/memory.ts` — never hardcode `~/.nina/`.
6. **Every destructive MCP tool has a reversible variant.** Prefer `safe_write_file` / `safe_delete_file` over `Write` / `Bash rm` in paths where rollback matters.

## Fixed decisions (do not revisit without explicit user request)

- **Single-user.** No multi-user, no family, no collaborators.
- **Local-first voice.** Whisper local, macOS `say` local. Groq optional fallback.
- **Proactive push to Telegram only when Mac is away.** Presence gate: locked OR asleep OR idle ≥ 30 min.
- **Voice defaults off.** Opt in per chat.

## Pointers for Claude Code

- Changing memory behavior: start at `core/memory-service.ts`, read `core/consolidation.ts`, then `core/reflection.ts`.
- Adding a tool: `core/mcp-tools.ts` (one tool = one `tool(...)` entry), then add name to the `allowedTools` list in `core/agent.ts`, then classify in `core/trust.ts`.
- Adding a channel: new file in `core/channels/`, register via `registerChannel()` in `main/index.ts`.
- Adding a provider: extend `core/providers.ts` registry — but note the Agent SDK only supports Anthropic + Bedrock + Vertex today.
- Adding a character form: new entry in `renderer/characters.ts` CHARACTERS map + corresponding `pet-char-<id>` CSS class in `renderer/styles.css`.
