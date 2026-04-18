import { useEffect, useState, useMemo, useRef } from 'react'
import type { PetState } from './types'
import { getCharacter, paletteOf } from './characters'

/**
 * Nina the creature — inline SVG pixel art.
 *
 * Two growth forms:
 *   - Seedling (grown = false): green body with a leaf sprouting from her head.
 *     Rendered during onboarding and any time before she's grown up.
 *   - Adult    (grown = true):  blue body, no leaf. Her mature form after
 *     onboarding completes.
 *
 * Color transitions smoothly between forms via CSS (fill transition on every
 * rect). The leaf fades out when she grows.
 *
 * Per-state expressions (eyes, mouth, accessories) are independent of form
 * and swap based on PetState.
 */

interface PetProps {
  state: PetState
  grown: boolean
  onClick: () => void
  /** Character cast id — see renderer/characters.ts. Defaults to 'dot'. */
  characterId?: string
}

const GRID = 16
const CELL = 8 // → 128 × 128 on-screen pet

type ColorKey =
  | 'outline'
  | 'bodyLight'
  | 'body'
  | 'bodyShade'
  | 'cheek'
  | 'eyeWhite'
  | 'pupil'
  | 'leafDark'
  | 'leafMid'
  | 'leafLight'
  | 'stem'
  | 'gold'
  | 'sleep'
  | 'accent'

type Pixel = [number, number, ColorKey]

// Non-body colors used by the leaf sprite. The body palette now comes
// from the character registry (renderer/characters.ts) via paletteOf().
const FIXED_COLORS: Record<ColorKey, string> = {
  outline: '#1a1a2e',
  cheek: '#ffb5c5',
  eyeWhite: '#fffdf5',
  pupil: '#1a1a2e',
  leafDark: '#2b7a3e',
  leafMid: '#8dd080',
  leafLight: '#b5e4a8',
  stem: '#3b5323',
  gold: '#ffd56b',
  sleep: '#9fe0f5',
  bodyLight: '#b5e4a8',
  body: '#8dd080',
  bodyShade: '#5fa05a',
  accent: '#8dd080',
}

function paletteFor(characterId: string | undefined, grown: boolean): Record<ColorKey, string> {
  return paletteOf(characterId, grown)
}

// ============ leaf + stem (only rendered when !grown) ============

const LEAF_PIXELS: Pixel[] = [
  [7, 0, 'leafDark'],
  [8, 0, 'leafDark'],
  [6, 1, 'leafDark'],
  [7, 1, 'leafLight'],
  [8, 1, 'leafMid'],
  [9, 1, 'leafDark'],
  [5, 2, 'leafDark'],
  [6, 2, 'leafLight'],
  [7, 2, 'leafMid'],
  [8, 2, 'leafMid'],
  [9, 2, 'leafMid'],
  [10, 2, 'leafDark'],
  [7, 3, 'stem'],
  [8, 3, 'stem'],
]

// ============ body (shape same for both forms, colors swap) ============

