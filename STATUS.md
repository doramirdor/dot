# Dot · Project Status

Living snapshot. Updated when meaningful work ships.

**Last updated:** 2026-04-15 (session 7: Mac apps access + app index + security hardening)

---

## What Dot is, today

A local-first personal assistant that runs on your Mac as an Electron pet, as a headless launchd daemon, and as a Telegram bot on your phone — all at once, sharing one brain, memory, and configuration. Built on the Claude Agent SDK. Stores everything at `~/.nina/`.

It's not Claude Code (no coding-specialist depth).
It's not nanoClaw (no container isolation, no group chats).
It's not openClaw (no multi-channel gateway, no plugin system).

It's the thing that *persists*, *remembers*, *notices*, and *acts on its own* — the ambient layer none of the others try to be.

---

## Built across recent sessions

### Session — Phase 1: cron + migration
- **`src/main/cron.ts`** — 5-field cron expression parser with wildcards, steps, ranges, lists. Supervisor ticks every 20s, matches tasks against local time, routes fires through `bg-queue`. State at `~/.nina/cron.json`. Each task stores name, cron expr, prompt, enabled flag, last run + status + summary, run count.
- **`src/main/migrate.ts`** — one-shot idempotent importer:
  - Reads `~/.openclaw/memory/` → copies markdown into `~/.nina/memory/imported/openclaw/`
  - Reads `~/.openclaw/identity/identity.json` → stashes as a reference memory file
  - Reads `~/.nanoclaw/store/messages.db` → imports messages into `conversations` table as `nanoclaw-import` session type
  - Reads `~/.nanoclaw/groups/<id>/CLAUDE.md` → stashes as reference memories
  - Tracks progress in `~/.nina/.import-marks.json` so re-runs don't duplicate
  - New CLI flag `--migrate` runs headless and exits
- **New MCP tools:** `cron_create`, `cron_list`, `cron_run_now`, `cron_delete`, `cron_toggle`, `migrate_from_claws`

### Session — Phase 2: headless daemon + bg-queue
- **`src/main/bg-queue.ts`** — serialized FIFO queue for background agent runs. Max depth 50. Cap check against `dailyBudgetUsd`. Cron fires go through here so concurrent fires can't stampede the API.
- **`--headless` CLI flag** — skips window, tray, hotkey, screen watcher, clipboard watcher. Keeps memory, db, cron, missions, reflection, diary, observation (rerouted to native notifications + Telegram push), and Telegram.
- **macOS `app.dock?.hide()`** in headless mode so Dot runs as a true background process
- **New MCP tool:** `bg_queue_status`

### Session — Phase 3: Telegram channel
- **`src/main/telegram.ts`** — long-poll Telegram bot (no webhook, no public URL needed). Token loaded from config or env. Per-chat allowlist enforced. Built-in commands `/start`, `/status`, `/clear`.
- **Per-chat conversation memory** — each Telegram chat has its own session type `tg:<chatId>` in the `conversations` table. Last 12 turns are loaded and injected as history context before each agent run. Desktop Dot and Telegram Dot don't leak context into each other.
- **Per-channel tone hint** — Telegram prompts include `[channel: telegram — 1-3 short sentences, no markdown, no preamble]` so replies stay phone-readable
- **`/clear` command** — tombstones history by renaming session type to `tg-archived:<chatId>`, preserving audit trail
- **New MCP tools:** `telegram_status`

### Session — Phase 4: observability + budget + reversibility
- **`src/main/dashboard.ts`** — generates a dark-themed HTML dashboard at `~/.nina/dashboard.html`. Shows cost breakdown (today/7d/lifetime), cost-by-model, bg queue state, Telegram status, cron tasks with history, missions, trash summary, last 200 events, last 50 conversations grouped by session, last 100 tool calls with decisions, recent destructive ops.
- **Soft daily budget cap** — `dailyBudgetUsd` in config. bg-queue blocks background jobs if today's cost exceeds it. Foreground chat is unaffected so you can always talk to Dot to decide what to do.
- **`src/main/safe-ops.ts`** — the reversibility foundation:
  - `safeDeleteFile(path, reason)` — moves to `~/.nina/trash/<iso-ts>-<rand>/<rel-path>/` instead of `rm`
  - `safeWriteFile(path, content, reason)` — snapshots prior contents to trash before writing, or records "this file didn't exist" for new-file creations
  - `undoOperation(undoId)` — reverses `file.delete`, `file.overwrite`, `file.create`
  - Guardrails: refuses to trash anything outside `$HOME`, refuses `$HOME` itself, refuses `~/.nina`, refuses trashing the trash dir
