/**
 * Native macOS notifications — for proactive interrupts when Nina's window
 * is hidden or the user is in another app.
 *
 * Uses osascript `display notification` which is zero-dependency and works
 * without any TCC prompt. The notification appears in Notification Center
 * and the banner shows for ~5 seconds.
 *
 * Limitation: no action buttons, no custom icon (shows Terminal icon since
 * we invoke via osascript). To get a real Nina icon, we'd need a Swift helper
 * registered as an app, which is a future enhancement.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export async function sendNotification(
  message: string,
  title = 'Dot',
  subtitle?: string,
): Promise<void> {
  const safeMsg = message.replace(/"/g, '\\"').slice(0, 200)
  const safeTitle = title.replace(/"/g, '\\"')
  const subtitlePart = subtitle
    ? ` subtitle "${subtitle.replace(/"/g, '\\"').slice(0, 80)}"`
    : ''

  try {
    await execFileP(
      'osascript',
      [
        '-e',
        `display notification "${safeMsg}" with title "${safeTitle}"${subtitlePart}`,
      ],
      { timeout: 3000 },
    )
  } catch (err) {
    console.warn('[nina] notification failed:', err)
  }
}
