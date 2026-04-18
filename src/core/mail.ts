/**
 * Mail bridge via AppleScript to Mail.app.
 *
 * If the user has their Gmail (or iCloud, or any IMAP) account in
 * System Settings → Internet Accounts → Mail, Mail.app aggregates everything
 * and we can query it without OAuth.
 *
 * Gotchas:
 *   - AppleScript to Mail.app is SLOW. A "recent 10 messages" query can take
 *     3-8 seconds cold depending on how many accounts + mailboxes the user has.
 *   - First run prompts for Automation permission to Mail.
 *   - Searching with `whose` clauses on Mail is extremely slow; we use
 *     application-level search and then filter.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

const OSA_TIMEOUT = 20_000

async function runOsa(script: string): Promise<string> {
  const { stdout } = await execFileP('osascript', ['-e', script], {
    timeout: OSA_TIMEOUT,
    maxBuffer: 2 * 1024 * 1024, // 2 MB
  })
  return stdout
}

export interface MailMessage {
  id: string // message id (internal AppleScript id, NOT the Message-ID header)
  account: string
  mailbox: string
  subject: string
  sender: string
  dateReceived: string
  isRead: boolean
  preview: string // first ~200 chars of content
}

const ROW_SEP = '␞'
const FIELD_SEP = '␟'

function parseMessages(raw: string): MailMessage[] {
  if (!raw) return []
  return raw
    .split(ROW_SEP)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((row) => {
      const parts = row.split(FIELD_SEP)
      return {
        id: parts[0] ?? '',
        account: parts[1] ?? '',
        mailbox: parts[2] ?? '',
        subject: parts[3] ?? '(no subject)',
        sender: parts[4] ?? '',
        dateReceived: parts[5] ?? '',
        isRead: parts[6] === 'true',
        preview: (parts[7] ?? '').slice(0, 200),
      }
    })
}

/**
 * Get the most recent N messages from the inbox of all accounts.
 */
export async function getRecentMessages(count = 10): Promise<MailMessage[]> {
  const script = `
set rowSep to "${ROW_SEP}"
set fieldSep to "${FIELD_SEP}"
set out to ""
set maxMsgs to ${Math.max(1, Math.min(count, 50))}
set gathered to 0
tell application "Mail"
  repeat with acc in accounts
    try
      set inboxMbox to mailbox "INBOX" of acc
    on error
      try
        set inboxMbox to inbox of acc
      on error
        set inboxMbox to missing value
      end try
    end try
    if inboxMbox is not missing value then
      try
        set msgs to (messages 1 thru (maxMsgs + 5) of inboxMbox)
        repeat with m in msgs
          if gathered ≥ maxMsgs then exit repeat
          try
            set msgId to (id of m) as string
            set msgAcc to (name of acc)
            set msgBox to "INBOX"
            set msgSubj to (subject of m)
            if msgSubj is missing value then set msgSubj to "(no subject)"
            set msgSender to (sender of m)
            if msgSender is missing value then set msgSender to ""
            set msgDate to (date received of m) as string
            set msgRead to (read status of m) as string
            try
              set msgContent to (content of m)
            on error
              set msgContent to ""
            end try
            set msgPreview to text 1 thru (min(200, (length of msgContent))) of msgContent
            set out to out & msgId & fieldSep & msgAcc & fieldSep & msgBox & fieldSep & msgSubj & fieldSep & msgSender & fieldSep & msgDate & fieldSep & msgRead & fieldSep & msgPreview & rowSep
            set gathered to gathered + 1
          on error
            -- skip unreadable message
          end try
        end repeat
      on error
        -- skip account
      end try
    end if
    if gathered ≥ maxMsgs then exit repeat
  end repeat
end tell

on min(a, b)
  if a < b then return a
  return b
end min

return out
`
  try {
    const raw = await runOsa(script)
    return parseMessages(raw).slice(0, count)
  } catch (err) {
    throw new Error(
      `mail query failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Count unread messages across all INBOX mailboxes.
 */
export async function getUnreadCount(): Promise<number> {
  const script = `
set total to 0
tell application "Mail"
  repeat with acc in accounts
    try
      set inboxMbox to mailbox "INBOX" of acc
    on error
      try
        set inboxMbox to inbox of acc
      on error
        set inboxMbox to missing value
      end try
    end try
    if inboxMbox is not missing value then
      try
        set total to total + (unread count of inboxMbox)
      on error
        -- skip
      end try
    end if
  end repeat
end tell
return total
`
  try {
    const raw = await runOsa(script)
    const n = parseInt(raw.trim(), 10)
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

/**
 * Search recent messages by substring match against subject, sender, or
 * preview content. Only searches the recent N messages across all inboxes
 * (AppleScript `whose` clauses on Mail are painfully slow, so we pull and
 * filter in JS).
 */
export async function searchRecentMessages(
  query: string,
  searchDepth = 50,
): Promise<MailMessage[]> {
  const all = await getRecentMessages(searchDepth)
  const q = query.toLowerCase()
  return all.filter(
    (m) =>
      m.subject.toLowerCase().includes(q) ||
      m.sender.toLowerCase().includes(q) ||
      m.preview.toLowerCase().includes(q),
  )
}

/**
 * Get the full body of a message by its AppleScript id. Capped to keep the
 * payload sane.
 */
export async function readMessageBody(messageId: string): Promise<string> {
  const script = `
tell application "Mail"
  set found to missing value
  repeat with acc in accounts
    try
      set inboxMbox to mailbox "INBOX" of acc
      set matches to (every message of inboxMbox whose id is "${messageId.replace(/"/g, '\\"')}")
      if (count of matches) > 0 then
        set found to item 1 of matches
        exit repeat
      end if
    on error
      -- skip
    end try
  end repeat
  if found is missing value then
    return ""
  end if
  set bodyText to content of found
  if bodyText is missing value then return ""
  return bodyText
end tell
`
  try {
    const raw = await runOsa(script)
    return raw.slice(0, 8000)
  } catch {
    return ''
  }
}

/**
 * Format messages for agent consumption.
 */
export function formatMessages(msgs: MailMessage[]): string {
  if (msgs.length === 0) return '(no messages)'
  return msgs
    .map((m) => {
      const unread = m.isRead ? '' : ' •'
      const lines = [
        `- ${m.subject}${unread}`,
        `  from: ${m.sender}`,
        `  date: ${m.dateReceived}`,
        `  id: ${m.id}`,
      ]
      if (m.preview) lines.push(`  preview: ${m.preview.replace(/\n/g, ' ').slice(0, 160)}`)
      return lines.join('\n')
    })
    .join('\n')
}