const BODY: Pixel[] = [
  // row 4 — top of body
  [5, 4, 'outline'],
  [6, 4, 'outline'],
  [7, 4, 'outline'],
  [8, 4, 'outline'],
  [9, 4, 'outline'],
  [10, 4, 'outline'],

  // row 5
  [4, 5, 'outline'],
  [5, 5, 'bodyLight'],
  [6, 5, 'body'],
  [7, 5, 'body'],
  [8, 5, 'body'],
  [9, 5, 'body'],
  [10, 5, 'bodyShade'],
  [11, 5, 'outline'],

  // row 6
  [3, 6, 'outline'],
  [4, 6, 'bodyLight'],
  [5, 6, 'body'],
  [6, 6, 'body'],
  [7, 6, 'body'],
  [8, 6, 'body'],
  [9, 6, 'body'],
  [10, 6, 'body'],
  [11, 6, 'bodyShade'],
  [12, 6, 'outline'],

  // row 7 — eye row
  [3, 7, 'outline'],
  [4, 7, 'body'],
  [5, 7, 'body'],
  [6, 7, 'body'],
  [7, 7, 'body'],
  [8, 7, 'body'],
  [9, 7, 'body'],
  [10, 7, 'body'],
  [11, 7, 'body'],
  [12, 7, 'outline'],

  // row 8
  [3, 8, 'outline'],
  [4, 8, 'body'],
  [5, 8, 'body'],
  [6, 8, 'body'],
  [7, 8, 'body'],
  [8, 8, 'body'],
  [9, 8, 'body'],
  [10, 8, 'body'],
  [11, 8, 'body'],
  [12, 8, 'outline'],

  // row 9 — cheek row
  [3, 9, 'outline'],
  [4, 9, 'body'],
  [5, 9, 'body'],
  [6, 9, 'body'],
  [7, 9, 'body'],
  [8, 9, 'body'],
  [9, 9, 'body'],
  [10, 9, 'body'],
  [11, 9, 'body'],
  [12, 9, 'outline'],

  // row 10 — mouth row
  [3, 10, 'outline'],
  [4, 10, 'body'],
  [5, 10, 'body'],
  [6, 10, 'body'],
  [7, 10, 'body'],
  [8, 10, 'body'],
  [9, 10, 'body'],
  [10, 10, 'body'],
  [11, 10, 'body'],
  [12, 10, 'outline'],

  // row 11
  [3, 11, 'outline'],
  [4, 11, 'bodyShade'],
  [5, 11, 'body'],
  [6, 11, 'body'],
  [7, 11, 'body'],
  [8, 11, 'body'],
  [9, 11, 'body'],
  [10, 11, 'body'],
  [11, 11, 'bodyShade'],
  [12, 11, 'outline'],

  // row 12
  [4, 12, 'outline'],
  [5, 12, 'bodyShade'],
  [6, 12, 'body'],
  [7, 12, 'body'],
  [8, 12, 'body'],
  [9, 12, 'body'],
  [10, 12, 'bodyShade'],
  [11, 12, 'outline'],

  // row 13
  [5, 13, 'outline'],
  [6, 13, 'bodyShade'],
  [7, 13, 'bodyShade'],
  [8, 13, 'bodyShade'],
  [9, 13, 'bodyShade'],
  [10, 13, 'outline'],

  // row 14
  [6, 14, 'outline'],
  [7, 14, 'outline'],
  [8, 14, 'outline'],
  [9, 14, 'outline'],
]

// Shadow under the creature
function Shadow() {
  return (
    <ellipse
      cx={GRID * CELL * 0.5}
      cy={GRID * CELL * 0.97}
      rx={GRID * CELL * 0.24}
      ry={CELL * 0.6}
      fill="rgba(0,0,0,0.22)"
      className="pet-shadow"
    />
  )
}

// ============ expressions (per state) ============

type PixelRaw = [number, number, string] // resolved color

function makeEyes(
  baseY: number,
  pupilDy: number,
  eyeWhite: string,
  pupil: string,
): { left: PixelRaw[]; right: PixelRaw[] } {
  const left: PixelRaw[] = [
    [5, baseY, eyeWhite],
    [6, baseY, eyeWhite],
    [5, baseY + 1, eyeWhite],
    [6, baseY + 1, eyeWhite],
    [5 + (pupilDy === 0 ? 1 : 0), baseY + pupilDy, pupil],
  ]
  const right: PixelRaw[] = [
    [9, baseY, eyeWhite],
    [10, baseY, eyeWhite],
    [9, baseY + 1, eyeWhite],
    [10, baseY + 1, eyeWhite],
    [9 + (pupilDy === 0 ? 1 : 0), baseY + pupilDy, pupil],
  ]
  return { left, right }
}

