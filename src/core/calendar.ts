/**
 * Calendar integration via the `gws` CLI (googleworkspace/cli).
 *
 * Dot shells out to `gws calendar …` for all reads and writes. OAuth state is
 * owned entirely by gws (`~/.config/gws/`), so this module is a thin
 * translation layer from our existing CalendarEvent shape to gws JSON output.
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

async function runGws<T = unknown>(args: string[]): Promise<T> {
  try {
    const { stdout } = await execFileP(GWS_BIN, args, {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    })
    if (!stdout.trim()) return {} as T
    return JSON.parse(stdout) as T
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
    if (e.stdout) {
      try {
        const parsed = JSON.parse(e.stdout) as { error?: { message?: string } }
        const msg = parsed.error?.message ?? e.stderr ?? e.message
        throw new Error(`gws ${args[0]} ${args[1] ?? ''} failed: ${msg}`)
      } catch {
        // fall through
      }
    }
    throw new Error(`gws ${args[0]} ${args[1] ?? ''} failed: ${e.stderr ?? e.message}`)
  }
}

export interface CalendarEvent {
  title: string
  calendar: string
  start: string
  end: string
  location: string
  notes: string
  allDay: boolean
}

// ---------- gws response shapes ----------

interface GwsDateTime {
  date?: string // YYYY-MM-DD for all-day
  dateTime?: string // RFC3339
  timeZone?: string
}
interface GwsEvent {
  id?: string
  summary?: string
  location?: string
  description?: string
  start?: GwsDateTime
  end?: GwsDateTime
  organizer?: { email?: string; displayName?: string }
  htmlLink?: string
}
interface GwsEventsResponse {
  items?: GwsEvent[]
  summary?: string // calendar name
}
interface GwsCalendarListResponse {
  items?: Array<{
    id?: string
    summary?: string
    accessRole?: string
    primary?: boolean
  }>
}

// ---------- formatting helpers ----------

function fmtLocal(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${day} ${hh}:${mm}`
}

function parseGwsDate(dt: GwsDateTime | undefined): { display: string; allDay: boolean } {
  if (!dt) return { display: '', allDay: false }
  if (dt.date) return { display: dt.date, allDay: true }
  if (dt.dateTime) return { display: fmtLocal(new Date(dt.dateTime)), allDay: false }
  return { display: '', allDay: false }
}

function toCalendarEvent(ev: GwsEvent, calendarName = 'primary'): CalendarEvent {
  const start = parseGwsDate(ev.start)
  const end = parseGwsDate(ev.end)
  return {
    title: ev.summary ?? '(no title)',
    calendar: calendarName,
    start: start.display,
    end: end.display,
    location: ev.location ?? '',
    notes: (ev.description ?? '').slice(0, 300),
    allDay: start.allDay,
  }
}

// ---------- queries ----------

async function queryEvents(timeMin: Date, timeMax: Date, maxResults = 50): Promise<CalendarEvent[]> {
  const res = await runGws<GwsEventsResponse>([
    'calendar',
    'events',
    'list',
    '--params',
    JSON.stringify({
      calendarId: 'primary',
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults,
    }),
  ])
  const calName = res.summary ?? 'primary'
  return (res.items ?? []).map((ev) => toCalendarEvent(ev, calName))
}

export async function getTodaysEvents(): Promise<CalendarEvent[]> {
  const now = new Date()
  const midnight = new Date(now)
  midnight.setHours(23, 59, 59, 999)
  return queryEvents(now, midnight, 30)
}

export async function getUpcomingEvents(hours: number): Promise<CalendarEvent[]> {
  const now = new Date()
  const end = new Date(now.getTime() + hours * 3600 * 1000)
  return queryEvents(now, end, 50)
}

export async function getEventsInDays(days: number): Promise<CalendarEvent[]> {
  const now = new Date()
  const end = new Date(now)
  end.setDate(end.getDate() + days)
  end.setHours(23, 59, 59, 999)
  return queryEvents(now, end, 80)
}

export async function searchEvents(query: string): Promise<CalendarEvent[]> {
  const now = new Date()
  const timeMin = new Date(now.getTime() - 14 * 24 * 3600 * 1000)
  const timeMax = new Date(now.getTime() + 90 * 24 * 3600 * 1000)
  const res = await runGws<GwsEventsResponse>([
    'calendar',
    'events',
    'list',
    '--params',
    JSON.stringify({
      calendarId: 'primary',
      q: query,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 200,
    }),
  ])
  const calName = res.summary ?? 'primary'
  return (res.items ?? []).map((ev) => toCalendarEvent(ev, calName))
}

export async function createEvent(params: {
  title: string
  startIso: string
  endIso: string
  location?: string
  notes?: string
  calendarName?: string
}): Promise<{ ok: boolean; error?: string }> {
  const startDate = new Date(params.startIso)
  const endDate = new Date(params.endIso)
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return { ok: false, error: 'invalid date' }
  }

  const calendarId = params.calendarName || 'primary'
  const body = {
    summary: params.title,
    location: params.location ?? '',
    description: params.notes ?? '',
    start: { dateTime: startDate.toISOString() },
    end: { dateTime: endDate.toISOString() },
  }

  try {
    await runGws([
      'calendar',
      'events',
      'insert',
      '--params',
      JSON.stringify({ calendarId }),
      '--json',
      JSON.stringify(body),
    ])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function listCalendars(): Promise<string[]> {
  try {
    const res = await runGws<GwsCalendarListResponse>([
      'calendar',
      'calendarList',
      'list',
      '--params',
      '{}',
    ])
    const out: string[] = []
    for (const cal of res.items ?? []) {
      const role = cal.accessRole ?? ''
      if (role === 'owner' || role === 'writer') {
        if (cal.summary) out.push(cal.summary)
      }
    }
    return out
  } catch {
    return []
  }
}

export function formatEvents(events: CalendarEvent[]): string {
  if (events.length === 0) return '(no events)'
  return events
    .map((e) => {
      const parts = [`- ${e.title}`, `${e.calendar}`, e.start, '→', e.end]
      if (e.allDay) parts.push('(all day)')
      if (e.location) parts.push(`@ ${e.location}`)
      let line = parts.join(' · ')
      if (e.notes) line += `\n    ${e.notes.slice(0, 120).replace(/\n/g, ' ')}`
      return line
    })
    .join('\n')
}