- **`undo_log` table** in `nina.db` — records every destructive op with reversible flag, reversal steps JSON, reversed_at, agent_reason. Indexed.
- **New MCP tools:** `safe_delete_file`, `safe_write_file`, `dot_undo`, `dot_trash_status`, `dot_timeline`

### Session — Phase 6: universal Mac app access + app index + security hardening

- **`src/main/system-control.ts`** — new primitives: `launchApp`, `openFileWithApp`, `openWithDefault`, `listInstalledApps`, `runAppleScript`, `sendKeyboardShortcut`
- **`src/main/app-index.ts`** — NEW module. Scans `/Applications`, `~/Applications`, `/System/Applications`, `/System/Applications/Utilities` (+1 level deep) and persists to `~/.nina/app-index.json`. Fuzzy resolver: exact → starts-with → contains → subsequence. Self-heals: on a missed lookup, rescans automatically. Refresh triggers: startup, morning ritual, hourly daemon check (rescan if ≥ 23h old), explicit `scan_apps` tool.
- **`src/main/mcp-tools.ts`** — new tools: `run_applescript`, `open_with_default`, `send_keyboard_shortcut`, `scan_apps`, `find_app`. `manage_apps` gained `launch` / `list_installed` / `activate` actions and all app-resolving actions go through the fuzzy index.
- **`src/main/capabilities.ts`** — new capability `drive_mac_apps` with AppleScript + keystroke + default handler tools.
- **`src/main/trust.ts`** — classified all new tools (auto-allowed with keychain/credential deny-guards for AppleScript).
- **`src/main/agent.ts`** — **critical fix**: all 17 tools from phases 1-5 were missing from `allowedTools` list, meaning the Agent SDK was filtering them out and the agent couldn't call any of them. Only 2 tool calls had ever been logged across the entire project history because of this. Added cron_*, telegram_*, dot_*, safe_*, migrate_*, presence_check, bg_queue_status, plus the new app tools. This single commit unlocked ~20 pieces of invisible work.
- **`src/main/morning.ts`** — fires `scanApps()` at the start of every morning ritual so Dot picks up overnight-installed apps.
- **`src/main/index.ts`** — startup scan on every launch, plus a daemon-mode hourly check that rescans if the index is ≥ 23h old (covers long-running headless instances).
- **`src/main/presence.ts`** — absolute paths (`/usr/sbin/ioreg`) so it works inside launchd's restricted PATH context. Was failing on every call before; silently.
- **`bin/launchd-install.sh`** — plist now includes `/usr/sbin:/sbin` in PATH. Was missing, breaking presence.ts under the daemon.
- **Security hardening (by user)**:
  - `src/main/keychain.ts` — new module bridging Anthropic + Telegram bot tokens through macOS Keychain. Auto-migration on first boot scrubs tokens from `~/.nina/config.json`.
  - `src/main/telegram.ts` — refuses to boot Telegram if allowlist is empty/missing. Previously, an empty allowlist meant "allow all," which was a footgun.
  - `src/main/agent.ts` — new `ChannelContext` interface and `channelContext` field on `RunOptions`. Each entrypoint (desktop, telegram, cron, mission, proactive, morning, reflection) now passes a "situational frame" through to the system prompt so Dot knows where/why she's running.
  - `src/main/bg-queue.ts` — `BgJob` gained an optional `channelContext` field that passes through to runAgent.
  - `src/main/cron.ts`, `src/main/morning.ts`, `src/main/telegram.ts` — all updated to pass `channelContext`.

