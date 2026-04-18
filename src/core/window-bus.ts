/**
 * Small bridge that lets core modules (MCP tools) ask the main process to
 * hide or show Dot's window. Core has no BrowserWindow reference, and we
 * don't want to import electron into core/, so main registers callbacks
 * here at startup and tools call into them.
 */

type VoidFn = () => void
type StringFn = (s: string) => void

let hideFn: VoidFn | null = null
let showFn: VoidFn | null = null
let setCharacterFn: StringFn | null = null
let currentCharacterId: string = 'dot'

export function registerWindowHandlers(handlers: {
  hide: VoidFn
  show: VoidFn
  setCharacter?: StringFn
}) {
  hideFn = handlers.hide
  showFn = handlers.show
  if (handlers.setCharacter) setCharacterFn = handlers.setCharacter
}

export function setCharacter(id: string): boolean {
  if (!setCharacterFn) return false
  try {
    setCharacterFn(id)
    currentCharacterId = id
    return true
  } catch {
    return false
  }
}

export function getCharacterId(): string {
  return currentCharacterId
}

export function hideDot(): boolean {
  if (!hideFn) return false
  try {
    hideFn()
    return true
  } catch {
    return false
  }
}

export function showDot(): boolean {
  if (!showFn) return false
  try {
    showFn()
    return true
  } catch {
    return false
  }
}
