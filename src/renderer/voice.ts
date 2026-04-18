/**
 * Renderer-side voice helpers.
 *
 * Captures mic audio with MediaRecorder, decodes + resamples to 16 kHz mono
 * Float32 PCM (what the local Whisper pipeline expects), and hands it to
 * the main process over IPC for transcription.
 *
 * Lives in the renderer because `navigator.mediaDevices` and `AudioContext`
 * only exist in a browser context. Main does the heavy ML work.
 */

const TARGET_SAMPLE_RATE = 16_000

export interface Recorder {
  stop: () => Promise<Float32Array>
  cancel: () => void
}

/**
 * Start recording from the default mic. Returns a handle with `stop()` that
 * resolves to mono 16 kHz Float32 PCM samples, and `cancel()` that tears
 * everything down without producing audio.
 */
export async function startRecording(): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  })

  // Pick the first supported mime — webm/opus on Chromium, mp4 fallback.
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
  const mimeType = candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? ''
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  const chunks: Blob[] = []
  recorder.ondataavailable = (ev) => {
    if (ev.data.size > 0) chunks.push(ev.data)
  }

  recorder.start()

  const teardown = () => {
    try { recorder.stop() } catch {}
    stream.getTracks().forEach((t) => t.stop())
  }

  return {
    async stop(): Promise<Float32Array> {
      if (recorder.state === 'inactive') return new Float32Array(0)
      const stopped = new Promise<void>((resolve) => {
        recorder.addEventListener('stop', () => resolve(), { once: true })
      })
      recorder.stop()
      await stopped
      stream.getTracks().forEach((t) => t.stop())

      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
      const ab = await blob.arrayBuffer()
      if (ab.byteLength === 0) return new Float32Array(0)

      // AudioContext decodes any container format Chromium supports. We
      // then resample to 16 kHz via OfflineAudioContext.
      const ctx = new AudioContext()
      let decoded: AudioBuffer
      try {
        decoded = await ctx.decodeAudioData(ab.slice(0))
      } finally {
        void ctx.close()
      }

      return resampleMono(decoded, TARGET_SAMPLE_RATE)
    },
    cancel: teardown,
  }
}

/**
 * Downmix to mono + resample to `targetRate` using OfflineAudioContext.
 * Returns a Float32Array of samples in [-1, 1].
 */
async function resampleMono(
  buffer: AudioBuffer,
  targetRate: number,
): Promise<Float32Array> {
  const duration = buffer.duration
  const length = Math.max(1, Math.ceil(duration * targetRate))
  const offline = new OfflineAudioContext(1, length, targetRate)

  const src = offline.createBufferSource()
  // If source is multi-channel, downmix-to-mono happens automatically when
  // the destination is 1-channel.
  src.buffer = buffer
  src.connect(offline.destination)
  src.start(0)

  const rendered = await offline.startRendering()
  return rendered.getChannelData(0).slice() // copy out of the backing buffer
}
