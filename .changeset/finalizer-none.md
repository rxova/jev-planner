---
'jev-planner': minor
---

Add `--finalizer none` to skip the synthesis call when Jev rates one revised plan stronger, and return that plan as it is; on a tie the finalizer still merges. From code, `PlanOptions.selectStronger`; `PlanResult.selected` and `PlanRound.selected` mark a selected plan, and `final/plan.md` is headed `<!-- selected from <agent> -->`.
