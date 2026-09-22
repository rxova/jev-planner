---
'jev-planner': patch
---

Correct the README, `llms.txt`, the `PlanMode` TSDoc and `--help` where they overstated a mode: `ultra` runs its second cross-review only when Jev asks and skips the merge with `--finalizer none`, and `balanced` skips a review by Jev's 0.65 score, not when the drafts "agree". The README's development commands now use pnpm, the Node requirement reads 20.19, and the `--verbose` example shows a real run's timings.
