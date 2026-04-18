export type PetState = 'idle' | 'thinking' | 'talking'

export interface LoadingInfo {
  status: string
  progress?: number
  file?: string
}

export interface PermissionRequest {
  id: string
  tool: string
  reason: string
  input: unknown
}

export interface VoiceStatus {
  enabled: boolean
  preferGroq: boolean
  groqConnected: boolean
  sayVoice: string | null
  sayRate: number
}

export interface NinaApi {
  sendCommand: (prompt: string) => Promise<void>
  abort: () => Promise<void>
  quit: () => Promise<void>
  onStream: (cb: (text: string) => void) => () => void
  onState: (cb: (state: PetState) => void) => () => void
  onTool: (cb: (label: string) => void) => () => void
  onClear: (cb: () => void) => () => void
  onDone: (cb: () => void) => () => void
  onError: (cb: (err: string) => void) => () => void
  onFirstRun: (cb: () => void) => () => void
  onFocusInput: (cb: () => void) => () => void
  onPermissionRequest: (cb: (req: PermissionRequest) => void) => () => void
  resolvePermission: (id: string, allowed: boolean) => Promise<void>
  onTokens: (cb: (tokens: number) => void) => () => void
  getTokens: () => Promise<number>
  getGrown: () => Promise<boolean>
  resize: (w: number, h: number) => Promise<void>
  dragBy: (dx: number, dy: number) => Promise<void>
  onLoading: (cb: (info: LoadingInfo) => void) => () => void
  onFarewell: (cb: (line: string) => void) => () => void
  onGrown: (cb: (grown: boolean) => void) => () => void
  onCharacter: (cb: (id: string) => void) => () => void
  onTick: (
    cb: (ev: { app: string | null; window: string | null; escalated: boolean }) => void,
  ) => () => void
  showDiary: () => Promise<void>
  hide: () => Promise<void>
  onboard: () => Promise<void>
  showMemory: () => Promise<void>
  showMindmap: () => Promise<void>

  voiceStatus: () => Promise<VoiceStatus>
  voiceEnable: () => Promise<void>
  voiceDisable: () => Promise<void>
  voiceStopSpeaking: () => Promise<void>
  voiceSubmitAudio: (pcm: Float32Array) => Promise<{ text: string }>
  voiceConnectGroq: (apiKey: string) => Promise<{ ok: boolean }>
  voiceUseGroq: (on: boolean) => Promise<{ ok: boolean; reason?: string }>
  onVoiceStatus: (cb: (s: VoiceStatus) => void) => () => void
  onVoiceTranscript: (cb: (text: string) => void) => () => void
  onVoiceListenRequest: (cb: () => void) => () => void
}

declare global {
  interface Window {
    nina: NinaApi
  }
}
