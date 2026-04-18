import { contextBridge, ipcRenderer } from 'electron'

export type PetState = 'idle' | 'thinking' | 'talking'

export interface LoadingInfo {
  status: string // 'loading' | 'downloading' | 'ready' | 'error'
  progress?: number // 0-100
  file?: string
}

export interface PermissionRequest {
  id: string
  tool: string
  reason: string
  input: unknown
}

const api = {
  sendCommand: (prompt: string): Promise<void> =>
    ipcRenderer.invoke('pet:command', prompt),
  abort: (): Promise<void> => ipcRenderer.invoke('pet:abort'),
  quit: (): Promise<void> => ipcRenderer.invoke('pet:quit'),

  onStream: (cb: (text: string) => void) => {
    const listener = (_: unknown, text: string) => cb(text)
    ipcRenderer.on('pet:stream', listener)
    return () => ipcRenderer.off('pet:stream', listener)
  },
  onState: (cb: (state: PetState) => void) => {
    const listener = (_: unknown, state: PetState) => cb(state)
    ipcRenderer.on('pet:state', listener)
    return () => ipcRenderer.off('pet:state', listener)
  },
  onTool: (cb: (label: string) => void) => {
    const listener = (_: unknown, label: string) => cb(label)
    ipcRenderer.on('pet:tool', listener)
    return () => ipcRenderer.off('pet:tool', listener)
  },
  onClear: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('pet:clear', listener)
    return () => ipcRenderer.off('pet:clear', listener)
  },
  onDone: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('pet:done', listener)
    return () => ipcRenderer.off('pet:done', listener)
  },
  onError: (cb: (err: string) => void) => {
    const listener = (_: unknown, err: string) => cb(err)
    ipcRenderer.on('pet:error', listener)
    return () => ipcRenderer.off('pet:error', listener)
  },
  onFirstRun: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('pet:first-run', listener)
    return () => ipcRenderer.off('pet:first-run', listener)
  },
  onFocusInput: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('pet:focus-input', listener)
    return () => ipcRenderer.off('pet:focus-input', listener)
  },
  onPermissionRequest: (cb: (req: PermissionRequest) => void) => {
    const listener = (_: unknown, req: PermissionRequest) => cb(req)
    ipcRenderer.on('pet:permission-request', listener)
    return () => ipcRenderer.off('pet:permission-request', listener)
  },
  resolvePermission: (id: string, allowed: boolean): Promise<void> =>
    ipcRenderer.invoke('pet:permission-resolve', id, allowed),
  onTokens: (cb: (tokens: number) => void) => {
    const listener = (_: unknown, tokens: number) => cb(tokens)
    ipcRenderer.on('pet:tokens', listener)
    return () => ipcRenderer.off('pet:tokens', listener)
  },
  getTokens: (): Promise<number> => ipcRenderer.invoke('pet:get-tokens'),
  getGrown: (): Promise<boolean> => ipcRenderer.invoke('pet:get-grown'),
  resize: (w: number, h: number): Promise<void> => ipcRenderer.invoke('pet:resize', w, h),
  dragBy: (dx: number, dy: number): Promise<void> => ipcRenderer.invoke('pet:drag-by', dx, dy),
  onFarewell: (cb: (line: string) => void) => {
    const listener = (_: unknown, line: string) => cb(line)
    ipcRenderer.on('pet:farewell', listener)
    return () => ipcRenderer.off('pet:farewell', listener)
  },
  onLoading: (cb: (info: LoadingInfo) => void) => {
    const listener = (_: unknown, info: LoadingInfo) => cb(info)
    ipcRenderer.on('pet:loading', listener)
    return () => ipcRenderer.off('pet:loading', listener)
  },
  onGrown: (cb: (grown: boolean) => void) => {
    const listener = (_: unknown, grown: boolean) => cb(grown)
    ipcRenderer.on('pet:grown', listener)
    return () => ipcRenderer.off('pet:grown', listener)
  },
  onCharacter: (cb: (id: string) => void) => {
    const listener = (_: unknown, id: string) => cb(id)
    ipcRenderer.on('pet:character', listener)
    return () => ipcRenderer.off('pet:character', listener)
  },
  onTick: (cb: (ev: { app: string | null; window: string | null; escalated: boolean }) => void) => {
    const listener = (_: unknown, ev: { app: string | null; window: string | null; escalated: boolean }) => cb(ev)
    ipcRenderer.on('pet:tick', listener)
    return () => ipcRenderer.off('pet:tick', listener)
  },
  showDiary: (): Promise<void> => ipcRenderer.invoke('pet:show-diary'),
  hide: (): Promise<void> => ipcRenderer.invoke('pet:hide'),
  onboard: (): Promise<void> => ipcRenderer.invoke('pet:onboard'),
  showMemory: (): Promise<void> => ipcRenderer.invoke('pet:show-memory'),
  showMindmap: (): Promise<void> => ipcRenderer.invoke('pet:show-mindmap'),

  // --- provider setup window ---
  providerSetupSave: (payload: {
    providerId: string
    credential?: string
    model?: string
    importOpenclaw?: boolean
  }): Promise<void> => ipcRenderer.invoke('provider-setup:save', payload),

  // --- voice ---
  voiceStatus: (): Promise<VoiceStatus> => ipcRenderer.invoke('pet:voice-status'),
  voiceEnable: (): Promise<void> => ipcRenderer.invoke('pet:voice-enable'),
  voiceDisable: (): Promise<void> => ipcRenderer.invoke('pet:voice-disable'),
  voiceStopSpeaking: (): Promise<void> => ipcRenderer.invoke('pet:voice-stop-speaking'),
  /** Submit a mic recording as a chat prompt. Float32Array PCM @ 16 kHz, mono. */
  voiceSubmitAudio: (pcm: Float32Array): Promise<{ text: string }> =>
    ipcRenderer.invoke('pet:voice-submit-audio', pcm),
  voiceConnectGroq: (apiKey: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('pet:voice-connect-groq', apiKey),
  voiceUseGroq: (on: boolean): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('pet:voice-use-groq', on),
  onVoiceStatus: (cb: (s: VoiceStatus) => void) => {
    const listener = (_: unknown, s: VoiceStatus) => cb(s)
    ipcRenderer.on('pet:voice-status', listener)
    return () => ipcRenderer.off('pet:voice-status', listener)
  },
  onVoiceTranscript: (cb: (text: string) => void) => {
    const listener = (_: unknown, text: string) => cb(text)
    ipcRenderer.on('pet:voice-transcript', listener)
    return () => ipcRenderer.off('pet:voice-transcript', listener)
  },
  onVoiceListenRequest: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('pet:voice-listen', listener)
    return () => ipcRenderer.off('pet:voice-listen', listener)
  },
}

export interface VoiceStatus {
  enabled: boolean
  preferGroq: boolean
  groqConnected: boolean
  sayVoice: string | null
  sayRate: number
}

contextBridge.exposeInMainWorld('nina', api)

export type NinaApi = typeof api
