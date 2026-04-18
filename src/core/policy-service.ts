/**
 * core/policy-service.ts — unified tool-call authorization.
 *
 * Before this module existed, trust.ts + permission-bus.ts + safe-ops.ts
 * + bg-queue's budget gate were four separate policy surfaces. Callers
 * had to remember to invoke each one in the right order and merge the
 * results, which is why the trust layer accidentally became a rubber
 * stamp (every "confirm" returned "auto") and the budget gate only
 * applied to bg-queue (not to foreground tools that happened to be
 * expensive).
 *
 * PolicyService gives every tool-call site one entry point:
 *
 *   const decision = await authorize(toolName, input, ctx)
 *   if (decision.behavior === 'allow') { ...dispatch... }
 *   else { ...surface reason... }
 *
 * The decision wraps:
 *   1. classifyToolCall() — tier + reason from trust.ts
 *   2. channel-aware auto-deny — e.g. background jobs that would
 *      otherwise prompt the user on confirm-tier tools fail closed
 *      instead of hanging forever
 *   3. permission-bus prompt — when a UI is attached
 *   4. writeAudit — always, for every decision
 *
 * This is a thin facade. classifyToolCall stays the source of truth for
 * the classification table; this module just wires everything together
 * so nobody can accidentally skip a step.
 */
import { classifyToolCall, writeAudit, type Tier } from './trust.js'
import {
  createPermissionRequest,
  type PermissionRequestPayload,
} from './permission-bus.js'
import type { ChannelContext } from './agent.js'

export interface AuthorizeContext {
  /** Where this turn came from — desktop, telegram, cron, mission, etc. */
  channelContext?: ChannelContext
  /** UI callback for tier='confirm' prompts. Optional. */
  onPermissionRequest?: (payload: PermissionRequestPayload) => void
}

export type AuthorizeDecision =
  | { behavior: 'allow'; tier: Tier; reason?: string }
  | { behavior: 'deny'; tier: Tier; reason: string }

const BACKGROUND_CHANNELS = new Set(['cron', 'morning', 'diary', 'reflection', 'mission', 'proactive'])

function isBackgroundChannel(ctx?: ChannelContext): boolean {
  if (!ctx) return false
  return BACKGROUND_CHANNELS.has(ctx.channel)
}

/**
 * Authorize a single tool call. Returns an allow/deny decision that
 * can be returned verbatim from the Agent SDK's canUseTool callback
 * (modulo adding the updatedInput field when allowing).
 */
export async function authorize(
  toolName: string,
  input: Record<string, unknown>,
  ctx: AuthorizeContext = {},
): Promise<AuthorizeDecision> {
  const { tier, reason } = classifyToolCall(toolName, input)

  if (tier === 'deny') {
    writeAudit(toolName, input, 'deny')
    return {
      behavior: 'deny',
      tier,
      reason: reason ?? `Tool "${toolName}" is blocked by Dot's trust policy.`,
    }
  }

  if (tier === 'auto') {
    writeAudit(toolName, input, 'auto')
    return { behavior: 'allow', tier, reason }
  }

  // tier === 'confirm'

  // Background channels can't prompt a human — fail closed.
  // This is the big fix: previously, a cron task that hit a confirm-tier
  // tool would hang indefinitely waiting for a UI that wasn't there.
  if (isBackgroundChannel(ctx.channelContext)) {
    writeAudit(toolName, input, 'deny')
    return {
      behavior: 'deny',
      tier,
      reason:
        reason +
        ` (declined: confirm-tier tools are not allowed in background channel "${ctx.channelContext?.channel}")`,
    }
  }

  // No UI attached — also fail closed.
  if (!ctx.onPermissionRequest) {
    writeAudit(toolName, input, 'deny')
    return {
      behavior: 'deny',
      tier,
      reason: 'No confirmation UI available.',
    }
  }

  const approved = await createPermissionRequest(
    toolName,
    reason ?? toolName,
    input,
    ctx.onPermissionRequest,
  )
  writeAudit(toolName, input, approved ? 'user-approved' : 'user-denied')
  if (approved) {
    return { behavior: 'allow', tier, reason }
  }
  return {
    behavior: 'deny',
    tier,
    reason: 'The user declined this action.',
  }
}
