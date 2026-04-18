/**
 * core/channels/index.ts — Channel interface + registry.
 *
 * A Channel is a named input/output surface Dot speaks through. Today
 * there are two: `desktop` (the Electron window) and `telegram`. Adding
 * `slack` or `discord` later means dropping a new adapter in this dir
 * and registering it at startup — no changes to turn.ts or agent.ts.
 *
 * The Channel contract is deliberately small:
 *   - lifecycle: start/stop/status
 *   - outbound: send(text) + optional sendPhoto + optional push
 *   - metadata: primaryChatId, tone/security hints
 *
 * Inbound routing stays inside each adapter (each has its own transport
 * — long-poll for telegram, IPC for desktop). Adapters call into
 * `core/turn.ts` the same way today's telegram.ts does.
 *
 * This module does NOT replace telegram.ts's internals. It wraps them.
 * The refactor gradient stops there intentionally — refactoring the
 * transport itself is out of scope for M2.
 */

export interface ChannelStatus {
  running: boolean
  allowlistCount?: number
  primaryChatId?: string | number | null
  lastActivityIso?: string | null
  note?: string
}

export interface ChannelSendOpts {
  text: string
  /** Destination id (chatId for telegram, room for future slack). */
  to?: string | number
  /** Reply-to marker for transports that support threading. */
  replyTo?: string | number
}

export interface ChannelPhotoOpts extends ChannelSendOpts {
  base64: string
  mime: 'image/png' | 'image/jpeg'
  caption?: string
}

export interface Channel {
  /** Stable id — 'desktop', 'telegram', 'slack', ... */
  id: string
  /** Human-readable name. */
  label: string
  /** Hints rendered into system prompts when this channel is active. */
  toneHint?: string
  securityHint?: string
  /** True if the channel can receive proactive Dot-initiated pushes. */
  supportsProactive: boolean
  /** True if the channel can receive image attachments. */
  supportsPhotos: boolean

  start(): Promise<void> | void
  stop(): Promise<void> | void
  status(): ChannelStatus

  /** Send a text message. For desktop this is a no-op (text streams via
   *  the onText callbacks already); adapters that need to push text
   *  explicitly (telegram, slack) implement this. */
  send(opts: ChannelSendOpts): Promise<void>
  /** Optional — send a photo attachment. */
  sendPhoto?(opts: ChannelPhotoOpts): Promise<void>
  /** Optional — push a proactive message to the channel's primary id. */
  push?(text: string): Promise<void>
}

const registry = new Map<string, Channel>()

export function registerChannel(c: Channel): void {
  registry.set(c.id, c)
}

export function getChannel(id: string): Channel | undefined {
  return registry.get(id)
}

export function listChannels(): Channel[] {
  return [...registry.values()]
}

export function clearChannelRegistry(): void {
  registry.clear()
}
