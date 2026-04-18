/**
 * renderer/characters.ts — Dot's character cast.
 *
 * Dot isn't one sprite — she has moods/forms. Each Character is a palette
 * variation + an optional mood animation class. The default character
 * ('dot') reproduces the original seedling/adult look. The others are
 * mood forms Dot can swap to based on context or RL policy.
 *
 * Selection today is explicit: the main process sends `pet:character`
 * over IPC and the renderer swaps. Selection tomorrow (M1 integration):
 * the RL policy includes a `character_form` column, and Dot's reply
 * handler picks the form that scored best in the current bucket.
 *
 * Community characters: drop a file at ~/.dot/characters/<id>/char.json
 * with the same shape. Main process scans that dir on startup and sends
 * the extra entries over IPC. (Loader lives in main/index.ts wiring —
 * this file is the registry shape only.)
 */

export type ColorKey =
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

export type Palette = Record<ColorKey, string>

export interface CharacterDef {
  /** Stable id used by IPC and MCP tools. */
  id: string
  /** Human-facing name shown in the character picker. */
  name: string
  /** One-line description — why/when to use this form. */
  tagline: string
  /** Seedling palette (pre-onboarding). */
  seedling: Palette
  /** Adult palette (post-onboarding). */
  adult: Palette
  /** Optional CSS class added to .pet-wrap while this character is active.
   *  Use for persistent visual effects (a glow, a slight tint, a custom
   *  idle wiggle). Short list in styles.css: pet-char-default,
   *  pet-char-sleepy, pet-char-focused, pet-char-excited, pet-char-concerned,
   *  pet-char-playful, pet-char-rainbow. */
  wrapClass?: string
  /** Optional mood hint surfaced to the agent via the character MCP tool.
   *  Lets the agent decide which form fits the moment. */
  mood?: 'default' | 'sleepy' | 'focused' | 'excited' | 'concerned' | 'playful' | 'rainbow'
}

/** Fixed non-body colors — shared across characters. */
const SHARED: Omit<Palette, 'bodyLight' | 'body' | 'bodyShade' | 'accent'> = {
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
}

function mk(body: { light: string; base: string; shade: string; accent?: string }): Palette {
  return {
    ...SHARED,
    bodyLight: body.light,
    body: body.base,
    bodyShade: body.shade,
    accent: body.accent ?? body.base,
  }
}

export const DEFAULT_CHARACTER_ID = 'dot'

export const CHARACTERS: Record<string, CharacterDef> = {
  // ---- Canonical Dot: green seedling → blue adult. Matches original art. ----
  dot: {
    id: 'dot',
    name: 'Dot',
    tagline: 'default form — the one you onboarded with.',
    mood: 'default',
    seedling: mk({ light: '#b5e4a8', base: '#8dd080', shade: '#5fa05a' }),
    adult: mk({ light: '#c5ecf7', base: '#9fe0f5', shade: '#6cc0e8' }),
    wrapClass: 'pet-char-default',
  },

  // ---- Sleepy: muted lavender; slower breathing. ----
  'dot-sleepy': {
    id: 'dot-sleepy',
    name: 'Sleepy Dot',
    tagline: 'late at night / post-lunch dip / user idle a long time.',
    mood: 'sleepy',
    seedling: mk({ light: '#d8d0e8', base: '#b5a8d0', shade: '#7a6eaa' }),
    adult: mk({ light: '#cfc8e6', base: '#a79dd3', shade: '#6e649f' }),
    wrapClass: 'pet-char-sleepy',
  },

  // ---- Focused: slate/teal; tight breathing, subtle cyan glow. ----
  'dot-focused': {
    id: 'dot-focused',
    name: 'Focused Dot',
    tagline: 'deep-work mode — user is coding, writing, or on a call.',
    mood: 'focused',
    seedling: mk({ light: '#a8d8d8', base: '#6eb5b5', shade: '#3e8a8a', accent: '#2fa7b8' }),
    adult: mk({ light: '#b0e6e6', base: '#74c5c5', shade: '#3e9a9a', accent: '#2fa7b8' }),
    wrapClass: 'pet-char-focused',
  },

  // ---- Excited: sunrise orange/coral; quick bounce. ----
  'dot-excited': {
    id: 'dot-excited',
    name: 'Excited Dot',
    tagline: 'task just completed / good news / user sent a win.',
    mood: 'excited',
    seedling: mk({ light: '#ffd8a8', base: '#ff9a5a', shade: '#cc6a2e', accent: '#ffb563' }),
    adult: mk({ light: '#ffe0b8', base: '#ffae6a', shade: '#cc7236', accent: '#ffc066' }),
    wrapClass: 'pet-char-excited',
  },

  // ---- Concerned: ember red; slow, heavy breathing. ----
  'dot-concerned': {
    id: 'dot-concerned',
    name: 'Concerned Dot',
    tagline: 'error / budget alarm / something worth flagging.',
    mood: 'concerned',
    seedling: mk({ light: '#ffc8c0', base: '#e86a5c', shade: '#a83a2e' }),
    adult: mk({ light: '#ffb8b0', base: '#d95c50', shade: '#9a2e24' }),
    wrapClass: 'pet-char-concerned',
  },

  // ---- Playful: bubblegum pink; bouncy idle. ----
  'dot-playful': {
    id: 'dot-playful',
    name: 'Playful Dot',
    tagline: 'casual chat / banter / non-work hours.',
    mood: 'playful',
    seedling: mk({ light: '#ffd6eb', base: '#ff9ecb', shade: '#cc5ea0' }),
    adult: mk({ light: '#ffc8e6', base: '#ff8ec2', shade: '#c4548c' }),
    wrapClass: 'pet-char-playful',
  },

  // ---- Rainbow: special / holiday / once-a-year. ----
  'dot-rainbow': {
    id: 'dot-rainbow',
    name: 'Rainbow Dot',
    tagline: 'rare form — reserved for milestones. Auto-fades after a minute.',
    mood: 'rainbow',
    seedling: mk({ light: '#ffe6a8', base: '#c8a8ff', shade: '#7a5ec8', accent: '#ff9ad8' }),
    adult: mk({ light: '#ffe6c0', base: '#b892ff', shade: '#6a4eb8', accent: '#ff9ad8' }),
    wrapClass: 'pet-char-rainbow',
  },
}

export function getCharacter(id: string | undefined): CharacterDef {
  if (!id) return CHARACTERS[DEFAULT_CHARACTER_ID]
  return CHARACTERS[id] ?? CHARACTERS[DEFAULT_CHARACTER_ID]
}

export function listCharacters(): CharacterDef[] {
  return Object.values(CHARACTERS)
}

export function paletteOf(id: string | undefined, grown: boolean): Palette {
  const c = getCharacter(id)
  return grown ? c.adult : c.seedling
}
