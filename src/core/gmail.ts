/**
 * Gmail integration via the `gws` CLI (https://github.com/googleworkspace/cli).
 *
 * Dot shells out to the `gws` Rust binary instead of using the `googleapis`
 * Node library. `gws` stores its OAuth state under ~/.config/gws/ (encrypted
 * at rest, key in the macOS keyring). The user runs `gws auth login` once in
 * a terminal; Dot never handles the OAuth dance herself.
 *
 * The `gmail_setup_auth` MCP tool spawns Terminal.app with `gws auth login
 * -s gmail,calendar` when Dot detects tokens are missing.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'

const execFileP = promisify(execFile)

function resolveGwsBin(): string {
  if (process.env['GWS_BINARY']) return process.env['GWS_BINARY']
  for (const p of ['/opt/homebrew/bin/gws', '/usr/local/bin/gws']) {
    if (fs.existsSync(p)) return p
  }
  return 'gws'
}
const GWS_BIN = resolveGwsBin()
const EXEC_TIMEOUT_MS = 30_000
const MAX_BUFFER = 10 * 1024 * 1024

// ======================== shell-out helper ========================

interface GwsError {
  error?: { code?: number; message?: string; reason?: string }
}

async function runGws<T = unknown>(args: string[]): Promise<T> {
  try {
    const { stdout } = await execFileP(GWS_BIN, args, {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    })
    if (!stdout.trim()) return {} as T
    return JSON.parse(stdout) as T
  } catch (err) {
    // execFile rejects with an Error that has stdout/stderr attached
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
    // gws prints structured JSON errors to stdout even on non-zero exit
    if (e.stdout) {
      try {
        const parsed = JSON.parse(e.stdout) as GwsError
        const msg = parsed.error?.message ?? e.stderr ?? e.message
        throw new Error(`gws ${args[0]} failed: ${msg}`)
      } catch {
        // fall through
      }
    }
    throw new Error(`gws ${args[0]} failed: ${e.stderr ?? e.message}`)
  }
}

// ======================== auth status ========================

interface GwsAuthStatus {
  auth_method: string
  credential_source: string
  storage: string
  token_cache_exists: boolean
}

export async function isGmailReady(): Promise<boolean> {
  try {
    const status = await runGws<GwsAuthStatus>(['auth', 'status'])
    return status.auth_method !== 'none' && status.credential_source !== 'none'
  } catch {
    return false
  }
}

/**
 * Spawn a Terminal window running `gws auth login` so the user gets a real
 * TTY and can approve in their browser. Returns once Terminal has been
 * launched — does not wait for login to finish.
 */
export async function runOAuthFlow(): Promise<{ authUrl: string; waitForCode: () => Promise<boolean> }> {
  // Use AppleScript so Terminal actually executes the command, not just opens.
  const cmd = `${GWS_BIN} auth login -s gmail,calendar`
  const osa = `tell application "Terminal" to activate\ntell application "Terminal" to do script "${cmd.replace(/"/g, '\\"')}"`
  await execFileP('osascript', ['-e', osa]).catch((err: Error) => {
    throw new Error(`failed to spawn Terminal for gws auth login: ${err.message}`)
  })
  // We no longer control the OAuth flow ourselves. Return a stub so the MCP
  // tool contract (authUrl + waitForCode) stays intact.
  return {
    authUrl: 'Terminal window opened — run `gws auth login -s gmail,calendar` there',
    waitForCode: async () => true,
  }
}

// ======================== types ========================

export interface GmailMessage {
  id: string
  threadId: string
  subject: string
  from: string
  to: string
  date: string
  snippet: string
  labels: string[]
  isUnread: boolean
}

interface GwsHeader {
  name: string
  value: string
}
interface GwsMessagePayload {
  headers?: GwsHeader[]
  body?: { data?: string; size?: number }
  parts?: GwsMessagePayload[]
  mimeType?: string
}
interface GwsMessage {
  id?: string
  threadId?: string
  labelIds?: string[]
  snippet?: string
  payload?: GwsMessagePayload
}
interface GwsMessageList {
  messages?: Array<{ id: string; threadId: string }>
  resultSizeEstimate?: number
}
interface GwsLabelList {
  labels?: Array<{ id: string; name: string; messagesUnread?: number }>
}

function headerMap(headers: GwsHeader[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const h of headers ?? []) {
    if (h.name && h.value) out[h.name.toLowerCase()] = h.value
  }
  return out
}

function parseMessage(msg: GwsMessage): GmailMessage {
  const h = headerMap(msg.payload?.headers)
  return {
    id: msg.id ?? '',
    threadId: msg.threadId ?? '',
    subject: h['subject'] ?? '(no subject)',
    from: h['from'] ?? '',
    to: h['to'] ?? '',
    date: h['date'] ?? '',
    snippet: msg.snippet ?? '',
    labels: msg.labelIds ?? [],
    isUnread: (msg.labelIds ?? []).includes('UNREAD'),
  }
}

