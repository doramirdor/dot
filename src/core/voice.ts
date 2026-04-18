/**
 * Voice — local-first STT + TTS for Dot.
 *
 * TTS: macOS `say` (zero dependencies, ships with every Mac). A single
 * currently-speaking process is tracked so new utterances cancel the
 * previous one instead of stepping on it. Abort signal also kills it.
 *
 * STT: Whisper-tiny via @huggingface/transformers, same lazy-load pattern
 * used by embed.ts. Caller hands us Float32 PCM at 16kHz (the renderer does
 * the decode + resample in Web Audio). If the user has opted into Groq, we
 * can route to Groq's hosted Whisper instead — the opt-in is explicit; by
 * default we stay local even when the key is present.
 *
 * Toggle state: per-context (desktop, or tg:<chatId>). Defaults off per
 * CLAUDE.md fixed decisions. Persists at ~/.dot/voice.json so it survives
 * restarts. A missing file is treated as "everything off", no migration.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { NINA_DIR } from './memory.js'
import { getSecret, setSecret, deleteSecret } from './keychain.js'

// ==================== toggle state ====================

const VOICE_STATE_PATH = path.join(NINA_DIR, 'voice.json')

export type VoiceContext = 'desktop' | `tg:${number}`

interface VoiceState {
  /** Contexts with voice enabled. Absent = off. */
  enabled: string[]
  /** When true, STT uses Groq hosted Whisper. Default false (local). */
  preferGroq: boolean
  /** macOS `say` voice name. `null` → system default. */
  sayVoice: string | null
  /** Words-per-minute for `say`. Default 185 — a natural conversational pace. */
  sayRate: number
}

const DEFAULT_STATE: VoiceState = {
  enabled: [],
  preferGroq: false,
  sayVoice: null,
  sayRate: 185,
}

let cachedState: VoiceState | null = null

function readState(): VoiceState {
  if (cachedState) return cachedState
  try {
    if (fs.existsSync(VOICE_STATE_PATH)) {
      const raw = fs.readFileSync(VOICE_STATE_PATH, 'utf8')
      const parsed = JSON.parse(raw) as Partial<VoiceState>
      cachedState = { ...DEFAULT_STATE, ...parsed }
      return cachedState
    }
  } catch (err) {
    console.warn('[voice] Failed to read voice.json:', err)
  }
  cachedState = { ...DEFAULT_STATE }
  return cachedState
}

function writeState(next: VoiceState): void {
  cachedState = next
  try {
    fs.mkdirSync(NINA_DIR, { recursive: true })
    fs.writeFileSync(VOICE_STATE_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8')
  } catch (err) {
    console.warn('[voice] Failed to write voice.json:', err)
  }
}

export function isVoiceEnabled(context: VoiceContext): boolean {
  return readState().enabled.includes(context)
}

export function enableVoice(context: VoiceContext): void {
  const state = readState()
  if (state.enabled.includes(context)) return
  writeState({ ...state, enabled: [...state.enabled, context] })
}

export function disableVoice(context: VoiceContext): void {
  const state = readState()
  if (!state.enabled.includes(context)) return
  writeState({ ...state, enabled: state.enabled.filter((c) => c !== context) })
}

export function getVoiceConfig(): {
  preferGroq: boolean
  sayVoice: string | null
  sayRate: number
  groqConnected: boolean
} {
  const state = readState()
  return {
    preferGroq: state.preferGroq,
    sayVoice: state.sayVoice,
    sayRate: state.sayRate,
    groqConnected: getSecret('groq-api-key') !== null,
  }
}

/**
 * Set the macOS `say` voice. Pass `null` to fall back to the system default.
 * The name must match what `say -v '?'` reports in column 1 (e.g., "Daniel").
 */
export function setSayVoice(name: string | null): void {
  const state = readState()
  writeState({ ...state, sayVoice: name && name.trim() ? name.trim() : null })
}

export function setSayRate(rate: number): void {
  const clamped = Math.max(80, Math.min(400, Math.round(rate)))
  const state = readState()
  writeState({ ...state, sayRate: clamped })
}

export interface SayVoiceInfo {
  name: string
  locale: string
  sample: string
}

/**
 * List every `say` voice installed on the Mac. Parses the three-column
 * output of `say -v '?'`: <Name>  <locale>    # sample sentence.
 */
export async function listSayVoices(): Promise<SayVoiceInfo[]> {
  if (process.platform !== 'darwin') return []
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/say', ['-v', '?'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let buf = ''
    child.stdout?.on('data', (c) => (buf += c.toString('utf8')))
    child.on('exit', () => {
      const voices: SayVoiceInfo[] = []
      for (const line of buf.split('\n')) {
        // Names can contain spaces ("Bad News"); locale is the first
        // xx_YY token; everything after "#" is the sample.
        const m = line.match(/^(.+?)\s+([a-z]{2}[_-][A-Z]{2})\s+#\s*(.*)$/)
        if (!m) continue
        voices.push({ name: m[1]!.trim(), locale: m[2]!, sample: m[3]!.trim() })
      }
      resolve(voices)
    })
    child.on('error', () => resolve([]))
  })
}

