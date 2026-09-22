import type { DebateOutcome } from '../debate-review/debate-review.types.js'
import type { PlanningAgent } from '../provider/provider.types.js'
import type { Verdict } from '../questions/questions.types.js'
import type { Accepted, Draft } from '../round/round.types.js'

/** Where the rounds left the run: the plans, the last verdict, and what decided them. */
export interface Reviewed {
  drafts: Draft[]
  verdict: Verdict
  /** The draft `fast` mode accepted alone, if any. */
  accepted?: Accepted
  /** The debate, if one ran. */
  debated?: DebateOutcome
  /** The agent named to merge, whatever the judge picked. */
  finalizerOverride?: PlanningAgent
}
