---
'jev-planner': minor
---

Move the planner, its providers and its CLI into an internal package, bundled into jev-planner, which still exports the planner, the providers and the types. The judge is named neutrally throughout: `JevJudge` is `PlanJudge` (which gains `name`), `JevVerdict` is `Verdict`, `jevModel`/`--jev-model` are `judgeModel`/`--judge-model`, `jevCalls` and `jevMs` are `judgeCalls` and `judgeMs`, and a round's `jev-verdict.json` is `verdict.json`.