function makeClosedEyes(
  baseY: number,
  outline: string,
): { left: PixelRaw[]; right: PixelRaw[] } {
  return {
    left: [
      [5, baseY + 1, outline],
      [6, baseY + 1, outline],
    ],
    right: [
      [9, baseY + 1, outline],
      [10, baseY + 1, outline],
    ],
  }
}

interface Expression {
  leftEye: PixelRaw[]
  rightEye: PixelRaw[]
  mouth: PixelRaw[]
  cheeks: PixelRaw[]
  accessory: React.ReactNode
}

function getExpression(
  state: PetState | 'sleeping' | 'alert',
  blinking: boolean,
  palette: Record<ColorKey, string>,
): Expression {
  const { outline, eyeWhite, pupil, cheek, gold, sleep } = palette
  const CHEEKS_R: PixelRaw[] = [
    [4, 9, cheek],
    [11, 9, cheek],
  ]

  if (blinking && (state === 'idle' || state === 'talking' || state === 'thinking')) {
    const closed = makeClosedEyes(7, outline)
    return {
      leftEye: closed.left,
      rightEye: closed.right,
      mouth: [
        [7, 10, outline],
        [8, 10, outline],
      ],
      cheeks: CHEEKS_R,
      accessory: null,
    }
  }

  switch (state) {
    case 'thinking': {
      // Pupils pushed to top of the eye — looking up at the thought cloud.
      const up: PixelRaw[] = [
        [5, 7, eyeWhite], [6, 7, eyeWhite], [5, 8, eyeWhite], [6, 8, eyeWhite],
        [6, 7, pupil],
      ]
      const upR: PixelRaw[] = [
        [9, 7, eyeWhite], [10, 7, eyeWhite], [9, 8, eyeWhite], [10, 8, eyeWhite],
        [10, 7, pupil],
      ]
      // Thought cloud (puffy white blob, outline, with dots inside) top-right.
      const cloud: Array<[number, number, string]> = [
        [13, 0, outline], [14, 0, outline],
        [12, 1, outline], [13, 1, eyeWhite], [14, 1, eyeWhite], [15, 1, outline],
        [11, 2, outline], [12, 2, eyeWhite], [13, 2, eyeWhite], [14, 2, eyeWhite], [15, 2, outline],
        [11, 3, outline], [12, 3, pupil], [13, 3, pupil], [14, 3, pupil], [15, 3, outline],
        [12, 4, outline], [13, 4, outline], [14, 4, outline],
        // trailing tail bubble linking cloud to head
        [11, 5, outline],
      ]
      return {
        leftEye: up,
        rightEye: upR,
        mouth: [
          [7, 10, outline],
          [8, 10, outline],
        ],
        cheeks: CHEEKS_R,
        accessory: (
          <g className="pet-thought">
            {cloud.map(([x, y, color], i) => (
              <rect
                key={`cloud-${i}`}
                x={x * CELL}
                y={y * CELL}
                width={CELL}
                height={CELL}
                fill={color}
              />
            ))}
          </g>
        ),
      }
    }
    case 'talking': {
      const eyes = makeEyes(7, 1, eyeWhite, pupil)
      return {
        leftEye: eyes.left,
        rightEye: eyes.right,
        mouth: [
          [7, 10, outline],
          [8, 10, outline],
          [7, 11, outline],
          [8, 11, outline],
        ],
        cheeks: CHEEKS_R,
        accessory: null,
      }
    }
    case 'alert': {
      const left: PixelRaw[] = [
        [4, 6, outline],
        [5, 6, eyeWhite],
        [6, 6, outline],
        [4, 7, eyeWhite],
        [5, 7, pupil],
        [6, 7, eyeWhite],
        [4, 8, outline],
        [5, 8, eyeWhite],
        [6, 8, outline],
      ]
      const right: PixelRaw[] = [
        [9, 6, outline],
        [10, 6, eyeWhite],
        [11, 6, outline],
        [9, 7, eyeWhite],
        [10, 7, pupil],
        [11, 7, eyeWhite],
        [9, 8, outline],
        [10, 8, eyeWhite],
        [11, 8, outline],
      ]
      return {
        leftEye: left,
        rightEye: right,
        mouth: [
          [7, 10, outline],
          [8, 10, outline],
        ],
        cheeks: [],
        accessory: (
          <g className="pet-alert-mark">
            <rect x={14 * CELL} y={0 * CELL} width={CELL} height={CELL} fill={gold} />
            <rect x={14 * CELL} y={1 * CELL} width={CELL} height={CELL} fill={gold} />
            <rect x={14 * CELL} y={2 * CELL} width={CELL} height={CELL} fill={gold} />
            <rect x={14 * CELL} y={4 * CELL} width={CELL} height={CELL} fill={gold} />
          </g>
        ),
      }
    }
    case 'sleeping': {
      const closed = makeClosedEyes(7, outline)
      return {
        leftEye: closed.left,
        rightEye: closed.right,
        mouth: [[8, 10, outline]],
        cheeks: CHEEKS_R,
        accessory: (
          <g className="pet-zzz">
            <text
              x={12.5 * CELL}
              y={3 * CELL}
              fontFamily="'SF Mono', Menlo, monospace"
              fontSize={CELL * 1.4}
              fontWeight="700"
              fill={sleep}
            >
              z
            </text>
            <text
              x={14 * CELL}
              y={1.6 * CELL}
              fontFamily="'SF Mono', Menlo, monospace"
              fontSize={CELL * 1.1}
              fontWeight="700"
              fill={sleep}
            >
              z
            </text>
          </g>
        ),
      }
    }
    case 'idle':
    default: {
      const eyes = makeEyes(7, 1, eyeWhite, pupil)
      return {
        leftEye: eyes.left,
        rightEye: eyes.right,
        mouth: [
          [7, 10, outline],
          [8, 10, outline],
        ],
        cheeks: CHEEKS_R,
        accessory: null,
      }
    }
  }
}

