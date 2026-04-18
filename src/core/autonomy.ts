/**
 * Autonomy system — Nina acts on her own by default.
 *
 * Instead of per-action confirmation, the user defines a "don't do" list:
 * specific actions Nina must NEVER take. Everything else is auto-approved.
 *
 * Examples of "don't do" rules:
 *   - "never send email without asking"
 *   - "never delete files outside ~/.dot/"
 *   - "never quit apps"
 *   - "never touch the nadir repo"
 *   - "never run rm -rf"
 *
 * Rules are stored as natural-language strings. The trust layer sends the
 * tool name + input to a fast LLM check against the rules when the action
 * is in a sensitive category.
 *
 * For truly dangerous actions (ssh keys, credentials, sudo), the hard-deny
 * list in trust.ts still applies regardless of autonomy mode.
 */
import fs from 'node:fs'
import path from 'node:path'
import { DOT_DIR } from './memory.js'

const RULES_FILE = path.join(DOT_DIR, 'dont-do.json')

export interface DontDoRule {
  id: string
  rule: string
  createdAt: string
  /** Optional: which tool categories this applies to */
  category?: string
}

let cachedRules: DontDoRule[] | null = null

export function loadRules(): DontDoRule[] {
  if (cachedRules) return cachedRules
  try {
    if (!fs.existsSync(RULES_FILE)) return []
    cachedRules = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'))
    return cachedRules!
  } catch {
    return []
  }
}

export function saveRules(rules: DontDoRule[]): void {
  try {
    const dir = path.dirname(RULES_FILE)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2), 'utf8')
    cachedRules = rules
  } catch (err) {
    console.warn('[nina] Failed to save dont-do rules:', err)
  }
}

export function addRule(rule: string, category?: string): DontDoRule {
  const rules = loadRules()
  const entry: DontDoRule = {
    id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    rule: rule.trim(),
    createdAt: new Date().toISOString(),
    category,
  }
  rules.push(entry)
  saveRules(rules)
  return entry
}

export function removeRule(id: string): boolean {
  const rules = loadRules()
  const idx = rules.findIndex((r) => r.id === id)
  if (idx === -1) return false
  rules.splice(idx, 1)
  saveRules(rules)
  return true
}

export function listRules(): DontDoRule[] {
  return loadRules()
}

/**
 * Check if a tool call violates any "don't do" rule.
 *
 * This is a FAST string-match check (no LLM call). Rules are matched
 * against a description string built from the tool name + key input values.
 * Substring match, case-insensitive.
 *
 * For more nuanced matching, a future version could use a small local model.
 */
export function checkRules(
  toolName: string,
  input: Record<string, unknown>,
): { blocked: boolean; matchedRule?: DontDoRule } {
  const rules = loadRules()
  if (rules.length === 0) return { blocked: false }

  // Build a description string from the tool call
  const parts: string[] = [toolName.replace(/^mcp__nina__/, '')]

  // Add key input values
  for (const [key, val] of Object.entries(input)) {
    if (val !== undefined && val !== null && val !== '' && typeof val !== 'object') {
      parts.push(`${key}=${String(val)}`)
    }
  }
  const desc = parts.join(' ').toLowerCase()

  // Check each rule — simple substring matching
  for (const rule of rules) {
    const ruleWords = rule.rule.toLowerCase().split(/\s+/).filter(Boolean)

    // A rule matches if ALL its significant words appear in the description
    // Skip common words
    const skipWords = new Set([
      'never', 'dont', "don't", 'do', 'not', 'please', 'without', 'asking',
      'me', 'my', 'the', 'a', 'an', 'to', 'in', 'on', 'at', 'for', 'with',
    ])
    const significantWords = ruleWords.filter((w) => !skipWords.has(w) && w.length > 2)

    if (significantWords.length === 0) continue

    const allMatch = significantWords.every((word) => desc.includes(word))
    if (allMatch) {
      return { blocked: true, matchedRule: rule }
    }
  }

  return { blocked: false }
}

export function formatRules(rules: DontDoRule[]): string {
  if (rules.length === 0) return "(no 'don't do' rules set — nina has full autonomy)"
  return rules
    .map((r, i) => `${i + 1}. ${r.rule} (id: ${r.id})`)
    .join('\n')
}