### Session — Phase 5: mobile polish (1a)
- **`pushToTelegram(chatId, text)`** — exported from `telegram.ts`, used by observation loop in both headless and windowed modes
- **`sendPhotoToTelegram(chatId, base64, caption)`** — multipart upload via Telegram `sendPhoto`. Handles `data:image/` prefix stripping.
- **Current-chat context tracking** — module-level `currentContextChatId` set during `handleMessage`, read by `telegram_reply_photo` MCP tool so the agent can send images without passing a chat id
- **Proactive push to primary chat** — `telegramPrimaryChatId` config field. When observation/autonomy decides to say something, it's routed to your phone too (in both run modes)
- **Persistent daemon** — `bin/launchd-install.sh` (install / uninstall / status / tail), generates a LaunchAgent plist that runs `--headless` with KeepAlive-on-crash, RunAtLoad, 30s throttle, logs to `~/.nina/logs/dot.{out,err}.log`
- **`MOBILE.md`** — full design doc with four architecture options (Telegram, native iOS, PWA, cloud-hosted), ranked with tradeoffs. Recommendation: stay on Option A (Telegram) through 2 more sessions.
- **New MCP tools:** `telegram_reply_photo`

---

## What Dot can do, right now

### Run modes
- [x] **Windowed pet mode** — transparent always-on-top sprite with speech bubbles
- [x] **Headless daemon mode** — no window, no tray, runs under launchd
- [x] **One-shot migration mode** — `--migrate` imports from openclaw/nanoclaw and exits
- [x] **Auto-start on login** (launchd)
- [x] **Auto-restart on crash** (launchd KeepAlive)

### Channels
- [x] Desktop speech bubble
- [x] Telegram bot (`@Nina_dot_bot` for this setup)
- [x] Native macOS notifications (headless mode)
- [ ] Slack / Discord / iMessage / Signal
- [ ] Voice (STT in, TTS out)

### Memory
- [x] Markdown memory index (`~/.nina/memory/MEMORY.md`)
- [x] Personality file (`~/.nina/memory/PERSONALITY.md`)
- [x] Semantic recall (sqlite-vec + 384-dim embeddings)
- [x] Per-channel session isolation (desktop vs each Telegram chat vs cron vs missions)
- [x] Per-Telegram-chat conversation history injection
- [x] `/clear` to wipe a Telegram chat's memory (preserves audit)
- [ ] Feedback loop — no automatic learning from corrections

### Scheduled work
- [x] Cron recurring tasks (5-field expressions, local time, bg-queue backed)
- [x] Missions — long-running goal-oriented tasks with check-ins
- [x] Daily reflection (configurable hour)
- [x] Daily diary (configurable hour + minute)
- [x] Morning ritual

### Observability
- [x] HTML dashboard at `~/.nina/dashboard.html` with full state snapshot
- [x] Text timeline via `dot_timeline` MCP tool (agent can inspect its own activity)
- [x] Event log in SQLite (queryable)
- [x] Tool-call audit trail with decisions (auto / user-approved / deny / blocked-by-rule)
- [x] Token usage + cost tracking by model + session type
- [x] NadirClaw stats (read-only integration)

### Safety
- [x] Trust layer (auto / confirm / deny tiers per tool)
- [x] Reversible file delete (`safe_delete_file`)
- [x] Reversible file write (`safe_write_file`)
- [x] Undo log with replayable reversal steps (`dot_undo`)
- [x] Trash dir conventions + guardrails
- [x] Soft daily budget cap (background jobs only)
- [x] Telegram allowlist (only approved chats can talk to the bot)
- [x] **Telegram refuses to boot with empty allowlist** (hardened — no accidental open bots)
- [x] **Tokens stored in macOS Keychain** (Anthropic + Telegram, auto-migrated, scrubbed from config.json)
- [x] Presence-gated proactive push (only pushes to phone when Mac is away)
- [x] AppleScript deny-guards (keychain probes, credential paths blocked even in the universal runner)
- [ ] Reversible gmail delete (archive-only policy, not yet enforced)
- [ ] Reversible mail.app delete (not yet wrapped)
- [ ] Sandboxed Bash (currently auto-approves with rules)
- [ ] Shadow workspace (full-sandbox file ops)

