---
name: setup
description: First-time Dot setup — install dependencies, verify credentials, build native modules, and do a test run
user_invocable: true
---

# Dot Setup

Walk through first-time setup for Dot. Run each step — don't ask the user to run commands.

## Steps

### 1. Install dependencies

```bash
cd ~/Documents/code/nina && pnpm install
```

If pnpm is not available, try `npm install` instead.

### 2. Rebuild native modules for Electron

Native modules (better-sqlite3, onnxruntime-node) need to be rebuilt for Electron's Node version:

```bash
cd ~/Documents/code/nina && npx electron-rebuild
```

If `@electron/rebuild` is already a devDependency this should work out of the box.

### 3. Verify Anthropic credentials

Check that a valid credential exists. Dot loads from (in order):

1. `~/.openclaw/agents/main/agent/auth-profiles.json` — look for `anthropic:default` profile
2. `CLAUDE_CODE_OAUTH_TOKEN` env var
3. `ANTHROPIC_API_KEY` env var

Read the auth-profiles file (if it exists) and confirm a credential is present. If none found, tell the user:

> No Anthropic credential found. Either:
> - Set up openclaw with an `anthropic:default` profile in `~/.openclaw/agents/main/agent/auth-profiles.json`
> - Or export `ANTHROPIC_API_KEY=sk-ant-...` in your shell profile

### 4. Ensure ~/.dot directory

```bash
mkdir -p ~/.dot
```

Dot stores its SQLite database, memory files, and config here.

### 5. Compile the native accessibility helper (optional)

Check if Swift is available and compile the accessibility helper:

```bash
ls ~/Documents/code/nina/assets/native/nina-ax.swift
```

If it exists:
```bash
swiftc -O -o ~/Documents/code/nina/assets/native/nina-ax ~/Documents/code/nina/assets/native/nina-ax.swift -framework ApplicationServices -framework Foundation
```

If this fails, note it to the user — native accessibility features will be limited but Dot will still work.

### 6. Type check

```bash
cd ~/Documents/code/nina && npm run typecheck
```

Fix any errors before proceeding.

### 7. Test run

```bash
cd ~/Documents/code/nina && npm run dev
```

Tell the user Dot should appear as a small pixel sprite in the corner of their screen. They can click her to start chatting.

## Done

Summarize what was set up and any issues encountered. Dot is ready!
