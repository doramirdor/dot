# Dot on Mobile — design plan

Status: design doc, no code yet. Push back on anything.

## TL;DR

**Dot is already mobile.** Telegram turned your phone into a Dot client the
moment `@Nina_dot_bot` answered `/start`. The real question isn't "should
Dot be mobile" — it's **"what's still missing for the Telegram-as-mobile
experience to feel like Jarvis, not like chatting with a backend."**

The gap is not *presence*. The gap is:

1. **Phone can't see Mac-only tools' output well** — screenshots, browser
   snapshots, native window contents. Currently these come back as text.
2. **Phone can't trigger device-specific things from context** — "what did I
   just copy" only works if you're at the Mac.
3. **Phone has no push for proactive Dot** — you only hear from Dot when you
   message first. Proactive/cron events live on the Mac.
4. **Phone has no voice** — text only.
5. **Phone can't authenticate a second user or a shared group**.

Everything else (memory, personality, tools, cron) already works over
Telegram because Dot is a single brain with multiple surfaces.

## Architecture options

### Option A — Telegram is the mobile app (current path)

```
[iPhone / Android] ─── Telegram ─── @Nina_dot_bot ─── Dot (Mac, launchd)
                                                        │
                                                        ├── bg-queue
                                                        ├── per-chat memory
                                                        ├── all tools
                                                        └── cron / missions
```

**What works today:**
- Text in, text out, per-chat memory, full tool access
- Allowlisted to your chat id only
- Dot runs 24/7 under launchd
- Terse replies (tone hint shipped in Phase 4)

**What's missing:**

1. **Image replies.** Telegram Bot API has `sendPhoto`. When Dot calls
   `screenshot` or `browser_snapshot` via Telegram, the base64 result should
   go back as an image, not as "I took a screenshot." Small lift.

2. **Proactive push.** When the proactive/autonomy loop fires, it currently
   shows a speech bubble on the Mac. In headless mode, it falls back to
   native notification. Add a third path: if a Telegram chat id is
   configured as the "primary owner," proactive messages also go there.
   One-line fork in `startObservationLoop`.

3. **Voice in.** Telegram sends voice notes as `.ogg` files with a
   `voice` field. Pipe through Whisper (local or API), treat as text input.
   Medium lift — needs a STT backend choice.

4. **Voice out.** Text → TTS → `sendVoice` with `.ogg`. Medium lift — needs
   a TTS backend (macOS `say` + ffmpeg works for free, ElevenLabs is nicer).

5. **Inline keyboard / quick actions.** Telegram supports inline buttons.
   When Dot asks a question or needs confirmation, present buttons instead
   of free text. Biggest UX win on the phone. Low lift for specific flows.

6. **File receive.** When you send Dot a photo or doc from the phone, it
   currently gets ignored (only `msg.text` is handled). Wire `photo`,
   `document`, `voice` message types into the handler.

**Cost:** ~1 session for items 1 + 2 + 5 (images, proactive push, inline
keyboards). 1 more session for voice. Total 2 sessions to a complete
mobile-via-Telegram experience.

**Tradeoff:** You're locked to Telegram. If Telegram goes away or you want
Signal / iMessage / Slack in parallel, each needs its own adapter.

---

### Option B — Native iOS app

A real SwiftUI app that talks to Dot on your Mac over a Tailscale /
wireguard tunnel or an ngrok-style reverse proxy.

**Pros:**
- Native UI, better voice (Speech framework), background audio, haptics
- Can run its own local Dot fallback
- Can draw custom UIs for specific tools (map, calendar, screenshots inline)
- Push notifications via APNs

**Cons:**
- You need an Apple Developer account ($99/yr)
- TestFlight for anything beyond your device
- Swift codebase to maintain alongside the TypeScript one
- Network story is hard: Tailscale works but requires setup; ngrok leaks;
  proper VPS needs hosting
- Easily 2-4 weeks of work before the first real conversation

**When to do it:** Only if Option A hits a clear wall. Right now it wouldn't.

---

### Option C — PWA / Web app

A web frontend served from the Mac (localhost:XXXX over Tailscale) that
renders the same dashboard + chat UI as the Electron window, but in a
browser so you can save it to your home screen on iOS.

**Pros:**
- No App Store, no Apple account
- Reuses the React renderer code already in `src/renderer`
- Works on any device with a browser
- Can add to home screen for app-like feel

**Cons:**
- iOS Safari PWAs are limited (no real push, no background audio, reloaded
  frequently by iOS)
- Still needs a network tunnel (Tailscale) to reach your Mac
- Push notifications don't work well from PWAs on iOS
- Middle ground that's not great at either desktop or mobile

**When to do it:** Never, unless you already run Tailscale for other reasons
and want a free mobile touchpoint without writing any Swift.

---

### Option D — Cloud-hosted Dot (the "real" Jarvis path)

Move Dot's brain off the Mac. Dot runs on a VPS or Supabase Edge Functions.
Mac and phone become thin clients that stream events to and from the cloud
brain. State (memory, missions, cron) lives in Postgres + a vector store.

**Pros:**
- True multi-device parity — phone and Mac see the same Dot
- Dot keeps running even when your Mac is asleep / off
- Can scale to multiple users / household
- Mobile app is just another client, not a special case

**Cons:**
- Rewrite of storage layer (SQLite → Postgres)
- Loses local-first privacy (everything in the cloud)
- Loses Mac-only tools unless Mac stays online as a "worker"
- Auth, sync, offline handling, consistency — all new problems
- 1-2 months of work minimum

**When to do it:** If Dot becomes a product for other people. Not now.

---

## Recommendation

**Do Option A in full over 2 sessions.** It's the path with the highest
marginal return per hour of work. Specifically:

**Session 1 — "mobile feels alive"**
1. `sendPhoto` for screenshot / browser_snapshot results
2. Proactive push to a configured `primaryChatId`
3. Inline keyboards for the `canUseTool` confirm flow — the phone becomes
   the permission UI when the Mac is away
4. `photo` / `document` / `voice` message types in the handler (voice
   forwarded as a TODO for session 2)

**Session 2 — "mobile can speak"**
1. STT for incoming voice notes (pick: local Whisper or API)
2. TTS for outgoing replies (`say` + ffmpeg, or ElevenLabs)
3. Optional `/voice` toggle per chat so you can turn it off

After both sessions, you'll have:
- A phone app that sees images, hears you, talks back, gets push
  notifications, and can approve or deny Mac actions remotely
- No App Store, no Swift, no VPS, no new account
- All for a bot token and a weekend

Option D is the right answer long-term, but only if Dot has real users. For
now, it's over-engineering.

## Non-goals (explicitly)

- **No Slack / Discord / iMessage in parallel** until Telegram is polished.
  The channel abstraction will be easier to extract after you've lived with
  Telegram and know what's generic vs channel-specific.
- **No native mobile app** until the Telegram flow proves it *can't* do
  what you need.
- **No cloud brain** until Dot has >1 user.
- **No web PWA** — worst of all worlds.

## Open questions for the user

1. Is `@Nina_dot_bot` always going to be solo-you, or will you eventually
   add family / collaborators? This changes the auth model.
2. For STT/TTS: local (privacy, free, slow) or API (fast, better, costs)?
3. Do you want proactive Dot to push to Telegram by default, or only when
   the Mac is locked / asleep? The "always push" version is noisier but
   safer; the "only when away" version is quieter but requires presence
   detection.
4. Should voice notes default on or off? My vote: off by default, `/voice
   on` per chat.
