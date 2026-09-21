---
'jev-planner': minor
---

Add `--rounds-dir <path>`, which writes every round's plans as the run goes — `round1/` for the drafts, `round2/` and up for each cross-review with Jev's verdict, and `final/plan.md` for the merged plan — and the `onRound` option on `Planner.plan` it is built on, with the new `PlanRound` type.
