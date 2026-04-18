import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const execFileP = promisify(execFile)

export type ScreenshotMode = 'full' | 'window' | 'region'

/**
 * Capture a macOS screenshot and return it as base64 PNG + metadata.
 *
 * Modes:
 *   - full   : entire main display
 *   - window : a specific window (asks the user to click a window — interactive)
 *   - region : user selects a rectangular region (interactive)
 *
 * For non-interactive "grab what the user is currently looking at" use full.
 */
export async function captureScreenshot(
  mode: ScreenshotMode = 'full',
): Promise<{ base64: string; path: string; mime: 'image/png' }> {
  const outDir = path.join(os.tmpdir(), 'nina-screenshots')
  fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `shot-${Date.now()}.png`)

  const args: string[] = []

  // -x : silent (no shutter sound)
  // -t png : output format
  args.push('-x', '-t', 'png')

  switch (mode) {
    case 'full':
      // Main display only
      args.push('-m')
      break
    case 'window':
      // Interactive window capture. User clicks the window they want.
      // -W = window selection mode, -o = don't include shadow
      args.push('-W', '-o')
      break
    case 'region':
      // Interactive region selection (crosshair)
      args.push('-i', '-o')
      break
  }

  args.push(outFile)

  await execFileP('screencapture', args, { timeout: 60_000 })

  if (!fs.existsSync(outFile)) {
    throw new Error(
      'screenshot capture failed (file not created — user may have cancelled the selection)',
    )
  }

  const buf = fs.readFileSync(outFile)

  // If the image is huge, downscale by reading dimensions via sips.
  // Most screens are 2x retina and the raw PNG can be 5-15 MB. We cap at
  // ~1 MB by downscaling via sips if needed. Claude doesn't need pixel-perfect
  // to understand a screen.
  let base64 = buf.toString('base64')
  if (buf.length > 1_500_000) {
    try {
      await execFileP('sips', ['-Z', '1600', outFile], { timeout: 10_000 })
      const resized = fs.readFileSync(outFile)
      base64 = resized.toString('base64')
    } catch {
      // fall through with original
    }
  }

  return { base64, path: outFile, mime: 'image/png' }
}
