---
'jev-planner': minor
---

Time every run. `--verbose` prints how long each round and each agent and Jev call took, and the
total; `--rounds-dir` writes a `timings.json` in each round's folder; `--json` includes `timings`.
From code, `PlanRound.timings` and `PlanResult.timings` carry the same numbers, typed as the new
`RoundTimings` and `RunTimings`.
