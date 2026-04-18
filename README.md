# Dot

> A tiny desktop companion powered by Claude. Lives in the corner of your screen as a pixel sprite, answers on Telegram from your phone, runs headless under launchd as a background daemon. One memory across all three.

<p align="center">
  <img src="assets/characters/cast.svg" width="860" alt="Dot character cast — seven moods in a row"/>
</p>

---

## What makes Dot different

Dot is the **ambient layer** — not a coding agent, not a chat app, not a channel gateway. A single persistent companion that:

- **Lives in three modes at once**: visible pixel pet, headless launchd daemon, Telegram bot. All three share one `~/.nina/` memory.
- **Learns from your actual behavior**: every turn is a data point in a contextual-bandit replay buffer. Reply latency, sentiment, explicit `/feedback`, tool-call outcomes → a policy Dot consults before every turn.
- **Rewrites her own code**: four layers Dot can modify under her own `self_rewrite` tool — `core` (src/core), `skills` (plugins), `brain` (memory), `heart` (personality). Every rewrite tar-snapshots first; `dot_undo <id>` restores.
- **Runs destructive ops reversibly**: every delete moves to `~/.nina/trash/<ts>/`, every overwrite snapshots, every self-rewrite is recoverable.
- **Isolates risky code in containers**: self-rewrite runs inside Apple Container (macOS 15+) or Docker. Fails closed if no runtime is installed.
- **Picks her own mood**: seven character forms — sleepy, focused, excited, concerned, playful, rainbow — Dot swaps her on-screen form based on context.

## The character cast

<p align="center">
  <img src="assets/characters/dot-adult.svg" width="110" alt="Dot"/>
  <img src="assets/characters/dot-sleepy-adult.svg" width="110" alt="Sleepy Dot"/>
  <img src="assets/characters/dot-focused-adult.svg" width="110" alt="Focused Dot"/>
  <img src="assets/characters/dot-excited-adult.svg" width="110" alt="Excited Dot"/>
  <img src="assets/characters/dot-concerned-adult.svg" width="110" alt="Concerned Dot"/>
  <img src="assets/characters/dot-playful-adult.svg" width="110" alt="Playful Dot"/>
  <img src="assets/characters/dot-rainbow-adult.svg" width="110" alt="Rainbow Dot"/>
</p>

| id | when it fires | animation |
|---|---|---|
| `dot` | default form — the one you onboarded with | subtle idle breathe |
| `dot-sleepy` | late at night, post-lunch dip, long user idle | slow 6s breathing, muted tint |
| `dot-focused` | user in deep work — coding, writing, on a call | tight 2.4s pulse + cyan halo |
| `dot-excited` | task completed, good news, user sent a win | 0.9s bounce + coral glow |
| `dot-concerned` | error, budget alarm, something worth flagging | slow 4.5s breath + red aura |
| `dot-playful` | casual chat, banter, non-work hours | ±2° wiggle + pink halo |
| `dot-rainbow` | rare — milestones only | 4s hue-cycle |

Plus four one-shot gestures Dot can fire on top of her current form: `nuzzle`, `sparkle`, `stretch`, `peek`.

### Seedling → adult

Every form has a seedling variant (pre-onboarding, with a leaf) and an adult variant.

<table>
<tr>
  <th>Dot</th><th>Sleepy</th><th>Focused</th><th>Excited</th>
</tr>
<tr>
  <td><img src="assets/characters/dot-seedling.svg" width="90"/><br/><img src="assets/characters/dot-adult.svg" width="90"/></td>
  <td><img src="assets/characters/dot-sleepy-seedling.svg" width="90"/><br/><img src="assets/characters/dot-sleepy-adult.svg" width="90"/></td>
  <td><img src="assets/characters/dot-focused-seedling.svg" width="90"/><br/><img src="assets/characters/dot-focused-adult.svg" width="90"/></td>
  <td><img src="assets/characters/dot-excited-seedling.svg" width="90"/><br/><img src="assets/characters/dot-excited-adult.svg" width="90"/></td>
</tr>
<tr>
  <th>Concerned</th><th>Playful</th><th>Rainbow</th><th></th>
</tr>
<tr>
  <td><img src="assets/characters/dot-concerned-seedling.svg" width="90"/><br/><img src="assets/characters/dot-concerned-adult.svg" width="90"/></td>
  <td><img src="assets/characters/dot-playful-seedling.svg" width="90"/><br/><img src="assets/characters/dot-playful-adult.svg" width="90"/></td>
  <td><img src="assets/characters/dot-rainbow-seedling.svg" width="90"/><br/><img src="assets/characters/dot-rainbow-adult.svg" width="90"/></td>
  <td></td>
