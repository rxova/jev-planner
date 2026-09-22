---
'jev-planner': minor
---

Run one provider as two or more agents. `--agents` takes `<provider>[:<name>]`, so `--agents codex:sol,codex:terra` runs Codex twice, each agent with its own session, draft and round files, labelled `Codex (sol)` and `Codex (terra)`. `--model`, `--effort`, `--review-effort` and `--finalizer` take the agent's name; a bare provider id is still its own name, so existing commands and configs are unchanged. In `jev-planner.json`, a key that is not a provider id names an agent and sets `provider`. Two agents with the same provider, model and effort get a warning, and `doctor` checks each provider once. New in the API: `AgentSetup.name` and `label`.