// ==================== TTS (macOS `say`) ====================

let currentSay: ChildProcess | null = null

/**
 * Strip characters that `say` can't pronounce cleanly. Emoji get spoken as
 * their CLDR name ("rocket", "sparkles", "seedling") which is jarring; same
 * for the ZWJ/variation-selector/skin-tone machinery inside compound
 * emoji. Markdown emphasis markers and a few stray glyphs go too. Text
 * that reduces to whitespace after stripping is returned as empty so the
 * caller can skip speaking entirely.
 */
function cleanForSpeech(text: string): string {
  return text
    // Extended_Pictographic covers emoji + pictographs; the other ranges
    // clean up the modifiers that glue compound emoji together.
    .replace(/[\p{Extended_Pictographic}\u200D\uFE0F\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]/gu, '')
    .replace(/[*_`~]+/g, '')       // markdown emphasis markers
    .replace(/\s+/g, ' ')           // collapse whitespace introduced by strips
    .trim()
}

/**
 * Speak a line through macOS `say`. Cancels any in-flight utterance first
 * so fresh replies immediately take over. Returns when `say` exits.
 *
 * The text is passed on stdin (not argv) so there is no length limit or
 * shell-escaping surprise.
 */
export async function speak(
  text: string,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  const trimmed = cleanForSpeech(text)
  if (!trimmed) return
  if (process.platform !== 'darwin') {
    console.warn('[voice] speak() is macOS-only; ignoring on', process.platform)
    return
  }

  stopSpeaking()

  const { sayVoice, sayRate } = readState()
  const args: string[] = []
  if (sayVoice) args.push('-v', sayVoice)
  args.push('-r', String(sayRate))

  return new Promise<void>((resolve) => {
    const child = spawn('/usr/bin/say', args, { stdio: ['pipe', 'ignore', 'ignore'] })
    currentSay = child

    const onAbort = () => {
      try { child.kill('SIGTERM') } catch {}
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.on('exit', () => {
      opts.signal?.removeEventListener('abort', onAbort)
      if (currentSay === child) currentSay = null
      resolve()
    })

    child.stdin?.end(trimmed)
  })
}

/** Kill any currently-speaking `say` process. No-op if nothing is running. */
export function stopSpeaking(): void {
  if (currentSay) {
    try { currentSay.kill('SIGTERM') } catch {}
    currentSay = null
  }
}

export function isSpeaking(): boolean {
  return currentSay !== null
}

// ==================== STT ====================

/** Target rate the local Whisper pipeline expects. The renderer resamples to this. */
export const WHISPER_SAMPLE_RATE = 16_000

const WHISPER_MODEL = 'Xenova/whisper-tiny'

let whisperPipeline: any = null
let whisperLoading: Promise<void> | null = null

export type VoiceProgressCallback = (info: {
  status: string
  progress?: number
  file?: string
}) => void

let progressCb: VoiceProgressCallback | null = null

export function setVoiceProgressCallback(cb: VoiceProgressCallback | null): void {
  progressCb = cb
}

async function ensureWhisper(): Promise<void> {
  if (whisperPipeline) return
  if (whisperLoading) return whisperLoading

  whisperLoading = (async () => {
    progressCb?.({ status: 'loading', progress: 0, file: 'whisper model' })
    try {
      const { pipeline } = await import('@huggingface/transformers')
      const progressHandler = (data: any) => {
        if (data?.status === 'progress' && typeof data.progress === 'number') {
          progressCb?.({
            status: 'downloading',
            progress: Math.round(data.progress),
            file: data.file ?? 'whisper',
          })
        } else if (data?.status === 'done') {
          progressCb?.({ status: 'loading', progress: 100, file: data.file ?? 'whisper' })
        }
      }
      whisperPipeline = await pipeline(
        'automatic-speech-recognition',
        WHISPER_MODEL,
        { dtype: 'fp32', progress_callback: progressHandler },
      )
      progressCb?.({ status: 'ready', progress: 100 })
      console.log('[voice] Whisper-tiny loaded')
    } catch (err) {
      whisperLoading = null
      throw err
    }
  })()

  return whisperLoading
}

interface TranscribeOptions {
  /** PCM samples at WHISPER_SAMPLE_RATE, mono. */
  pcm: Float32Array
  /** Hint for multilingual model. "en" is typical. */
  language?: string
  /** Force a specific engine. Default: honor state.preferGroq. */
  engine?: 'local' | 'groq'
  signal?: AbortSignal
}

export async function transcribe(opts: TranscribeOptions): Promise<string> {
  const state = readState()
  const engine: 'local' | 'groq' =
    opts.engine ?? (state.preferGroq && getSecret('groq-api-key') ? 'groq' : 'local')

  if (engine === 'groq') {
    return transcribeViaGroq(opts)
  }
  return transcribeViaLocalWhisper(opts)
}

async function transcribeViaLocalWhisper(opts: TranscribeOptions): Promise<string> {
  await ensureWhisper()
  if (!whisperPipeline) throw new Error('whisper pipeline unavailable')
  // Whisper pipeline accepts a raw Float32Array of samples at 16 kHz.
  const out = await whisperPipeline(opts.pcm, {
    language: opts.language ?? 'english',
    task: 'transcribe',
    chunk_length_s: 30,
  })
  const text = typeof out?.text === 'string' ? out.text : ''
  return text.trim()
}

async function transcribeViaGroq(opts: TranscribeOptions): Promise<string> {
  const apiKey = getSecret('groq-api-key')
  if (!apiKey) throw new Error('Groq API key not configured — run /voice connect groq first')

  // Groq's /audio/transcriptions endpoint expects a multipart upload with an
  // audio file. We wrap our PCM in a minimal 16-bit WAV header.
  const wav = pcmToWav(opts.pcm, WHISPER_SAMPLE_RATE)
  const form = new FormData()
  // Slice to a fresh ArrayBuffer — satisfies BlobPart's strict typing
  // (rejects Uint8Array<ArrayBufferLike> which could be shared memory).
  const wavBuffer = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav')
  form.append('model', 'whisper-large-v3')
  if (opts.language) form.append('language', opts.language)

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: opts.signal,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Groq STT failed (${res.status}): ${body.slice(0, 200)}`)
  }
  const data = (await res.json()) as { text?: string }
  return (data.text ?? '').trim()
}

