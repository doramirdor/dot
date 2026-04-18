---
name: setup
description: First-time Dot setup — install deps, verify credentials, build native modules, optionally install launchd daemon, and do a test run. AI-native — don't make the user run commands themselves.
user_invocable: true
---

# Dot Setup

You are walking the user through first-time setup for Dot. **Run each command yourself. Do not ask the user to paste commands.** Explain what you're about to do in one short sentence, do it, then move on.

Dot's working directory is the repo root (where `package.json` with `"name": "nina"` lives). Dot's state directory is `~/.nina/`. If the user ran `claude` from somewhere else, `cd` into the Dot repo first — detect it with:

```bash
pwd && ls package.json 2>/dev/null && grep -q '"name": "nina"' package.json && echo "ok: in Dot repo"
```

If not in the repo, ask the user where they cloned it, then `cd` there.

## The full flow (run top to bottom)

### 1 · Node + package manager

Check Node is ≥ 20:

```bash
node --version
```

If under 20, stop and tell the user to install Node 20+ (nvm, fnm, brew — their choice). If OK, prefer `pnpm` (faster for Electron), fall back to `npm`:

```bash
command -v pnpm && pnpm install || npm install
```

### 2 · Rebuild native modules for Electron

`better-sqlite3` and `onnxruntime-node` need to match Electron's Node ABI:

```bash
npx electron-rebuild
```

If this fails with a compiler error, note it and continue — Dot will still boot, she just won't have semantic memory until it's fixed.

### 3 · Credentials

Dot needs an Anthropic credential. **Dot never reads from other tools' config files silently** — if openclaw has a token, we'll offer to import it explicitly.

Check the three native sources first:

```bash
# 1. macOS Keychain
security find-generic-password -s dot -a anthropic-token -w 2>/dev/null | head -c 12 && echo "  (Keychain)"

# 2. env vars
test -n "$ANTHROPIC_API_KEY" && echo "  ANTHROPIC_API_KEY set"
test -n "$CLAUDE_CODE_OAUTH_TOKEN" && echo "  CLAUDE_CODE_OAUTH_TOKEN set"
```

If one is present, say which and move on.

If none, probe for the legacy openclaw file and ask before importing:

```bash
test -f ~/.openclaw/agents/main/agent/auth-profiles.json && echo "found openclaw auth-profiles"
```

**If the openclaw file exists**, read the `anthropic:default` profile and ask the user:

> I found an Anthropic token in your openclaw setup. Do you want me to import it into Dot's Keychain? (yes / no)

On "yes":

```bash
# extract the token
TOKEN=$(python3 -c "import json,sys,pathlib
p=pathlib.Path.home()/'.openclaw/agents/main/agent/auth-profiles.json'
d=json.loads(p.read_text())
pr=d.get('profiles',{}).get('anthropic:default',{})
print(pr.get('token') or pr.get('access') or pr.get('apiKey') or '')")

# store in Keychain
security add-generic-password -U -s dot -a anthropic-token -w "$TOKEN" -T ''
```

**If none of the above** — no Keychain entry, no env, no openclaw file — ask the user to paste a key, then:

```bash
security add-generic-password -U -s dot -a anthropic-token -w "<KEY>" -T ''
```

Alternatively they can set `ANTHROPIC_API_KEY` in their shell profile.

### 4 · Optional: pick a non-default provider

By default Dot uses Anthropic direct. If the user wants **Bedrock** or **Vertex**, ask now and write to config:

```bash
mkdir -p ~/.nina && cat > ~/.nina/config.json <<'JSON'
{
  "provider": "bedrock",
  "model": "us.anthropic.claude-opus-4-20250805-v1:0"
}
JSON
```

For Bedrock the user also needs AWS credentials in the standard chain (`~/.aws/credentials` or env). For Vertex they need `gcloud auth application-default login` or `GOOGLE_APPLICATION_CREDENTIALS`. Check with:

