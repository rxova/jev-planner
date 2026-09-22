import type { AgentName } from '../provider/provider.types.js'
import type { Objection } from '../debate/debate.types.js'

/** A plan and the agent that wrote it, as a prompt shows it. */
export interface AuthoredPlan {
  label: string
  plan: string
  /** The agent's name, for a prompt that asks for answers addressed to it: a critique's `TARGET:`. */
  name?: AgentName
}

/** An objection as the author it is aimed at sees it. */
export interface ReceivedObjection extends Objection {
  criticLabel: string
}

/** A disputed claim for a checker, with who made it and who rejected it. */
export interface ClaimToCheck {
  id: string
  claim: string
  criticLabels: readonly string[]
  authorLabel: string
  rejections: readonly string[]
}
