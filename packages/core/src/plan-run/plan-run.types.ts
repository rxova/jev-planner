import type { PlanMode, ReviewMode } from '../orchestrator/orchestrator.types.js'

/** What `Planner.plan` settled from its options before the run starts. */
export interface RunSettings {
  mode: PlanMode
  reviewMode: ReviewMode
  /** How long a round waits for a straggler once half the agents have answered; 0 waits for all. */
  graceMs: number
}