</tr>
</table>

Regenerate these images from the registry after editing [src/renderer/characters.ts](src/renderer/characters.ts):

```bash
node scripts/gen-character-svgs.mjs
```

---

## Architecture

```
┌─ Electron main (src/main/) ────────────────────────────────────┐
│  window, tray, launchd daemon mode, Telegram long-poll         │
└───────────────┬────────────────────────────────────────────────┘
                │
┌───────────────▼─── src/core/ (one brain, many entry points) ──┐
│                                                                 │
│  turn.ts ← unifies every agent entry (desktop, telegram, cron, │
│            mission, proactive, morning, diary, reflection)     │
│     │                                                           │
│     ├─→ rl/*               contextual bandit + reward signals  │
│     ├─→ agent.ts           claude-agent-sdk wrapper + RL block │
│     │                      + provider selection                 │
│     ├─→ providers.ts       Anthropic / Bedrock / Vertex        │
│     ├─→ channels/*         desktop, telegram, (future slack)   │
│     ├─→ swarm.ts           parallel sub-agents w/ workspaces   │
│     ├─→ self-rewrite.ts    layer-scoped claude-code calls      │
│     │                      inside sandbox.ts container         │
│     ├─→ sandbox.ts         Apple Container + Docker backends   │
│     ├─→ plugin-loader.ts   ~/.nina/plugins/* scanner           │
│     ├─→ safe-ops.ts        reversible delete/write/rewrite     │
│     ├─→ memory.ts + memory-service.ts + semantic-memory.ts     │
│     │                      MEMORY.md + sqlite-vec recall       │
│     └─→ trust.ts + policy-service.ts + permission-bus.ts       │
│                            per-tool auth tiers                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

~/.nina/  (Dot's state directory — never edit directly)
├── nina.db          SQLite: conversations, tool_calls, events, token_usage, undo_log
├── rl.db            SQLite: replay_buffer, daily_summary, policy, priors
├── memory/          MEMORY.md (index), PERSONALITY.md, mindmap, imported/
├── plugins/         user-dropped plugins (see "Plugin SDK" below)
├── missions/<id>/   long-running mission state + artifacts
├── swarm/<runId>/   per-swarm-member workspaces
├── trash/<ts>/      reversible deletions + self-rewrite snapshots
└── config.json      runtime config (budget, provider, intervals)
```

## Milestones shipped

| | What | Key files |
|---|---|---|
| **M1** | Self-RL contextual bandit | [src/core/rl/](src/core/rl/) |
| **M2** | Channel abstraction | [src/core/channels/](src/core/channels/) |
| **M3** | Multi-provider (Anthropic / Bedrock / Vertex) | [src/core/providers.ts](src/core/providers.ts) |
| **M4** | Plugin SDK | [src/core/plugin-loader.ts](src/core/plugin-loader.ts) |
| **M5** | Self-rewrite | [src/core/self-rewrite.ts](src/core/self-rewrite.ts) |
| **M6** | Container isolation | [src/core/sandbox.ts](src/core/sandbox.ts) |
| **M7** | Agent Swarms | [src/core/swarm.ts](src/core/swarm.ts) |
| **M9** | Character cast + animations | [src/renderer/characters.ts](src/renderer/characters.ts) |

Pending: **M8** Voice Wake / Talk Mode (local Whisper + wake word + Groq fallback + macOS `say`). The config reserves `groqApiKey` + `voiceDefaultOn` for it.

### M1 — Self-RL

Every turn is a row in `~/.nina/rl.db`'s `replay_buffer`: (state bucket, action type, content type, tone, length, cost) in, reward later. Reward signals are observed, not self-reported: user reply latency + sentiment + `/feedback good|bad` + tool-call success/block.

A SQL `GROUP BY` is the entire learner — Bayesian smoothing `n/(n+10)`, no ML deps. The policy is **advisory**: Dot reads a markdown report in every system prompt and still picks her own reply. Exploration is a soft nudge for undersampled buckets.