```bash
test -f ~/.aws/credentials && echo "AWS creds present"
test -f ~/.config/gcloud/application_default_credentials.json && echo "gcloud ADC present"
```

### 5 · Optional: container runtime for self-rewrite

Dot's `self_rewrite` tool runs `claude --print` inside a container. Check what's available:

```bash
which container 2>/dev/null && echo "Apple Container found (preferred)"
which docker 2>/dev/null && docker info --format '{{.ServerVersion}}' 2>/dev/null && echo "Docker available"
```

If neither exists, tell the user:

> Dot's self-rewrite feature needs a container runtime. On macOS 15+ install Apple Container (`brew install apple/container`). On older macOS or for broader compatibility install Docker Desktop. Without one, self-rewrite is disabled but everything else works.

If one exists, offer to warm the default image (fast on subsequent runs):

```bash
docker pull node:20-slim 2>/dev/null || true
```

### 6 · Optional: Telegram bot

Ask the user: do they want Dot reachable on their phone via Telegram? If yes:

1. Have them talk to [@BotFather](https://t.me/BotFather) on Telegram to create a bot, get the token.
2. Have them message the new bot once, then run:
   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | python3 -m json.tool
   ```
   and copy their `chat.id` from the response.
3. Store the token + allowlist:
   ```bash
   security add-generic-password -U -s dot -a telegram-bot-token -w "<TOKEN>" -T ''

   # Merge allowlist into config
   python3 -c "import json, os, pathlib
   p = pathlib.Path.home() / '.nina' / 'config.json'
   p.parent.mkdir(exist_ok=True)
   cfg = json.loads(p.read_text()) if p.exists() else {}
   cfg['telegramAllowedChatIds'] = [<CHAT_ID>]
   cfg['telegramPrimaryChatId'] = <CHAT_ID>
   p.write_text(json.dumps(cfg, indent=2))"
   ```

If they don't want Telegram now, skip — they can add it later.

### 7 · Type check + build

```bash
npm run typecheck && npm run build
```

Fix anything red before moving on. Type errors here usually mean a dep didn't install — try step 1 again.

### 8 · Native accessibility helper (optional)

Dot uses a tiny Swift helper for native window control. If `swiftc` is on the PATH:

```bash
test -f assets/native/nina-ax.swift && \
  swiftc -O -o assets/native/nina-ax assets/native/nina-ax.swift \
    -framework ApplicationServices -framework Foundation \
  && echo "accessibility helper built" \
  || echo "swiftc not available — skipping"
```

Without it Dot still works; she just can't drive non-scriptable Mac apps via `click_native` / `type_native`.

### 9 · First run — pick a mode

Ask the user which mode they want Dot to run in day-to-day:

**A. Windowed (dev).** See her in the corner while you work on her.
```bash
npm run dev
```
Open a fresh terminal so this stays running.

**B. Windowed (packaged).** Same UI, no hot reload.
```bash
./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ./out/main/index.js &
```

**C. Headless launchd daemon.** Starts automatically on login, stays up, pushes to Telegram when you're away.
```bash
./bin/launchd-install.sh install
./bin/launchd-install.sh status
```

If the user picks C, also offer to tail the logs so they see the first boot:

```bash
./bin/launchd-install.sh tail
```

### 10 · Verify

Whichever mode they chose, confirm Dot came up:

- Windowed modes: pixel sprite should be visible in the bottom-right corner of the main display.
- Daemon mode: `~/.nina/logs/dot.out.log` should show "Dot is ready" or similar recent activity.

Then tell the user:

> Click her (or message her on Telegram), and start with: **"onboard me"**. She'll ask ~10 questions to learn your rhythm, then she's yours.

## If something fails

Don't push past a red step. Read the error, decide: is it transient (try again), missing tool (install it), or a bug in Dot (report it — note the step + error to the user, offer to create a GitHub issue at https://github.com/doramirdor/dot/issues).

## Done

Summarise in 3–5 bullets: what you installed, what provider is active, whether Telegram is wired, whether the daemon is running, and the next thing for the user to say to Dot.
