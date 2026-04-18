/**
 * core/channels/desktop-channel.ts — Channel adapter for the Electron window.
 *
 * On desktop the primary output path is the streaming `onText` callback
 * in each turn — the renderer renders those chunks into a speech bubble.
 * So `send()` for desktop is an out-of-band notify: the caller wants to
 * show something WITHOUT running an agent turn. We delegate that to a
 * main-process handler registered via `registerDesktopHandlers()`.
 *
 * Photos aren't supported on desktop yet — the renderer's bubble is
 * text-only. `sendPhoto` is omitted so `supportsPhotos: false` is honest.
 */
import type { Channel, ChannelSendOpts, ChannelStatus } from './index.js'

type NotifyFn = (text: string) => void
type StatusProbe = () => { windowVisible: boolean }

let notifyFn: NotifyFn | null = null
let statusProbe: StatusProbe | null = null

export function registerDesktopHandlers(handlers: {
  notify: NotifyFn
  statusProbe: StatusProbe
}): void {
  notifyFn = handlers.notify
  statusProbe = handlers.statusProbe
}

export function createDesktopChannel(): Channel {
  return {
    id: 'desktop',
    label: 'Desktop bubble',
    toneHint:
      'You are replying inside the Dot pet bubble. Warm, concise. ' +
      'Use short paragraphs. No huge lists unless the user asked.',
    supportsProactive: true,
    supportsPhotos: false,
    start: () => {
      // Desktop channel has no lifecycle — the window owns it.
    },
    stop: () => {
      /* no-op */
    },
    status(): ChannelStatus {
      const probe = statusProbe?.()
      return {
        running: true,
        primaryChatId: 'local',
        note: probe
          ? `window ${probe.windowVisible ? 'visible' : 'hidden'}`
          : 'no window probe registered',
      }
    },
    async send(opts: ChannelSendOpts) {
      if (!notifyFn) throw new Error('desktop: notify handler not registered')
      notifyFn(opts.text)
    },
    async push(text: string) {
      if (!notifyFn) throw new Error('desktop: notify handler not registered')
      notifyFn(text)
    },
  }
}
