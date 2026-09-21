---
'jev-planner': minor
---

Plan with any two or more AIs, not only Codex and Claude. `--agents` picks them from a registry that adds DeepSeek, Kimi (Moonshot) and GLM (Z.ai) through a generic OpenAI-compatible adapter, which sends chat APIs a snapshot of the tracked files and top-level docs. `--model <id>=<model>` replaces `--codex-model` and `--claude-model`, and `--finalizer` takes any selected agent. Every provider's API key is stripped from every agent subprocess. Breaking for the library: `CodexAgent` and `ClaudeAgent` are replaced by `PROVIDERS`, `cliProvider` and `openAICompatibleProvider`; `Planner` takes an array of agents; `AgentName` is a string; `PlanningAgent` gains `label`; `JevJudge.judge` takes `plans`; `runDoctor` takes the providers to check.
