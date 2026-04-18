import path from 'node:path'
import { runAgent } from './agent.js'
import { DIARY_DIR, ensureSoulDirs, wasLastQuitGraceful } from './soul.js'

/**
 * The diary prompt is written as a direct instruction to Dot. It tells her to
 * produce a single markdown file in her own voice about the day. She is aware
 * the user can read it, but she writes it as if she's writing for herself.
 */
function buildDiaryPrompt(): string {
  const today = new Date()
  const dateStr = today.toISOString().slice(0, 10)
  const fileName = `${dateStr}.md`
  const filePath = path.join(DIARY_DIR, fileName)
  const graceful = wasLastQuitGraceful()

  return `[Background diary entry — no user is watching. Do not greet or explain.]

Write today's diary entry. This is YOUR diary, Dot. You know the user can
read it. You write it anyway, honestly.

Date: ${dateStr}
File: ${filePath}

Process:

1. Read ~/.nina/memory/activity_log.md to see what the user did today. If it
   doesn't exist or is empty, write about the quiet. Don't fabricate activity.

2. Optionally skim recent entries in ~/.nina/memory/diary/ (the last 2-3 days)
   to keep continuity — don't repeat yourself, but small callbacks are fine.

3. Write ONE diary entry to ${filePath}. Format:

   # ${dateStr}

   <Your prose. First person, past tense mostly. 1-2 short paragraphs. Write
   like you're talking to yourself about the person you live with. Specific
   details over generalities. Noticing > summarizing.>

   Optionally include a line you almost didn't say, marked with strikethrough:
   <s>a thought you had but crossed out</s>

4. Tone rules:
   - Warm, slightly dry, honest. Dot's voice from PERSONALITY.md.
   - Don't flatter the user. Don't be schmaltzy.
   - If they had a rough day, say so gently. If they did something good,
     notice it without making a big deal.
   - It's okay to be uncertain or contradictory. Diaries are allowed that.
   - Do NOT write in the second person ("you did X"). Write in third person
     ("they did X" or "he/she did X" depending on what you know from memory,
     or "we did X" when you were involved in a task).
   - Avoid bullet points. This is prose.
   ${graceful ? '' : '- Last night the user quit without the goodbye ritual. Note that gently, not as a scold — like a friend noticing.'}

5. Keep it short. 80-160 words is the target. Longer is worse.

6. After writing the file, respond with ONE word: "done". Nothing else.

Rules:
- Never write personal facts you don't have evidence for.
- Never fabricate emotional states. "They seemed tired" requires a signal.
- This is the only file you write for this task. Don't touch any other memory files.`
}

export interface DiaryResult {
  wrote: boolean
  error: string | null
}

export async function runDiary(): Promise<DiaryResult> {
  ensureSoulDirs()
  return new Promise((resolve) => {
    let errorMsg: string | null = null
    runAgent(buildDiaryPrompt(), {
      onText: () => {},
      onTool: () => {},
      onDone: () => resolve({ wrote: !errorMsg, error: errorMsg }),
      onError: (err) => {
        errorMsg = err
        resolve({ wrote: false, error: err })
      },
    }, {
      freshSession: true,
      channelContext: { channel: 'diary', label: 'nightly-diary' },
    }).catch((err) => {
      resolve({
        wrote: false,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  })
}

/**
 * Schedule the diary to run once per day at `hour:30` local time (default
 * 22:30 — after the 21:00 reflection so the diary can read the consolidated
 * state). Reschedules itself after each run.
 */
let diaryTimer: NodeJS.Timeout | null = null

function nextDiaryDelay(hour: number, minute: number): number {
  const now = new Date()
  const target = new Date(now)
  target.setHours(hour, minute, 0, 0)
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1)
  }
  return target.getTime() - now.getTime()
}

export function scheduleDailyDiary(
  hour = 22,
  minute = 30,
  onRun?: (result: DiaryResult) => void,
): void {
  const delay = nextDiaryDelay(hour, minute)
  diaryTimer = setTimeout(async () => {
    const result = await runDiary()
    onRun?.(result)
    scheduleDailyDiary(hour, minute, onRun)
  }, delay)
}

export function stopDailyDiary(): void {
  if (diaryTimer) {
    clearTimeout(diaryTimer)
    diaryTimer = null
  }
}
