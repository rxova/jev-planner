---
'jev-planner': minor
---

`--verbose` streams each agent's work as it happens, one `[agent]` line per message, command or file read. Codex and Claude now run with JSON event output; `cliProvider` takes `events` to read such a CLI, and `PlanOptions.onAgentProgress` / `AgentRequest.onProgress` carry the lines from code.