/** Build a PCM16 WAV file from mono Float32 samples. */
function pcmToWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const pcm16 = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!))
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  const dataBytes = pcm16.byteLength
  const buf = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buf)
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)          // PCM chunk size
  view.setUint16(20, 1, true)           // PCM format
  view.setUint16(22, 1, true)           // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true)           // block align
  view.setUint16(34, 16, true)          // bits/sample
  writeStr(36, 'data')
  view.setUint32(40, dataBytes, true)
  new Uint8Array(buf, 44).set(new Uint8Array(pcm16.buffer))
  return new Uint8Array(buf)
}

// ==================== Groq onboarding ====================

/** Store the key in the macOS Keychain. Does NOT flip preferGroq on its own. */
export function connectGroq(apiKey: string): boolean {
  const trimmed = apiKey.trim()
  if (!trimmed) return false
  return setSecret('groq-api-key', trimmed)
}

/** Opt STT into Groq. Requires a stored key — returns false otherwise. */
export function enableGroqStt(): boolean {
  if (!getSecret('groq-api-key')) return false
  const state = readState()
  writeState({ ...state, preferGroq: true })
  return true
}

/** Switch STT back to local Whisper. Leaves the Groq key in place. */
export function disableGroqStt(): void {
  const state = readState()
  writeState({ ...state, preferGroq: false })
}

/** Forget the Groq key entirely and drop back to local. */
export function disconnectGroq(): void {
  deleteSecret('groq-api-key')
  const state = readState()
  writeState({ ...state, preferGroq: false })
}
