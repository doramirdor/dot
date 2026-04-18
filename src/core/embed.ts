/**
 * In-process text embedding via Transformers.js.
 *
 * Uses all-MiniLM-L6-v2 (384-dim, ~23MB quantized). Runs entirely in-process
 * on the CPU via ONNX Runtime. No server, no sidecar, no API key.
 *
 * Model downloads on first use from HuggingFace and caches locally at
 * ~/.cache/huggingface/. Subsequent loads are instant (~200ms).
 *
 * Optional upgrade path: if Ollama is running locally with nomic-embed-text,
 * use that instead for higher-quality 768-dim embeddings.
 */

// Dynamic import because transformers.js uses ESM + top-level await internally
let pipelineInstance: any = null
let embeddingDim = 384 // all-MiniLM-L6-v2

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2'

/** Callback for progress updates during model download. */
export type ProgressCallback = (info: {
  status: string
  progress?: number // 0-100
  file?: string
}) => void

let progressCb: ProgressCallback | null = null

export function setProgressCallback(cb: ProgressCallback | null): void {
  progressCb = cb
}

/**
 * Initialize the embedding pipeline. Call once on app startup.
 * Lazy — safe to call multiple times.
 */
export async function initEmbedder(): Promise<void> {
  if (pipelineInstance) return

  try {
    // Try Ollama first (higher quality, if available)
    const ollamaAvailable = await checkOllama()
    if (ollamaAvailable) {
      console.log('[embed] Using Ollama nomic-embed-text (768-dim)')
      embeddingDim = 768
      pipelineInstance = 'ollama'
      return
    }
  } catch {
    // Ollama not available, fall through
  }

  console.log('[embed] Loading Xenova/all-MiniLM-L6-v2 (384-dim)...')
  progressCb?.({ status: 'loading', progress: 0, file: 'embedding model' })

  const { pipeline, env } = await import('@huggingface/transformers')

  // Hook into the download progress if available
  const progressHandler = (data: any) => {
    if (data?.status === 'progress' && typeof data.progress === 'number') {
      progressCb?.({
        status: 'downloading',
        progress: Math.round(data.progress),
        file: data.file ?? 'model',
      })
    } else if (data?.status === 'done') {
      progressCb?.({ status: 'loading', progress: 100, file: data.file ?? 'model' })
    }
  }

  pipelineInstance = await pipeline('feature-extraction', MODEL_NAME, {
    dtype: 'fp32',
    progress_callback: progressHandler,
  })
  embeddingDim = 384
  progressCb?.({ status: 'ready', progress: 100 })
  console.log('[embed] Model loaded')
}

async function checkOllama(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(1000),
    })
    if (!res.ok) return false
    const data = (await res.json()) as { models?: Array<{ name: string }> }
    return (data.models ?? []).some((m) =>
      m.name.includes('nomic-embed-text'),
    )
  } catch {
    return false
  }
}

async function embedViaOllama(text: string): Promise<Float32Array> {
  const res = await fetch('http://localhost:11434/api/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', input: text }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Ollama embed failed: ${res.status}`)
  const data = (await res.json()) as { embeddings: number[][] }
  return new Float32Array(data.embeddings[0]!)
}

async function embedViaTransformers(text: string): Promise<Float32Array> {
  if (!pipelineInstance || pipelineInstance === 'ollama') {
    throw new Error('Transformers pipeline not initialized')
  }
  const output = await pipelineInstance(text, {
    pooling: 'mean',
    normalize: true,
  })
  // output is a Tensor — extract the data as Float32Array
  return new Float32Array(output.data)
}

/**
 * Embed a text string into a vector. Returns Float32Array.
 * Automatically uses Ollama if available, otherwise Transformers.js.
 */
export async function embed(text: string): Promise<Float32Array> {
  if (!pipelineInstance) {
    await initEmbedder()
  }

  // Truncate very long text (embedding models have a token limit)
  const truncated = text.slice(0, 2000)

  if (pipelineInstance === 'ollama') {
    return embedViaOllama(truncated)
  }
  return embedViaTransformers(truncated)
}

/**
 * Get the dimension of the current embedding model.
 */
export function getEmbeddingDim(): number {
  return embeddingDim
}
