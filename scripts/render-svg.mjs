// Render an SVG file to PNG at exact pixel dimensions using Playwright.
// Usage: node scripts/render-svg.mjs <input.svg> <output.png> <width> <height>
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const [, , input, output, wStr, hStr] = process.argv
if (!input || !output || !wStr || !hStr) {
  console.error('usage: render-svg.mjs <input.svg> <output.png> <width> <height>')
  process.exit(1)
}
const width = parseInt(wStr, 10)
const height = parseInt(hStr, 10)

const svg = fs.readFileSync(path.resolve(input), 'utf8')
const html = `<!doctype html><html><head><style>
  html,body{margin:0;padding:0;background:transparent;}
  svg{display:block;width:${width}px;height:${height}px;}
</style></head><body>${svg}</body></html>`

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })
const page = await ctx.newPage()
await page.setContent(html, { waitUntil: 'load' })
await page.screenshot({ path: path.resolve(output), type: 'png', omitBackground: false, clip: { x: 0, y: 0, width, height } })
await browser.close()
console.log(`rendered ${input} → ${output} (${width}x${height})`)