### Mac integrations
- [x] Screenshot + continuous screen watcher (auto-relays to Telegram when in chat context)
- [x] Native accessibility (click/type/read native windows, macOS Swift shim)
- [x] Browser automation (persistent Playwright Chromium profile)
- [x] Gmail (OAuth, search, read, send, labels)
- [x] Google Calendar (search, read, create)
- [x] macOS Mail.app (via AppleScript)
- [x] macOS Shortcuts (list + run)
- [x] Clipboard history
- [x] System control (volume, dark mode, wifi, media, windows, apps, files)
- [x] Screen lock
- [x] **Universal AppleScript runner** — `run_applescript` drives any scriptable Mac app (Mail, Calendar, Reminders, Notes, Music, Photos, Safari, Messages, Contacts, Finder, Pages, Numbers, Keynote, etc.)
- [x] **Launch / list installed / activate / quit / force-quit any app** — `manage_apps` with `launch`, `list_installed`, `activate`, `quit`, `force_quit` actions
- [x] **Keyboard shortcut dispatch** to the frontmost app — `send_keyboard_shortcut` with cmd/shift/option/control modifiers
- [x] **Default handler open** — `open_with_default` for URLs and file paths, same as double-clicking
- [x] **Installed-apps index with fuzzy resolver** — persistent at `~/.nina/app-index.json`. Rescans on startup, in the morning ritual, hourly if ≥23h old (daemon mode), and automatically on every missed lookup. Handles typos, partial names, subsequence matches.

### Cost & spend
- [x] Token usage table
- [x] Per-model + per-session-type breakdown
- [x] Daily / 7-day / lifetime totals
- [x] Soft daily cap (blocks background, not foreground)
- [ ] Hard cap / kill switch
- [ ] Multi-model fallover (NadirClaw read-only; no routing)
- [ ] Per-session budget enforcement

---

## What's missing, ranked by impact

### Tier 1 — Safety and trust
1. **Gmail / Mail reversibility policy** — `safe-ops.ts` exists but gmail and mail ops still use the old, non-reversible tools. Every `gmail_delete` and `mail_delete` call should go through an archive or labeled-trash wrapper with an undo_log entry.
2. **Tests** — zero exist. `autonomy.ts`, `proactive.ts`, `soul.ts`, `missions.ts` are the brain, and a silent regression would be invisible. Needs a test harness with mock Agent SDK + in-memory DB.
3. **Sandboxed Bash** — currently trust-tiered with rules, but still executes on the real filesystem. A `--sandbox` mode that routes file ops to a shadow dir would close this.
4. **Graceful degradation** — semantic memory / embed model / Telegram poll / native-ax permission failures are uneven. Some fail loud, some silent. Audit + standardize.

### Tier 2 — Mobile polish (Session 1b)
5. **Inline keyboards for permission confirmations** — when Dot hits a tier-2 tool from Telegram, the user has no way to approve from the phone. Should send an inline keyboard (Yes / No / Always) via Telegram and resume the agent on callback.
6. **Voice in** — Telegram voice notes → Whisper (local or API) → text prompt
7. **Voice out** — text replies → TTS → Telegram `sendVoice`
8. **File receive handlers** — `photo`, `document`, `voice` message types. Currently only `text` is read.

### Tier 3 — Mobile evolution (long-term)
9. **Multi-user trust tiers** — right now Telegram is solo-you. Adding family / collaborators needs per-user trust model and per-user session types.
10. **Presence detection** — for "proactive push only when Mac is away." Needs idle detection + screen lock state.
11. **Slack / Discord / iMessage channels** — pattern is proven by Telegram; ~200 lines per channel. Only worth it if Telegram hits a wall.

### Tier 4 — Learning and cost
12. **Feedback loop** — corrections should flow into memory automatically. Right now memory is write-only.
13. **Multi-model routing** — fallback to cheaper models for simple prompts. NadirClaw is read-only; no actual routing.
14. **Hard budget enforcement** — soft cap exists. Hard kill-switch doesn't.
15. **Per-session cost limits** — e.g. "no mission can spend more than $0.50"

### Tier 5 — Polish
16. **Shadow workspace sandbox** — full copy-on-write workspace via APFS clones or shadow dir routing
17. **Feedback loop from `dont_do_rules`** — auto-generate rules from user corrections
18. **Per-channel personality files** — `PERSONALITY.tg.md`, `PERSONALITY.desktop.md`, `PERSONALITY.cron.md`

