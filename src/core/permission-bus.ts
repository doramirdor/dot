/**
 * Permission bus: the bridge between the agent's `canUseTool` callback
 * (which runs in main-process Promise-land) and the renderer's confirmation
 * bubble (which resolves via IPC).
 *
 * When the agent wants to run a tier-2 tool, it calls `requestPermission`,
 * which generates a unique id, stores the resolver, and returns a promise.
 * The main process then sends a 'pet:permission-request' IPC to the renderer.
 * The user clicks yes/no, renderer invokes 'pet:permission-resolve', and
 * main process calls the matching resolver.
 */

interface PendingRequest {
  resolve: (allowed: boolean) => void
  timeout: NodeJS.Timeout
}

const pending = new Map<string, PendingRequest>()

const DEFAULT_TIMEOUT_MS = 120_000 // 2 min — user might be AFK

export interface PermissionRequestPayload {
  id: string
  tool: string
  reason: string
  input: unknown
}

export function createPermissionRequest(
  tool: string,
  reason: string,
  input: unknown,
  send: (payload: PermissionRequestPayload) => void,
): Promise<boolean> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      pending.delete(id)
      resolve(false) // default deny on timeout
    }, DEFAULT_TIMEOUT_MS)

    pending.set(id, { resolve, timeout })

    try {
      send({ id, tool, reason, input })
    } catch (err) {
      clearTimeout(timeout)
      pending.delete(id)
      console.warn('[nina] Failed to send permission request:', err)
      resolve(false)
    }
  })
}

export function resolvePermissionRequest(id: string, allowed: boolean): void {
  const req = pending.get(id)
  if (!req) return
  clearTimeout(req.timeout)
  pending.delete(id)
  req.resolve(allowed)
}

export function cancelAllPending(): void {
  for (const [, req] of pending) {
    clearTimeout(req.timeout)
    req.resolve(false)
  }
  pending.clear()
}
