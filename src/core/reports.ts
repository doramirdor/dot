/**
 * core/reports.ts — on-demand HTML reports for the user.
 *
 * The observability dashboard (dashboard.ts) is fixed-shape: it shows
 * "what Dot knows" in a standard layout. Reports are ad-hoc: "make me
 * an HTML of everything you know about project X from the last 2
 * weeks", "give me a readable list of all the emails we discussed
 * yesterday", etc.
 *
 * Shape:
 *   - Title + subtitle
 *   - Optional free-form body in markdown-ish plain text
 *   - Sections, each containing recalled memory items, conversation
 *     excerpts, or raw bullets the agent provides
 *
 * Stored under ~/.dot/reports/<slug>-<ts>.html so old reports are
 * browsable. Returns the absolute path for the caller to open.
 */
import fs from 'node:fs'
import path from 'node:path'
import { NINA_DIR } from './memory.js'

export const REPORTS_DIR = path.join(NINA_DIR, 'reports')

export interface ReportSection {
  heading: string
  /** Plain text — rendered inside <pre class="wrap">. Supports basic \n for line breaks. */
  body?: string
  /** Optional bullet list rendered under the body. */
  bullets?: string[]
}

export interface ReportInput {
  title: string
  subtitle?: string
  /** Short intro paragraph below the title. */
  intro?: string
  sections: ReportSection[]
  /** Optional footer note. */
  footer?: string
}

export function generateReport(input: ReportInput): string {
  fs.mkdirSync(REPORTS_DIR, { recursive: true })
  const slug = slugify(input.title)
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const file = path.join(REPORTS_DIR, `${slug}-${ts}.html`)

  const html = renderReportHtml(input)
  fs.writeFileSync(file, html, 'utf8')
  return file
}

export function listRecentReports(
  limit = 20,
): Array<{ file: string; title: string; createdAt: string }> {
  try {
    if (!fs.existsSync(REPORTS_DIR)) return []
    const names = fs.readdirSync(REPORTS_DIR).filter((n) => n.endsWith('.html'))
    const rows = names.map((name) => {
      const full = path.join(REPORTS_DIR, name)
      const stat = fs.statSync(full)
      return {
        file: full,
        title: humanizeSlug(name.replace(/\.html$/, '')),
        createdAt: stat.mtime.toISOString(),
      }
    })
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    return rows.slice(0, limit)
  } catch {
    return []
  }
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'report'
}

function humanizeSlug(s: string): string {
  // Strip trailing timestamp if present; turn dashes back into spaces.
  return s
    .replace(/-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/, '')
    .replace(/-/g, ' ')
}

function renderReportHtml(r: ReportInput): string {
  const sections = r.sections
    .map(
      (s) => `
      <section>
        <h2>${escapeHtml(s.heading)}</h2>
        ${s.body ? `<pre class="wrap">${escapeHtml(s.body)}</pre>` : ''}
        ${
          s.bullets && s.bullets.length > 0
            ? `<ul>${s.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`
            : ''
        }
      </section>`,
    )
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(r.title)} · Dot report</title>
<style>
  :root {
    --bg: #0f1115;
    --panel: #161a22;
    --border: #262b36;
    --text: #e6e8ec;
    --muted: #8b93a7;
    --accent: #7aa2f7;
    --mono: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    background: var(--bg);
    color: var(--text);
    font: 14px/1.6 -apple-system, system-ui, sans-serif;
    margin: 0;
    padding: 32px 24px;
    max-width: 860px;
    margin: 0 auto;
  }
  h1 {
    font-size: 24px;
    margin: 0 0 6px;
    font-weight: 700;
    color: var(--text);
  }
  .subtitle {
    color: var(--muted);
    font-size: 13px;
    margin-bottom: 4px;
  }
  .intro {
    color: var(--text);
    font-size: 14px;
    line-height: 1.7;
    margin: 16px 0 28px;
    padding: 14px 16px;
    background: var(--panel);
    border-left: 3px solid var(--accent);
    border-radius: 4px;
  }
  section {
    margin-bottom: 32px;
    padding-bottom: 24px;
    border-bottom: 1px solid var(--border);
  }
  section:last-of-type { border-bottom: none; }
  h2 {
    font-size: 16px;
    font-weight: 600;
    margin: 0 0 12px;
    color: var(--accent);
  }
  pre.wrap {
    white-space: pre-wrap;
    word-break: break-word;
    font: inherit;
    margin: 0 0 12px;
  }
  ul {
    margin: 0;
    padding-left: 20px;
  }
  li { margin: 4px 0; }
  footer {
    margin-top: 40px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
    font-family: var(--mono);
  }
  @media print {
    body { background: white; color: black; }
    .intro { background: #f6f6f6; }
    h2 { color: #000; }
    section { border-color: #ddd; }
  }
</style>
</head>
<body>
  <h1>${escapeHtml(r.title)}</h1>
  ${r.subtitle ? `<div class="subtitle">${escapeHtml(r.subtitle)}</div>` : ''}
  <div class="subtitle">generated ${new Date().toLocaleString()} · by Dot</div>
  ${r.intro ? `<div class="intro">${escapeHtml(r.intro)}</div>` : ''}
  ${sections}
  <footer>
    ${r.footer ? escapeHtml(r.footer) + ' · ' : ''}auto-saved to ~/.dot/reports/
  </footer>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
