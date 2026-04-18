import { useState, useEffect, useRef, useCallback } from 'react'
import { Pet } from './Pet'
import type { PetState, PermissionRequest, LoadingInfo, VoiceStatus } from './types'
import { startRecording, type Recorder } from './voice'

const MAX_ACTIVITY = 5
const HISTORY_KEY = 'nina:history'
const HISTORY_MAX = 50

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : []
  } catch {
    return []
  }
}

function saveHistory(history: string[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, HISTORY_MAX)))
  } catch {
    // ignore
  }
}

export function App() {
  const [state, setState] = useState<PetState>('idle')
  const [inputOpen, setInputOpen] = useState(false)
  const [value, setValue] = useState('')
  const [speech, setSpeech] = useState('')
  const [lastSpeech, setLastSpeech] = useState('')
  const [activity, setActivity] = useState<string[]>([])
  const [firstRun, setFirstRun] = useState(false)
  const [hovering, setHovering] = useState(false)
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null)
  const [farewell, setFarewell] = useState<string | null>(null)
  const [grown, setGrown] = useState(false)
  const [characterId, setCharacterId] = useState<string>('dot')
  const [isError, setIsError] = useState(false)
  const [loading, setLoading] = useState<LoadingInfo | null>(null)
  const [tickPulse, setTickPulse] = useState<'none' | 'idle' | 'escalated'>('none')
  const [voice, setVoice] = useState<VoiceStatus | null>(null)
  const [micState, setMicState] = useState<'idle' | 'listening' | 'transcribing'>('idle')
  const recorderRef = useRef<Recorder | null>(null)
  const speechRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const historyRef = useRef<string[]>(loadHistory())
  const historyIndexRef = useRef<number>(-1)
  const draftRef = useRef<string>('') // what the user was typing before they started recalling
  const speechTimer = useRef<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // No auto-dismiss timer. The bubble stays until:
  //   - The user sends a new command (pet:clear fires)
  //   - The user clicks the bubble to dismiss it
  //   - A new stream starts (pet:clear fires)
  // This prevents the bubble from disappearing while the user is still reading.
  const clearSpeechTimer = useCallback(() => {
    if (speechTimer.current) {
      window.clearTimeout(speechTimer.current)
      speechTimer.current = null
    }
  }, [])

  // Auto-resize the Electron window to fit Dot + her current bubble/input.
  // Measures the nina-panel and pads for the drag handle + margins.
  useEffect(() => {
    if (!panelRef.current) return
    const el = panelRef.current
    const measure = () => {
      const rect = el.getBoundingClientRect()
      // width: content + padding on both sides; height: content + space for handle/controls
      const w = Math.ceil(rect.width) + 40
      const h = Math.ceil(rect.height) + 60
      window.nina.resize(w, h).catch(() => {})
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [speech, inputOpen, activity.length, pendingPermission, loading, micState])

  useEffect(() => {
    const offStream = window.nina.onStream((text) => {
      setIsError(false)
      setSpeech((prev) => (prev + text).slice(-500))
      clearSpeechTimer()
      // Auto-scroll to bottom of speech bubble
      requestAnimationFrame(() => {
        if (speechRef.current) {
          speechRef.current.scrollTop = speechRef.current.scrollHeight
        }
      })
    })
    const offState = window.nina.onState((s) => setState(s))
    const offTool = window.nina.onTool((label) => {
      setActivity((prev) => [...prev, label].slice(-MAX_ACTIVITY))
    })
    const offClear = window.nina.onClear(() => {
      setActivity([])
      setSpeech('')
      setIsError(false)
    })
    const offDone = window.nina.onDone(() => {
      window.setTimeout(() => setActivity([]), 4000)
      // Keep the bubble visible after Dot finishes talking so the user can
      // actually read it. It clears on the next command (pet:clear), on
      // explicit dismiss (the × button), or when a new stream starts.
      setSpeech((current) => {
        if (current) setLastSpeech(current)
        return current
      })
    })
    const offError = window.nina.onError((err) => {
      setIsError(true)
      setSpeech(`⚠ ${err}`)
      // Errors stay visible until dismissed — no timer
    })
    const offFirstRun = window.nina.onFirstRun(() => {
      setFirstRun(true)
      setSpeech("hi! i'm dot 🌱 tap me and say \"onboard me\" so i can get to know you")
    })
    const offFocusInput = window.nina.onFocusInput(() => {
      setInputOpen(true)
    })
    const offPermission = window.nina.onPermissionRequest((req) => {
      setPendingPermission(req)
      setInputOpen(false)
    })
    const offFarewell = window.nina.onFarewell((line) => {
      setFarewell(line)
    })
    const offLoading = window.nina.onLoading((info) => {
      if (info.status === 'ready' || info.status === 'error') {
        // Clear loading after a short delay so the user sees 100%
        setTimeout(() => setLoading(null), 800)
      } else {
        setLoading(info)
      }
    })
    const offGrown = window.nina.onGrown((g) => {
      setGrown(g)
    })
    const offCharacter = window.nina.onCharacter
      ? window.nina.onCharacter((id) => {
          setCharacterId(id || 'dot')
        })
      : () => {}
    const offTick = window.nina.onTick((ev) => {
      setTickPulse(ev.escalated ? 'escalated' : 'idle')
      window.setTimeout(() => setTickPulse('none'), ev.escalated ? 1250 : 750)
    })
    // Also fetch current grown state once on mount, in case the initial
    // pet:grown broadcast fired before this listener attached.
    window.nina.getGrown().then((g) => setGrown(g)).catch(() => {})

    return () => {
      offStream()
      offState()
      offTool()
      offClear()
      offDone()
      offError()
      offFirstRun()
      offFocusInput()
      offPermission()
      offLoading()
      offFarewell()
      offGrown()
      offCharacter()
      offTick()
    }
  }, [clearSpeechTimer])

  // Fetch initial voice status and subscribe to updates.
  useEffect(() => {
    window.nina.voiceStatus().then(setVoice).catch(() => {})
    const off = window.nina.onVoiceStatus((s) => setVoice(s))
    return () => off()
  }, [])

  const toggleMic = useCallback(async () => {
    if (micState === 'listening') {
      // Stop + transcribe
      const rec = recorderRef.current
      recorderRef.current = null
      if (!rec) {
        setMicState('idle')
        return
      }
      setMicState('transcribing')
      try {
        const pcm = await rec.stop()
        if (pcm.length === 0) {
          setMicState('idle')
          return
        }
        await window.nina.voiceSubmitAudio(pcm)
      } catch (err) {
        console.warn('[voice] submit failed:', err)
      } finally {
        setMicState('idle')
      }
      return
    }
    if (micState === 'transcribing') return // wait for current pass

    // Start recording
    try {
      // Opt desktop voice in the first time the user hits the mic.
      if (!voice?.enabled) {
        await window.nina.voiceEnable()
      }
      const rec = await startRecording()
      recorderRef.current = rec
      setMicState('listening')
    } catch (err) {
      console.warn('[voice] start failed:', err)
      setSpeech(`⚠ mic error: ${(err as Error).message}`)
      setIsError(true)
    }
  }, [micState, voice?.enabled])

  // ⌘⇧V — global push-to-talk. Main process sends pet:voice-listen.
  useEffect(() => {
    const off = window.nina.onVoiceListenRequest(() => {
      void toggleMic()
    })
    return () => off()
  }, [toggleMic])

  // Clear the lingering transcript toast when Dot starts streaming her reply.
  useEffect(() => {
    const off = window.nina.onVoiceTranscript(() => {
      // The main process already dispatched a runPrompt — the stream will
      // come through the normal pet:stream channel. Nothing to do here,
      // but the hook is here for future "show what I heard" UI.
    })
    return () => off()
  }, [])

  const answerPermission = useCallback(async (allowed: boolean) => {
    if (!pendingPermission) return
    await window.nina.resolvePermission(pendingPermission.id, allowed)
    setPendingPermission(null)
  }, [pendingPermission])

  useEffect(() => {
    if (!pendingPermission) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Enter' || e.key.toLowerCase() === 'y') {
        e.preventDefault()
        answerPermission(true)
      } else if (e.key === 'Escape' || e.key.toLowerCase() === 'n') {
        e.preventDefault()
        answerPermission(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pendingPermission, answerPermission])

  useEffect(() => {
    if (inputOpen) inputRef.current?.focus()
  }, [inputOpen])

  async function submit() {
    const prompt = value.trim()
    if (!prompt) return
    setValue('')
    setInputOpen(false)
    setSpeech('')
    setActivity([])
    setFirstRun(false)

    // Save to history (dedupe if same as most recent)
    const history = historyRef.current
    if (history[0] !== prompt) {
      historyRef.current = [prompt, ...history].slice(0, HISTORY_MAX)
      saveHistory(historyRef.current)
    }
    historyIndexRef.current = -1

    await window.nina.sendCommand(prompt)
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      submit()
      return
    }
    if (e.key === 'Escape') {
      setInputOpen(false)
      setValue('')
      historyIndexRef.current = -1
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      const history = historyRef.current
      if (history.length === 0) return
      // Capture the current draft the first time we arrow up
      if (historyIndexRef.current === -1) {
        draftRef.current = value
      }
      const next = Math.min(historyIndexRef.current + 1, history.length - 1)
      historyIndexRef.current = next
      setValue(history[next] ?? '')
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const idx = historyIndexRef.current
      if (idx <= 0) {
        historyIndexRef.current = -1
        setValue(draftRef.current)
        return
      }
      const next = idx - 1
      historyIndexRef.current = next
      setValue(historyRef.current[next] ?? '')
      return
    }
  }

  return (
    <div
      className={`container ${farewell ? 'container--farewell' : ''}`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {/* Top-right hover controls */}
      <div className={`controls ${hovering ? 'controls--visible' : ''}`}>
        <button
          className={`ctrl-btn ${voice?.enabled ? 'ctrl-btn--on' : ''}`}
          title={voice?.enabled ? 'mute Dot (voice on)' : 'unmute Dot (voice off)'}
          onClick={async (e) => {
            e.stopPropagation()
            if (voice?.enabled) {
              await window.nina.voiceDisable()
            } else {
              await window.nina.voiceEnable()
            }
          }}
        >
          {voice?.enabled ? '🔊' : '🔇'}
        </button>
        <button
          className={`ctrl-btn ${micState !== 'idle' ? 'ctrl-btn--active' : ''}`}
          title={
            micState === 'listening'
              ? 'listening… click to send (⌘⇧V)'
              : micState === 'transcribing'
                ? 'transcribing…'
                : 'push to talk (⌘⇧V)'
          }
          onClick={(e) => {
            e.stopPropagation()
            void toggleMic()
          }}
        >
          {micState === 'listening' ? '●' : micState === 'transcribing' ? '…' : '🎙'}
        </button>
        <button
          className="ctrl-btn"
          title="Test spin (idle)"
          onClick={(e) => {
            e.stopPropagation()
            setTickPulse('idle')
            window.setTimeout(() => setTickPulse('none'), 750)
          }}
        >
          ↻
        </button>
        <button
          className="ctrl-btn"
          title="Test spin (escalated)"
          onClick={(e) => {
            e.stopPropagation()
            setTickPulse('escalated')
            window.setTimeout(() => setTickPulse('none'), 1250)
          }}
        >
          ⚡
        </button>
        <button
          className="ctrl-btn"
          title="Hide Dot (⌘⇧Space to summon)"
          onClick={(e) => {
            e.stopPropagation()
            window.nina.hide()
          }}
        >
          ×
        </button>
      </div>

      {/* Nina and her bubbles — positioned together like a comic panel */}
      <div className="nina-panel" ref={panelRef}>
        {/* Speech bubble — comic style, directly above her head */}
        {speech && !farewell && (
          <div
            ref={speechRef}
            className={`comic-bubble ${isError ? 'comic-bubble--error' : ''}`}
            onClick={(e) => {
              e.stopPropagation()
            }}
            style={{ userSelect: 'text', cursor: 'text' }}
            title="select text to copy"
          >
            <button
              className="comic-bubble__close"
              title="dismiss"
              onClick={(e) => {
                e.stopPropagation()
                setLastSpeech(speech)
                setSpeech('')
                setIsError(false)
              }}
            >
              ×
            </button>
            <div className="comic-bubble__text">{speech}</div>
            <div className="comic-bubble__tail" />
          </div>
        )}

        {/* Restore chip — shown when a bubble was dismissed but still recoverable */}
        {!speech && !farewell && lastSpeech && (
          <button
            className="restore-bubble"
            title="show last message"
            onClick={(e) => {
              e.stopPropagation()
              setSpeech(lastSpeech)
            }}
          >
            💬
          </button>
        )}

        {/* Activity tray — small, right next to her */}
        {activity.length > 0 && (
          <div className="activity">
            {activity.map((line, i) => (
              <div
                key={`${i}-${line}`}
                className={`activity__line ${i === activity.length - 1 ? 'activity__line--current' : ''}`}
              >
                {i === activity.length - 1 ? '▸ ' : '  '}
                {line}
              </div>
            ))}
          </div>
        )}

        {/* The creature herself */}
        <div
          className={`${firstRun ? 'first-run-glow' : ''} ${loading ? 'pet-loading-wrap' : ''} ${tickPulse !== 'none' ? `tick-pulse tick-pulse--${tickPulse}` : ''}`}
          onMouseDown={(e) => {
            // Cmd+click = drag the window via manual mousemove tracking.
            // Normal click falls through to Pet's onClick.
            if (!e.metaKey) return
            e.preventDefault()
            e.stopPropagation()
            let lastX = e.screenX
            let lastY = e.screenY
            const onMove = (ev: MouseEvent) => {
              const dx = ev.screenX - lastX
              const dy = ev.screenY - lastY
              lastX = ev.screenX
              lastY = ev.screenY
              if (dx !== 0 || dy !== 0) {
                window.nina.dragBy(dx, dy).catch(() => {})
              }
            }
            const onUp = () => {
              window.removeEventListener('mousemove', onMove)
              window.removeEventListener('mouseup', onUp)
            }
            window.addEventListener('mousemove', onMove)
            window.addEventListener('mouseup', onUp)
          }}
          style={{ cursor: 'grab' }}
        >
          {loading && <div className="loading-ring" />}
          <Pet
            state={state}
            grown={grown}
            characterId={characterId}
            onClick={() => setInputOpen((o) => !o)}
          />
        </div>

        {loading && (
          <div className="loading-overlay">
            <div className="loading-bar-track">
              <div
                className="loading-bar-fill"
                style={{ width: `${loading.progress ?? 0}%` }}
              />
            </div>
            <div className="loading-text">
              {loading.status === 'downloading'
                ? `downloading ${loading.file ?? 'model'}… ${loading.progress ?? 0}%`
                : loading.status === 'loading'
                  ? 'loading brain…'
                  : 'setting up…'}
            </div>
          </div>
        )}

        {micState !== 'idle' && (
          <div className="mic-status">
            {micState === 'listening' ? '🎙 listening… (⌘⇧V to stop)' : '… transcribing'}
          </div>
        )}

        {/* Input bubble — just below her */}
        {inputOpen && !pendingPermission && (
          <div className="comic-input">
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="what can I do?  ↑ for history"
            />
          </div>
        )}
      </div>

      {pendingPermission && (
        <div className="comic-permission">
          <div className="permission__label">
            {formatPermissionLabel(pendingPermission.tool)}
          </div>
          <div className="permission__reason">{pendingPermission.reason}</div>
          <div className="permission__actions">
            <button
              className="perm-btn perm-btn--yes"
              onClick={() => answerPermission(true)}
            >
              yes
            </button>
            <button
              className="perm-btn perm-btn--no"
              onClick={() => answerPermission(false)}
            >
              no
            </button>
          </div>
          <div className="permission__hint">enter / y · esc / n</div>
        </div>
      )}

      {farewell && (
        <div className="farewell-overlay">
          <div className="farewell-line">{farewell}</div>
          <div className="farewell-zzz">zzz…</div>
        </div>
      )}
    </div>
  )
}

function formatPermissionLabel(tool: string): string {
  switch (tool) {
    case 'Bash':
      return 'run command?'
    case 'Write':
      return 'write file?'
    case 'Edit':
      return 'edit file?'
    default:
      return `run ${tool.replace(/^mcp__nina__/, '')}?`
  }
}
