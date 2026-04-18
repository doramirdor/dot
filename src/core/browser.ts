import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { chromium, type BrowserContext, type Page } from 'playwright'

const PROFILE_DIR = path.join(os.homedir(), '.nina', 'browser-profile')

let context: BrowserContext | null = null
let page: Page | null = null

// Map of ref-id -> element selector, rebuilt on each snapshot.
// Refs are stable within a single snapshot but may change after navigation.
let refMap = new Map<string, string>()
let refCounter = 0

async function ensureContext(): Promise<BrowserContext> {
  if (context) return context
  fs.mkdirSync(PROFILE_DIR, { recursive: true })

  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  })

  // Reuse the first page if present, otherwise create one.
  const pages = context.pages()
  page = pages[0] ?? (await context.newPage())

  context.on('close', () => {
    context = null
    page = null
    refMap.clear()
  })

  return context
}

async function ensurePage(): Promise<Page> {
  await ensureContext()
  if (!page || page.isClosed()) {
    page = await context!.newPage()
  }
  return page
}

export async function goto(url: string): Promise<{ title: string; url: string }> {
  const p = await ensurePage()
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  return { title: await p.title(), url: p.url() }
}

/**
 * Extract an accessibility-tree style snapshot of the page and return a compact
 * text representation with stable refs the agent can use to click/type.
 */
export async function snapshot(): Promise<string> {
  const p = await ensurePage()

  // Reset refs for this snapshot
  refMap = new Map()
  refCounter = 0

  // Build a list of interactive + text-bearing elements with CSS selectors.
  // We tag them with data-nina-ref so we can later resolve by ref id.
  const elements = await p.evaluate(() => {
    function cssPath(el: Element): string {
      const parts: string[] = []
      let node: Element | null = el
      while (node && node.nodeType === 1 && parts.length < 8) {
        const current: Element = node
        let part = current.tagName.toLowerCase()
        if (current.id) {
          part += `#${CSS.escape(current.id)}`
          parts.unshift(part)
          break
        }
        const parent: Element | null = current.parentElement
        if (parent) {
          const siblings: Element[] = Array.from(parent.children).filter(
            (c: Element) => c.tagName === current.tagName,
          )
          if (siblings.length > 1) {
            part += `:nth-of-type(${siblings.indexOf(current) + 1})`
          }
        }
        parts.unshift(part)
        node = parent
      }
      return parts.join(' > ')
    }

    const results: Array<{
      tag: string
      role: string
      name: string
      value: string
      selector: string
      visible: boolean
    }> = []

    const selectors = [
      'a[href]',
      'button',
      'input:not([type=hidden])',
      'textarea',
      'select',
      '[role=button]',
      '[role=link]',
      '[role=textbox]',
      '[role=combobox]',
      '[role=checkbox]',
      '[role=radio]',
      '[role=tab]',
      '[role=menuitem]',
      '[contenteditable=true]',
      '[onclick]',
    ]

    const seen = new WeakSet<Element>()
    for (const sel of selectors) {
      for (const el of Array.from(document.querySelectorAll(sel))) {
        if (seen.has(el)) continue
        seen.add(el)
        const rect = el.getBoundingClientRect()
        const style = window.getComputedStyle(el)
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none'
        if (!visible) continue

        const name =
          (el as HTMLElement).innerText?.trim().slice(0, 80) ||
          el.getAttribute('aria-label') ||
          el.getAttribute('placeholder') ||
          el.getAttribute('title') ||
          el.getAttribute('alt') ||
          ''
        const value =
          (el as HTMLInputElement).value ??
          (el as HTMLElement).getAttribute('value') ??
          ''

        results.push({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') ?? '',
          name: name.replace(/\s+/g, ' '),
          value: String(value).slice(0, 80),
          selector: cssPath(el),
          visible,
        })
      }
    }

    return {
      title: document.title,
      url: window.location.href,
      headings: Array.from(document.querySelectorAll('h1, h2, h3'))
        .slice(0, 12)
        .map((h) => `${h.tagName.toLowerCase()}: ${(h as HTMLElement).innerText.trim().slice(0, 120)}`),
      elements: results.slice(0, 120),
    }
  })

  // Assign refs and build the compact text output.
  const lines: string[] = []
  lines.push(`URL: ${elements.url}`)
  lines.push(`Title: ${elements.title}`)
  if (elements.headings.length > 0) {
    lines.push('Headings:')
    for (const h of elements.headings) lines.push(`  ${h}`)
  }
  lines.push('Interactive elements:')
  for (const el of elements.elements) {
    const ref = `r${++refCounter}`
    refMap.set(ref, el.selector)
    const role = el.role || el.tag
    const name = el.name ? ` "${el.name}"` : ''
    const val = el.value ? ` [value="${el.value}"]` : ''
    lines.push(`  [${ref}] ${role}${name}${val}`)
  }

  return lines.join('\n')
}

function resolveRef(ref: string): string {
  const sel = refMap.get(ref)
  if (!sel) throw new Error(`Unknown ref "${ref}". Call browser_snapshot first.`)
  return sel
}

export async function click(ref: string): Promise<string> {
  const p = await ensurePage()
  const selector = resolveRef(ref)
  await p.locator(selector).first().click({ timeout: 10_000 })
  await p.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {})
  return `clicked ${ref}`
}

export async function type(ref: string, text: string, submit = false): Promise<string> {
  const p = await ensurePage()
  const selector = resolveRef(ref)
  const loc = p.locator(selector).first()
  await loc.click({ timeout: 10_000 })
  await loc.fill(text, { timeout: 10_000 })
  if (submit) await p.keyboard.press('Enter')
  return `typed into ${ref}${submit ? ' and pressed Enter' : ''}`
}

export async function press(key: string): Promise<string> {
  const p = await ensurePage()
  await p.keyboard.press(key)
  return `pressed ${key}`
}

export async function waitFor(text: string, timeoutMs = 15_000): Promise<string> {
  const p = await ensurePage()
  await p.locator(`text=${text}`).first().waitFor({ timeout: timeoutMs })
  return `found "${text}"`
}

export async function screenshot(): Promise<string> {
  const p = await ensurePage()
  const buf = await p.screenshot({ type: 'png', fullPage: false })
  return `data:image/png;base64,${buf.toString('base64')}`
}

export async function getText(): Promise<string> {
  const p = await ensurePage()
  const text = await p.evaluate(() => document.body.innerText)
  return text.slice(0, 4000)
}

export async function closeBrowser(): Promise<void> {
  if (context) {
    await context.close().catch(() => {})
    context = null
    page = null
    refMap.clear()
  }
}
