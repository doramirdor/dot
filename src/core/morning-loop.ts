/**
 * morning-loop.ts — Dot's flagship daily workflow.
 *
 * Every morning (via a cron task pointing at runMorningLoop), Dot:
 *   1. Reads the last 24h of unread Gmail
 *   2. Drafts replies for the messages she's confident about
 *   3. Pushes the drafts to Telegram with inline-keyboard approval
 *      ([✅ Send] / [⏭️ Skip] per draft)
 *   4. When you tap "Send", fires gmail.sendMessage directly — the tap
 *      IS the confirmation, no second-step approval needed.
 *
 * This is the "it did the thing while I was away" moment — the product
 * feature every agent review pointed at as the missing Jarvis-feel delta.
 *
 * Deliberately written as ONE cohesive flow instead of six scattered
 * tool calls. The agent's drafting step runs inside the normal runAgent
 * path with full tool access (so it can recall context, pull calendar,
 * etc.) but the actual send lives out here so that user approval is the
 * last thing that runs before bytes leave the machine.
 */
import * as gmail from './gmail.js'
import { askTelegramConfirm, pushToTelegram, readPrimaryChatId, isTelegramRunning } from './telegram.js'
import { enqueue as bgEnqueue } from './bg-queue.js'
import { logEvent } from './db.js'

export interface DraftReply {
  messageId: string
  threadId?: string
  from: string
  subject: string
  replyTo: string
  body: string
  /** Short reason shown to the user so they can decide without opening the email. */
  rationale: string
}

const DRAFT_MARKER_START = '<<<MORNING_DRAFTS_JSON>>>'
const DRAFT_MARKER_END = '<<<END_MORNING_DRAFTS>>>'

/**
 * Prompt the agent to read the inbox, produce structured drafts, and
 * return them inside a fenced JSON block we can parse.
 *
 * The agent is told explicitly that it must NOT send anything — only
 * draft. Sends happen in JS after user approval.
 */
function buildDraftingPrompt(): string {
  return `[Morning Loop — drafting phase]

Read the last 24h of unread Gmail (use gmail_search with "is:unread newer_than:1d").
For every message worth a reply, draft one in the user's voice. Skip newsletters,
calendar invites, notifications, "no-reply" senders, and anything you can't tell
what to do with.

DO NOT CALL gmail_send UNDER ANY CIRCUMSTANCES. Your job is to draft, not send.
The user will approve drafts on their phone; the real send happens in code
after they tap.

Output your drafts as a JSON array wrapped in these markers, and ONLY inside
the markers (no other text in the final message):

${DRAFT_MARKER_START}
[
  {
    "messageId": "18abc...",
    "threadId": "18abc...",
    "from": "alex@example.com",
    "subject": "Re: Friday sync",
    "replyTo": "alex@example.com",
    "body": "Sounds good, 3pm works. — sent from phone",
    "rationale": "Alex asked to confirm a 3pm Friday sync. Calendar is open."
  }
]
${DRAFT_MARKER_END}

Rules:
- Keep each "body" short (1-4 sentences). Match the user's typical tone from memory.
- "rationale" is max 140 chars and explains WHY you drafted this reply.
- Return an empty array [] if there's nothing worth replying to.
- Never include anything outside the markers in the final message.`
}

/**
 * Parse the drafter's output. Returns the drafts array or null on failure.
 */
function parseDrafts(agentOutput: string): DraftReply[] | null {
  const startIdx = agentOutput.indexOf(DRAFT_MARKER_START)
  const endIdx = agentOutput.indexOf(DRAFT_MARKER_END)
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) return null
  const jsonBlock = agentOutput.slice(startIdx + DRAFT_MARKER_START.length, endIdx).trim()
  try {
    const parsed = JSON.parse(jsonBlock) as unknown
    if (!Array.isArray(parsed)) return null
    // Minimal validation — every item needs the required fields to be safe.
    const out: DraftReply[] = []
    for (const raw of parsed) {
      if (!raw || typeof raw !== 'object') continue
      const r = raw as Record<string, unknown>
      if (
        typeof r['messageId'] === 'string' &&
        typeof r['from'] === 'string' &&
        typeof r['subject'] === 'string' &&
        typeof r['replyTo'] === 'string' &&
        typeof r['body'] === 'string' &&
        typeof r['rationale'] === 'string'
      ) {
        out.push({
          messageId: r['messageId'] as string,
          threadId: typeof r['threadId'] === 'string' ? (r['threadId'] as string) : undefined,
          from: r['from'] as string,
          subject: r['subject'] as string,
          replyTo: r['replyTo'] as string,
          body: r['body'] as string,
          rationale: (r['rationale'] as string).slice(0, 140),
        })
      }
    }
    return out
  } catch {
    return null
  }
}

