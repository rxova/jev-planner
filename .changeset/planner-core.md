---
'@rxova/planner-core': minor
'jev-planner': minor
---

Move the planner, its providers and its CLI into a new package, `@rxova/planner-core`, which jev-planner depends on. The CLI is parametrized by a `PlannerProgram`, so any judge can have a program of its own: `main(argv, processDeps(program, judge))`. jev-planner now exports only `TypeSafeJevJudge`; import `Planner`, `PROVIDERS` and the types from `@rxova/planner-core`. The judge is named neutrally throughout: `JevJudge` is `PlanJudge` (which gains `name`), `JevVerdict` is `Verdict`, `jevModel`/`--jev-model` are `judgeModel`/`--judge-model`, `jevCalls` and `jevMs` are `judgeCalls` and `judgeMs`, and a round's `jev-verdict.json` is `verdict.json`.
