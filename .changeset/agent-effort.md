---
'jev-planner': minor
---

Add `--effort <id>=<level>` to override an agent CLI's reasoning effort for the run, over its local configuration: Codex gets `-c model_reasoning_effort=…`, Claude Code `--effort`. `cliProvider`'s `args` now receives `{ model, effort }`, and a `Provider` says whether it takes an effort.
