import type { Dispute, RoundDebate } from '../debate/debate.types.js'
import type { Verdict } from '../questions/questions.types.js'
import type { Draft } from '../round/round.types.js'

/** What a debate settled, kept for the passes and the merge after it. */
export interface DebateOutcome {
  drafts: Draft[]
  verdict: Verdict
  record: RoundDebate
  disputes: Dispute[]
  overflow: Dispute[]
}
