import type { PlanningAgent } from '../provider/provider.types.js'
import type { Verdict } from '../questions/questions.types.js'

/**
 * A call after the draft: a cross-review or the synthesis. It takes the
 * review effort, and a shorter prompt for an agent continuing its session.
 * `undefined` for a draft.
 */
export type Later = { resumePrompt: string | undefined } | undefined

/** One agent's current plan. */
export interface Draft {
  agent: PlanningAgent
  plan: string
}

/** One agent's call in a round, and the plan that stands in if the round drops it. */
export interface RoundCall {
  agent: PlanningAgent
  prompt: string
  later: Later
  /** The plan kept if this agent is dropped; a draft round has none to fall back on. */
  fallback?: string
}

export type Generate = (
  agent: PlanningAgent,
  prompt: string,
  later: Later,
  signal?: AbortSignal,
) => Promise<string>

/** A draft the judge judged final on its own, in `fast` mode, and that verdict. */
export interface Accepted {
  draft: Draft
  verdict: Verdict
}

/** One call a round is waiting on, and what it came to. */
export interface Pending {
  call: RoundCall
  controller: AbortController
  plan?: string
  dropped?: true
}
