---
'jev-planner': minor
---

Reject an empty or placeholder task before any paid call, with `--allow-any-task` (`allowAnyTask` in `PlanOptions`) to plan it anyway; `Planner.plan` throws the new `TaskValidationError`. The planning prompts now ask for clarifying questions when a task is too vague to act on.
