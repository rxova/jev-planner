import type { AgentName } from '../provider/provider.types.js'

/** An agent as a critique may name it: by name or by label. */
export interface Peer {
  name: AgentName
  label: string
}

/** One objection a critic raised against another agent's plan, in `debate` review. */
export interface Objection {
  /** `<critic>:<target>:C<n>`, unique in a run: what the author's reply answers. */
  id: string
  critic: AgentName
  /** The agent whose plan the objection is about. */
  target: AgentName
  claim: string
  /** The critic's reason, or `''` when it gave none. */
  why: string
  /** Whether the claim is about a file, symbol or export in the repository, and so can be checked. */
  repo: boolean
}

/** An author's answer to one objection against its plan. */
export interface Reply {
  /** The `Objection.id` it answers. */
  id: string
  author: AgentName
  decision: 'accept' | 'reject'
  reason: string
}

/** What an agent that reads the repository found when it checked a disputed claim. */
export interface ClaimCheck {
  checker: AgentName
  /** `unknown` also stands for an answer that could not be parsed, or a checker that was dropped. */
  result: 'confirm' | 'refute' | 'unknown'
  /** Where the checker looked, such as `src/jev.ts:agentOptions`; `''` when it said nothing. */
  evidence: string
}

/**
 * An objection its author rejected, for the judge to rule on. The same claim from
 * several critics against the same plan is one dispute.
 */
export interface Dispute {
  /** `D1`, `D2`, …, in the order the disputes are ranked. */
  id: string
  /** The author, whose plan the claim is about. */
  target: AgentName
  /** Every critic who raised it, in the order they raised it. */
  critics: AgentName[]
  /** The ids of the objections it merges. */
  objections: string[]
  claim: string
  /** The critics' reasons, those that gave one. */
  reasons: string[]
  /** The author's reasons for rejecting it. */
  rejections: string[]
  repo: boolean
  /** Present once a claim check ran on it. */
  check?: ClaimCheck
}

/** The judge's ruling on one dispute. */
export interface DisputeRuling {
  /** The `Dispute.id` it rules on. */
  id: string
  /** Whose position holds; `unclear` when the material does not settle it. */
  choice: 'critic' | 'author' | 'unclear'
  confidence: number
}

/** The debate behind a round, in `debate` review; see `PlanRound.debate`. */
export interface RoundDebate {
  /** Every objection the critics raised, as parsed. */
  objections: Objection[]
  /** Every reply the authors gave that answers an objection, first reply per objection. */
  replies?: Reply[]
  /** The ids of objections that got no parseable reply, including those to a dropped author. */
  unanswered?: string[]
  /** The rejected objections the judge rules on: at most eight, ranked. */
  disputes?: Dispute[]
  /** Rejected objections past the cap, which the judge did not rule on. */
  overflow?: Dispute[]
  /** Whether claim checks ran, when they were asked for. */
  claimChecks?: 'ran' | 'skipped'
}
