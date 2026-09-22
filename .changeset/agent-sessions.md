---
'jev-planner': minor
---

Each agent now keeps one conversation through a run. Codex and Claude Code continue their draft session for the cross-review and the final synthesis (`codex exec resume`, still in the read-only sandbox; `claude --resume`), so those stages no longer start cold and explore the repository again; chat API agents are sent their earlier messages, so the repository snapshot goes once. The later prompts leave out what the conversation already holds. This changes the default: the sessions are kept in `~/.codex/sessions` and `~/.claude/projects` like any other, and Claude's appear in `/resume`. `--no-resume` (`resume: false` in `PlanOptions`) restores the old behaviour. A session that cannot be continued falls back to a fresh call. New in the API: `AgentSession`, `AgentRequest.session` and `resumePrompt`, and `CliProviderConfig.sessions`.