export interface MorningLoopResult {
  status: 'ok' | 'error' | 'skipped'
  draftCount: number
  sentCount: number
  skippedCount: number
  error?: string
}

/**
 * Run one Morning Loop pass. Designed to be called from cron.ts with
 * something like "0 7 * * *".
 */
export async function runMorningLoop(): Promise<MorningLoopResult> {
  const chatId = readPrimaryChatId()
  if (chatId === null) {
    logEvent('morning_loop.skipped', { reason: 'no_primary_chat' })
    return {
      status: 'skipped',
      draftCount: 0,
      sentCount: 0,
      skippedCount: 0,
      error: 'no telegramPrimaryChatId set in ~/.nina/config.json — Morning Loop needs somewhere to push drafts',
    }
  }
  if (!isTelegramRunning()) {
    logEvent('morning_loop.skipped', { reason: 'telegram_not_running' })
    return {
      status: 'skipped',
      draftCount: 0,
      sentCount: 0,
      skippedCount: 0,
      error: 'telegram channel not running — start it and make sure the allowlist is set',
    }
  }

  // 1. Drafting — runs through bg-queue so it respects the budget gate
  //    and serializes against other background work. Channel = 'morning'
  //    so the situational frame shows the right context.
  logEvent('morning_loop.start', { chatId })
  const bg = await bgEnqueue({
    label: 'morning-loop:draft',
    prompt: buildDraftingPrompt(),
    channelContext: {
      channel: 'morning',
      label: 'morning-loop-draft',
      extras: { phase: 'drafting' },
    },
  })

  if (bg.status !== 'ok') {
    logEvent('morning_loop.draft_failed', { error: bg.error })
    await pushToTelegram(chatId, `morning loop: drafting failed — ${bg.error ?? 'unknown'}`)
    return {
      status: 'error',
      draftCount: 0,
      sentCount: 0,
      skippedCount: 0,
      error: bg.error,
    }
  }

  const drafts = parseDrafts(bg.text)
  if (drafts === null) {
    logEvent('morning_loop.parse_failed', { textLen: bg.text.length })
    await pushToTelegram(chatId, `morning loop: i drafted something but couldn't parse it — opening the raw output:\n\n${bg.text.slice(0, 1500)}`)
    return {
      status: 'error',
      draftCount: 0,
      sentCount: 0,
      skippedCount: 0,
      error: 'drafts did not parse',
    }
  }
  if (drafts.length === 0) {
    logEvent('morning_loop.no_drafts', {})
    await pushToTelegram(chatId, "morning loop: inbox's clean — nothing worth drafting.")
    return { status: 'ok', draftCount: 0, sentCount: 0, skippedCount: 0 }
  }

  // 2. Approval — one prompt per draft. We run them sequentially so
  //    the user isn't flooded with eight keyboards at once.
  await pushToTelegram(
    chatId,
    `morning loop: ${drafts.length} draft${drafts.length === 1 ? '' : 's'} ready. tap to approve.`,
  )

  let sent = 0
  let skipped = 0
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i]!
    const prompt = [
      `Draft ${i + 1}/${drafts.length}`,
      ``,
      `To:      ${d.replyTo}`,
      `Subject: ${d.subject}`,
      ``,
      `— why: ${d.rationale}`,
      ``,
      d.body,
    ].join('\n')
    const choice = await askTelegramConfirm(
      chatId,
      prompt,
      [[
        { text: '✅ Send', callback_data: 'send' },
        { text: '⏭️ Skip', callback_data: 'skip' },
      ]],
    )
    if (choice === 'send') {
      try {
        await gmail.sendMessage({
          to: d.replyTo,
          subject: d.subject.startsWith('Re:') ? d.subject : `Re: ${d.subject}`,
          body: d.body,
          threadId: d.threadId,
        })
        sent++
        logEvent('morning_loop.sent', { messageId: d.messageId, to: d.replyTo })
        await pushToTelegram(chatId, `✅ sent to ${d.replyTo}`)
      } catch (err) {
        logEvent('morning_loop.send_failed', {
          messageId: d.messageId,
          error: (err as Error).message,
        })
        await pushToTelegram(chatId, `❌ failed to send to ${d.replyTo}: ${(err as Error).message}`)
      }
    } else {
      skipped++
      logEvent('morning_loop.skipped_draft', { messageId: d.messageId, choice })
    }
  }

  logEvent('morning_loop.done', { draftCount: drafts.length, sent, skipped })
  await pushToTelegram(
    chatId,
    `morning loop done. sent ${sent}, skipped ${skipped}. have a good one ☕`,
  )
  return {
    status: 'ok',
    draftCount: drafts.length,
    sentCount: sent,
    skippedCount: skipped,
  }
}
