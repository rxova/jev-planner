---
'jev-planner': minor
---

Add `--review-effort <id>=<level>` to give an agent CLI another reasoning effort for its cross-reviews and synthesis, while its draft keeps `--effort`. `AgentRequest.effort` carries a per-call effort, and `PlanOptions.reviewEfforts` sets it from code.