---

## Known issues and rough edges

- **Telegram command em-dash glueing** — Telegram clients render `/status — queue` as `/status-report` visually. Worked around by avoiding em-dashes in bot messages. Watch out when adding new commands.
- **launchd requires real Electron binary path** — `node_modules/.bin/electron` is a sh shim that launchd can't resolve. `bin/launchd-install.sh` uses `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron` directly. Don't switch to the shim.
- **macOS TCC** may prompt for Documents access the first time launchd spawns Dot. Grant it. If it doesn't prompt and something breaks, add Electron.app to Full Disk Access.
- **Stale stderr logs** — `~/.nina/logs/dot.err.log` accumulates errors across restarts. Truncate manually if it becomes noisy.
- **Trash dir never auto-cleans** — reversible ops accumulate. Needs a cron task to prune entries older than N days. Not built yet.
- **bg-queue budget check uses `todayCostUsd`** which reads from `token_usage` table. If token logging is behind or missing, the check is inaccurate. Watch for this.
- **Telegram allowlist empty = wide open** — `telegramAllowedChatIds: []` is treated as "no allowlist, allow all" by design, which is dangerous. Don't deploy with an empty allowlist past first-time setup.

---

## Decisions made

From `MOBILE.md` (answered 2026-04-15):
1. **User model: solo-you.** No multi-user, no family, no collaborators. Trust model stays single-user. Telegram allowlist always has exactly one chat id.
2. **STT / TTS: local-first, with optional remote fallback to Groq.** Default pipeline is fully local (Whisper for STT, macOS `say` or equivalent for TTS). When Dot detects Groq credentials in config, it can use Groq's faster hosted Whisper for STT. Privacy-preserving by default, speed option available.
   - Config field to add (not yet implemented): `groqApiKey` (optional)
   - Decision point for each voice note: if `groqApiKey` set AND voice note > 10s, prefer Groq; else local
3. **Proactive push: only when the Mac is unavailable.** Push to Telegram ONLY when:
   - Mac is locked, OR
   - User has been idle for 30+ minutes
   ("Asleep" folds into "locked" because launchd processes are frozen in true sleep.) ✅ **Shipped:** `shouldPushProactiveToPhone()` in `src/main/presence.ts`, gating both observation callbacks (headless and windowed). When gated, a `proactive.push_skipped` event is logged with the reason. When pushed, a `proactive.push_telegram` event is logged. New MCP tool `presence_check` lets the agent inspect its own presence state.
4. **Voice: off by default.** `/voice on` per chat to enable. Voice work is Session 1b, deferred.

Note on #2: the original answer said "JROG" which I'm reading as **Groq**. If that's wrong, correct me — JFrog doesn't do inference. If it's something else entirely, flag it.

## Still open (not yet decided)

From reversibility discussion:
5. Should Dot refuse to call non-`safe_*` file tools when a sandbox flag is set, or just prefer them? → affects enforcement model
6. How long does trash live? → needs a retention policy before auto-prune ships

---

## Useful snippets

**Regenerate the dashboard:**
```bash
# Via the agent:
#   "show me the dashboard"
# Or manually (forces render via MCP):
./bin/launchd-install.sh status  # confirm Dot is up
# then ask Dot: "run dot_timeline"
open ~/.nina/dashboard.html
```

**Tail launchd logs:**
```bash
./bin/launchd-install.sh tail
```

**See recent destructive ops:**
```bash
sqlite3 ~/.nina/nina.db "SELECT id, timestamp, op_type, target, reversible, reversed_at FROM undo_log ORDER BY id DESC LIMIT 20;"
```

**See recent Telegram events:**
```bash
sqlite3 ~/.nina/nina.db "SELECT type, data FROM events WHERE type LIKE 'telegram%' ORDER BY id DESC LIMIT 20;"
```

**Rebuild + hot restart the daemon:**
```bash
npm run build && launchctl kickstart -k "gui/$(id -u)/com.dot.nina"
```

**Kill and relaunch manually (for debugging):**
```bash
./bin/launchd-install.sh uninstall
./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ./out/main/index.js --headless
```