// ============ rendering helpers ============

function renderBodyPixels(
  pixels: Pixel[],
  palette: Record<ColorKey, string>,
  keyPrefix: string,
) {
  return pixels.map(([x, y, colorKey], i) => (
    <rect
      key={`${keyPrefix}-${i}`}
      x={x * CELL}
      y={y * CELL}
      width={CELL}
      height={CELL}
      fill={palette[colorKey]}
      className="pet-body-pixel"
    />
  ))
}

function renderLeafPixels(pixels: Pixel[], keyPrefix: string) {
  return pixels.map(([x, y, colorKey], i) => (
    <rect
      key={`${keyPrefix}-${i}`}
      x={x * CELL}
      y={y * CELL}
      width={CELL}
      height={CELL}
      fill={FIXED_COLORS[colorKey]}
    />
  ))
}

function renderExpressionPixels(pixels: PixelRaw[], keyPrefix: string) {
  return pixels.map(([x, y, color], i) => (
    <rect
      key={`${keyPrefix}-${i}`}
      x={x * CELL}
      y={y * CELL}
      width={CELL}
      height={CELL}
      fill={color}
    />
  ))
}

// ============ main component ============

export function Pet({ state, grown, onClick, characterId }: PetProps) {
  const [blinking, setBlinking] = useState(false)
  const [idleTicks, setIdleTicks] = useState(0)
  const [growPhase, setGrowPhase] = useState<'none' | 'leaving' | 'hidden' | 'arriving' | 'arrived'>('none')
  const [prevGrown, setPrevGrown] = useState(grown)
  const [showGrown, setShowGrown] = useState(grown)
  const mountTimeRef = useRef(Date.now())

  // Growth animation: leave → hide → arrive blue
  useEffect(() => {
    if (grown !== prevGrown) {
      setPrevGrown(grown)
      // Skip the fancy transition if grown arrives within 1.5s of mount —
      // that's just the async IPC round-trip telling us her real state,
      // not a real grow-up moment.
      const isMountSync = Date.now() - mountTimeRef.current < 1500
      if (grown && isMountSync) {
        setShowGrown(true)
        setGrowPhase('none')
        return undefined
      }
      if (grown) {
        // Phase 1: walk off right (still green)
        setGrowPhase('leaving')
        setShowGrown(false)

        const t1 = window.setTimeout(() => {
          // Phase 2: completely hidden — removed from DOM
          setGrowPhase('hidden')
        }, 800)

        const t2 = window.setTimeout(() => {
          // Phase 3: switch to blue, re-add to DOM with walk-on animation
          setShowGrown(true)
          setGrowPhase('arriving')
        }, 1200)

        const t3 = window.setTimeout(() => {
          // Phase 4: arrival glow
          setGrowPhase('arrived')
        }, 2200)

        const t4 = window.setTimeout(() => {
          setGrowPhase('none')
        }, 3400)

        return () => {
          window.clearTimeout(t1)
          window.clearTimeout(t2)
          window.clearTimeout(t3)
          window.clearTimeout(t4)
        }
      } else {
        setShowGrown(false)
        setGrowPhase('none')
      }
    }
    return undefined
  }, [grown, prevGrown])

  // Occasional blink while idle/talking/thinking
  useEffect(() => {
    if (state !== 'idle' && state !== 'talking' && state !== 'thinking') return
    const id = window.setInterval(() => {
      setBlinking(true)
      window.setTimeout(() => setBlinking(false), 140)
    }, 3200 + Math.random() * 2800)
    return () => window.clearInterval(id)
  }, [state])

  // Auto-sleep after 90s idle
  useEffect(() => {
    if (state !== 'idle') {
      setIdleTicks(0)
      return
    }
    const id = window.setInterval(() => {
      setIdleTicks((t) => t + 1)
    }, 1000)
    return () => window.clearInterval(id)
  }, [state])

  const displayState: PetState | 'sleeping' =
    state === 'idle' && idleTicks > 90 ? 'sleeping' : state

  const palette = useMemo(() => paletteFor(characterId, showGrown), [characterId, showGrown])
  const character = useMemo(() => getCharacter(characterId), [characterId])

  const expr = useMemo(
    () => getExpression(displayState as PetState | 'sleeping' | 'alert', blinking, palette),
    [displayState, blinking, palette],
  )

  const size = GRID * CELL
  const vbHeight = size + CELL

  // During 'hidden' phase, don't render at all — forces a clean DOM remount
  // when 'arriving' starts, guaranteeing no stale animation state.
  if (growPhase === 'hidden') {
    return <div style={{ width: size, height: vbHeight }} />
  }

  return (
    <div
      className={`pet-wrap pet-wrap--${displayState} ${showGrown ? 'pet-wrap--grown' : 'pet-wrap--seedling'}${growPhase === 'leaving' || growPhase === 'arriving' || growPhase === 'arrived' ? ` pet-wrap--${growPhase}` : ''}${character.wrapClass ? ` ${character.wrapClass}` : ''}`}
      onClick={onClick}
      style={{ width: size, height: vbHeight }}
    >
      <svg
        width={size}
        height={vbHeight}
        viewBox={`0 0 ${size} ${vbHeight}`}
        shapeRendering="crispEdges"
        style={{ imageRendering: 'pixelated', overflow: 'visible' }}
      >
        <g className="pet-svg-body">
          {/* Leaf & stem — only when not yet grown */}
          {!showGrown && (
            <g className="pet-leaf">{renderLeafPixels(LEAF_PIXELS, 'leaf')}</g>
          )}
          {renderBodyPixels(BODY, palette, 'body')}
          {renderExpressionPixels(expr.cheeks, 'cheek')}
          {renderExpressionPixels(expr.leftEye, 'leye')}
          {renderExpressionPixels(expr.rightEye, 'reye')}
          {renderExpressionPixels(expr.mouth, 'mouth')}
        </g>
        {expr.accessory}
        <Shadow />
      </svg>
    </div>
  )
}
