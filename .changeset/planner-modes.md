---
'jev-planner': minor
---

Let Jev skip the rounds a plan does not need, and add `--mode` to choose how many it may spend.

A run's wall clock is the number of rounds, not the number of agent calls: the agents in a round run
in parallel, and each round waits for the one before it. Both the cross-review and the final merge
used to run unconditionally, so every plan cost three rounds and 2N + 1 agent calls.

The new default, `--mode balanced`, puts Jev's typed judgment in front of each round instead of after
it. It judges the drafts first and orders a cross-review only when one would materially improve the
plan; it answers with the strongest cross-reviewed plan when it judges that plan final as it stands,
rather than paying an agent to rewrite it; and a round stops waiting for a straggling agent once
half have answered, aborting its call instead of leaving it running. A plan that has not been
cross-reviewed is never adopted whole: the merge is the only place the agents' material comes
together, so it always runs. With two agents, a plan Jev finds ready costs three agent calls in two
rounds where it used to cost five in three.

`--mode ultra` keeps the previous pipeline: every agent cross-reviews every other, Jev may ask for
one more pass, and the finalizer always merges.

- `--mode <balanced|ultra>` chooses the pipeline; `mode` in `PlanOptions` does the same from code.
- `--straggler-grace <seconds>` sets how long a `balanced` round waits for the agents still working once
  half have answered (default: 90; `0` waits for every agent).
- `--review-rounds` now also takes `0`, to skip the cross-review entirely.
- Every run reports what it spent on stderr, and `PlanResult.cost` (`cost` in `--json`) carries the
  mode, the rounds run, the agent and Jev call counts, whether the plan was merged, and any agent a
  round stopped waiting for.
- `JevVerdict` gains `standsAloneProbability`, and `JevJudge.judge` takes the `stage` of the plans it
  is given. `AgentRequest` gains an optional `signal`, which both built-in provider kinds honor.