Port of the pattern from [nanoclaw](https://nanoclaw.dev/), adapted for Dot's action domain (reply / proactive / mission / cron / ritual).

Tools: `rl_policy`, `rl_update_policy`, `rl_seed_priors`.

### M5 + M6 — Self-rewrite inside a container

Dot can modify four layers of herself:

- **core** → `src/core/*` (new modules, new MCP tool registrations)
- **skills** → `~/.nina/plugins/*` (user + self-authored plugins)
- **brain** → `~/.nina/memory/*` (MEMORY.md, mindmap)
- **heart** → `~/.nina/memory/PERSONALITY.md`

Flow:

1. `self_rewrite({ layer, intent })` is called (confirm-tier — user sees the ask).
2. The layer is tar-snapshotted into `~/.nina/trash/<ts>/`. Undo row written to `undo_log`.
3. `claude --print` is spawned inside Apple Container (or Docker) with the layer dir mounted R/W, `~/.claude` R/O for auth. Default image: `node:20-slim` with `@anthropic-ai/claude-code` installed at first run.
4. On failure or regression: `dot_undo <id>` untars the snapshot back into place.

The `dot_sandbox_probe` tool reports which backend is active and runs an `echo ok` round-trip.

### M7 — Swarms

`swarm_dispatch` takes N tasks, spawns up to 3 parallel workers (max 8), each with its own workspace at `~/.nina/swarm/<runId>/<i>/`, a seeded `CLAUDE.md`, a fresh session, and a tight worker-scope tool allowlist (no telegram, no self-rewrite, no mission control). Each worker writes `result.md` into its workspace; the orchestrator collects and returns all results in order.

### M4 — Plugin SDK

Drop a directory at `~/.nina/plugins/<name>/` with a `plugin.mjs`:

```js
import { z } from 'zod'

export default {
  name: 'hello',
  version: '0.1.0',
  tools: [
    {
      name: 'greet',
      description: 'Greet the user by name.',
      inputSchema: { name: z.string() },
      async handler({ name }) {
        return { content: [{ type: 'text', text: `hello, ${name}!` }] }
      },
    },
  ],
}
```

Tools are prefixed `mcp__nina__plugin__<plugin>__<tool>` and default to the `confirm` trust tier. Plugins cannot declare themselves auto-tier.

### M2 — Channels

Unified output surfaces. Today: `desktop` + `telegram`. Adding Slack / Discord is a new file in [src/core/channels/](src/core/channels/) implementing the `Channel` interface + one `registerChannel()` line.

Tools: `channel_list`, `channel_send`.

---

## Run modes

```bash
# Development (hot reload)
npm run dev

# Production build
npm run build
npm run typecheck

# Packaged run — windowed
./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ./out/main/index.js

# Headless daemon
./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ./out/main/index.js --headless

# One-shot migration from ~/.openclaw or ~/.nanoclaw
./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ./out/main/index.js --migrate

# launchd (daemon on login)
./bin/launchd-install.sh install   # install + start
./bin/launchd-install.sh status
./bin/launchd-install.sh tail      # live logs
./bin/launchd-install.sh uninstall
```

## Auth

Dot reads Anthropic credentials in this order:

1. macOS Keychain under service `dot`, account `anthropic-token`
2. `~/.openclaw/agents/main/agent/auth-profiles.json` → `anthropic:default` (auto-migrated to Keychain on first read)
3. `CLAUDE_CODE_OAUTH_TOKEN` env var
4. `ANTHROPIC_API_KEY` env var

For Bedrock: standard AWS credential chain. For Vertex: `GOOGLE_APPLICATION_CREDENTIALS` or gcloud ADC.

Switch providers via MCP tool `provider_use({ id: 'bedrock' })` or by editing `~/.nina/config.json`:

```json
{
  "provider": "bedrock",
  "model": "us.anthropic.claude-opus-4-20250805-v1:0"
}
```

## Design principles

1. **No half-finished implementations.** One thing shipped > three things 80% done.
2. **Reversibility over cleverness.** Every destructive op is recoverable. Disk is cheap; regrets are expensive.
3. **Foreground never blocks.** Background jobs can be queued, gated, or capped. User chat always runs.
4. **Daemon mode is first-class.** If it only works in windowed mode, it's half-built.
5. **Path constants are the source of truth.** Don't hardcode `~/.nina/...` — import from [memory.ts](src/core/memory.ts).
6. **Every destructive MCP tool has a reversible variant.** `safe_write_file` / `safe_delete_file` over `Write` / `Bash rm`.

## Fixed decisions

- **Single-user.** No multi-user, no family, no collaborators.
- **Local-first voice.** Default: Whisper locally, macOS `say` locally. Groq as optional fallback.
- **Proactive push to Telegram only when the Mac is away.** Gate: locked / asleep / idle ≥ 30 min.
- **Voice defaults off.** Opt in per chat.

## Credits

Architecture patterns borrowed with gratitude:

- RL contextual-bandit loop — from [nanoclaw](https://nanoclaw.dev/)
- Multi-channel adapter gateway — inspired by [openclaw](https://openclaw.ai/)
- `@anthropic-ai/claude-agent-sdk` + `claude-code` — [Anthropic](https://anthropic.com/)

## License

Private — not yet released.