// ======================== Gmail wrappers ========================

export async function searchMessages(
  query: string,
  maxResults = 15,
): Promise<GmailMessage[]> {
  const list = await runGws<GwsMessageList>([
    'gmail',
    'users',
    'messages',
    'list',
    '--params',
    JSON.stringify({ userId: 'me', q: query, maxResults }),
  ])
  const out: GmailMessage[] = []
  for (const item of list.messages ?? []) {
    if (!item.id) continue
    const full = await runGws<GwsMessage>([
      'gmail',
      'users',
      'messages',
      'get',
      '--params',
      JSON.stringify({
        userId: 'me',
        id: item.id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'To', 'Date'],
      }),
    ])
    out.push(parseMessage(full))
  }
  return out
}

export async function readMessage(messageId: string): Promise<{
  message: GmailMessage
  body: string
}> {
  const msg = await runGws<GwsMessage>([
    'gmail',
    'users',
    'messages',
    'get',
    '--params',
    JSON.stringify({ userId: 'me', id: messageId, format: 'full' }),
  ])

  let body = ''
  const extractText = (parts: GwsMessagePayload[] | undefined): void => {
    for (const p of parts ?? []) {
      if (p.mimeType === 'text/plain' && p.body?.data) {
        body += Buffer.from(p.body.data, 'base64url').toString('utf8')
      } else if (p.parts) {
        extractText(p.parts)
      }
    }
  }
  if (msg.payload?.body?.data) {
    body = Buffer.from(msg.payload.body.data, 'base64url').toString('utf8')
  } else {
    extractText(msg.payload?.parts)
  }
  if (!body) {
    const extractHtml = (parts: GwsMessagePayload[] | undefined): void => {
      for (const p of parts ?? []) {
        if (p.mimeType === 'text/html' && p.body?.data) {
          const html = Buffer.from(p.body.data, 'base64url').toString('utf8')
          body += html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        } else if (p.parts) {
          extractHtml(p.parts)
        }
      }
    }
    extractHtml(msg.payload?.parts)
  }

  return { message: parseMessage(msg), body: body.slice(0, 8000) }
}

export async function sendMessage(params: {
  to: string
  subject: string
  body: string
  cc?: string
  bcc?: string
  threadId?: string
}): Promise<{ id: string; threadId: string }> {
  const args = [
    'gmail',
    '+send',
    '--to',
    params.to,
    '--subject',
    params.subject,
    '--body',
    params.body,
  ]
  if (params.cc) args.push('--cc', params.cc)
  if (params.bcc) args.push('--bcc', params.bcc)
  if (params.threadId) args.push('--thread-id', params.threadId)

  const res = await runGws<{ id?: string; threadId?: string }>(args)
  return {
    id: res.id ?? '',
    threadId: res.threadId ?? '',
  }
}

export async function getUnreadCount(): Promise<number> {
  const res = await runGws<GwsMessageList>([
    'gmail',
    'users',
    'messages',
    'list',
    '--params',
    JSON.stringify({ userId: 'me', q: 'is:unread in:inbox', maxResults: 1 }),
  ])
  return res.resultSizeEstimate ?? 0
}

export async function getLabels(): Promise<
  Array<{ id: string; name: string; unread: number }>
> {
  const res = await runGws<GwsLabelList>([
    'gmail',
    'users',
    'labels',
    'list',
    '--params',
    JSON.stringify({ userId: 'me' }),
  ])
  const out: Array<{ id: string; name: string; unread: number }> = []
  for (const label of res.labels ?? []) {
    if (!label.id || !label.name) continue
    out.push({
      id: label.id,
      name: label.name,
      unread: label.messagesUnread ?? 0,
    })
  }
  return out
}

// ======================== formatting ========================

export function formatMessages(msgs: GmailMessage[]): string {
  if (msgs.length === 0) return '(no messages)'
  return msgs
    .map((m) => {
      const unread = m.isUnread ? ' •' : ''
      return [
        `- ${m.subject}${unread}`,
        `  from: ${m.from}`,
        `  date: ${m.date}`,
        `  id: ${m.id}`,
        m.snippet ? `  preview: ${m.snippet.slice(0, 120)}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n')
}

export const GMAIL_SETUP_PROMPT = `The user's Gmail isn't authorized with \`gws\` yet. Guide them through it in 2 steps.

# Step 1 — Spawn the auth flow

Call the \`gmail_setup_auth\` tool. It opens Terminal.app running:
\`gws auth login -s gmail,calendar\`

Tell the user: "opened a terminal — approve in your browser when it pops up."

# Step 2 — Confirm

After they say they approved, call \`gmail_unread_count\`. If it returns a number, say "gmail connected ✨".

If it fails with "missing project_id" or similar, tell them they need a GCP client_secret.json at \`~/.config/gws/client_secret.json\`. Direct them to run \`gws auth setup\` in a terminal (requires gcloud).

# Rules
- One step at a time.
- Keep messages short.
`
