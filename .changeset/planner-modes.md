---
'jev-planner': minor
---

Let Jev skip the rounds a plan does not need, and add `--mode` to choose how many it may spend.

A run's wall clock is the number of rounds, not the number of agent calls: the agents in a round run
in parallel, and each round waits for the one before it. Both the cross-review and the final merge
used to run unconditionally, so every plan cost three rounds and 2N + 1 agent calls.

- `--mode balanced`, the new default, puts Jev's typed judgment in front of each round instead of
  after it. It judges the drafts first and orders a cross-review only when one would materially
  improve the plan; it answers with the strongest cross-reviewed plan when it judges that plan final
  as it stands, rather than paying an agent to rewrite it; and a round stops waiting for a
  straggling agent once half have answered, aborting its call instead of leaving it running. A plan
  that has not been cross-reviewed is never adopted whole there: the merge is the only place the
  agents' material comes together. With two agents, a plan Jev finds ready costs three agent calls
  in two rounds where it used to cost five in three.
- `--mode fast` has Jev judge each draft alone, one at a time in the order they arrive, and answers
  with the first it rates final as it stands, stopping the agents still drafting. When it accepts
  none, the drafts are merged with no cross-review. That is N or N + 1 agent calls in one or two
  rounds, and 1 … N + 1 Jev calls. The accepted plan was read by no other agent, the quickest agent
  is judged first, and an agent stopped mid-draft has still billed what it used. It has no review
  round, so it rejects `--review-mode debate` and `--claim-checks` and ignores `--review-rounds`;
  `--finalizer` only picks who merges.
- `--mode ultra` keeps the previous pipeline: every agent cross-reviews every other, Jev may ask for
  one more pass, and the finalizer always merges.

Also:

- `mode` in `PlanOptions` chooses the pipeline from code. `PlanMode` is `'fast' | 'balanced' |
'ultra'`; an exhaustive `switch` over it needs a `'fast'` case.
- `--straggler-grace <seconds>` sets how long a `balanced` or `fast` round waits for the agents still
  working once half have answered (default: 90; `0` waits for every agent).
- `--review-rounds` now also takes `0`, to skip the cross-review entirely.
- Every run reports what it spent on stderr, and `PlanResult.cost` (`cost` in `--json`) carries the
  mode, the rounds run, the agent and Jev call counts, whether the plan was merged, and any agent a
  round stopped waiting for. A `fast` run that answers with an accepted draft reports `selected`.
- `JevVerdict` gains `standsAloneProbability`, and `JevJudge.judge` takes the `stage` of the plans it
  is given: `'solo'` for one draft judged alone, `'draft'` or `'review'` for the plans judged
  together. A custom judge should handle all three. `AgentRequest` gains an optional `signal`, which
  both built-in provider kinds honor.
