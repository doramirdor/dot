/**
 * macOS Keychain helpers for secret storage.
 *
 * Dot uses the `security` CLI (ships with every Mac, no dependencies) to
 * store and retrieve credentials instead of reading them from plaintext
 * ~/.nina/config.json or ~/.openclaw/.... All reads/writes happen in-process
 * under the user's login keychain — nothing ever touches disk in plaintext
 * through this module.
 *
 * Service naming convention: all items live under the service "dot" with a
 * per-secret account name. The `-a` (account) and `-s` (service) flags are
 * used consistently so items can be enumerated and rotated from Keychain Access.
 *
 * This is best-effort. If `security` isn't available (non-macOS, stripped
 * environment) or the keychain call fails, the helpers return null/false and
 * callers fall back to their legacy plaintext paths.
 */
import { execFileSync } from 'node:child_process'

const SERVICE = 'dot'

/**
 * Known well-lit accounts. String type kept open so new providers (M3)
 * and plugins (M4) can register their own secret names without modifying
 * this file — the union is a hint, not a constraint.
 */
export type SecretAccount =
  | 'anthropic-token'
  | 'telegram-bot-token'
  | 'groq-api-key'
  | 'openai-api-key'
  | (string & {})

/**
 * Read a secret from the login keychain. Returns null if missing or if the
 * security CLI is not available. Never throws.
 */
export function getSecret(account: SecretAccount): string | null {
  try {
    const out = execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-w', '-s', SERVICE, '-a', account],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' },
    )
    const trimmed = out.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

/**
 * Store (or overwrite) a secret in the login keychain. Returns true on
 * success. Best-effort — never throws.
 */
export function setSecret(account: SecretAccount, value: string): boolean {
  try {
    execFileSync(
      '/usr/bin/security',
      [
        'add-generic-password',
        '-U', // update if exists
        '-s',
        SERVICE,
        '-a',
        account,
        '-w',
        value,
        // -T '' prevents any other binary from reading this item without
        // user consent via a Keychain prompt. Tightest default.
        '-T',
        '',
      ],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    )
    return true
  } catch {
    return false
  }
}

/**
 * Delete a secret. Returns true if it existed and was removed.
 */
export function deleteSecret(account: SecretAccount): boolean {
  try {
    execFileSync(
      '/usr/bin/security',
      ['delete-generic-password', '-s', SERVICE, '-a', account],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    )
    return true
  } catch {
    return false
  }
}

/**
 * Does the security CLI exist and respond? Used by startup to decide whether
 * Keychain is even available on this machine.
 */
export function keychainAvailable(): boolean {
  try {
    execFileSync('/usr/bin/security', ['-h'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}
