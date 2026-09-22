---
title: Agents
description: The AIs jev-planner can use, what each needs, and what each is allowed to see.
sidebar:
  order: 1
---

Pick the agents with `--agents`, two or more, comma-separated. One provider can be two of them,
under different names; see [one provider, several agents](#one-provider-several-agents).

| Id         | AI                                                                            | Kind      | Needs              |
| ---------- | ----------------------------------------------------------------------------- | --------- | ------------------ |
| `codex`    | [Codex CLI](https://learn.chatgpt.com/docs/non-interactive-mode)              | agent CLI | the CLI, logged in |
| `claude`   | [Claude Code](https://docs.anthropic.com/en/docs/claude-code/getting-started) | agent CLI | the CLI, logged in |
| `deepseek` | [DeepSeek](https://api-docs.deepseek.com)                                     | chat API  | `DEEPSEEK_API_KEY` |
| `kimi`     | [Kimi](https://platform.moonshot.ai) (Moonshot)                               | chat API  | `MOONSHOT_API_KEY` |
| `glm`      | [GLM](https://docs.z.ai) (Z.ai)                                               | chat API  | `ZAI_API_KEY`      |

`jev-planner --help` prints the same list, generated from the registry.

## Agent CLIs and chat APIs

- **Agent CLIs** inspect the repository themselves, read-only: Codex runs in its read-only sandbox,
  Claude Code in plan mode with only `Read`, `Glob` and `Grep` and none of your MCP servers. They use
  the CLIs' existing logins, so their calls consume your Codex and Claude subscription allowances,
  not API keys.
- **Chat APIs** cannot open files. Each of their calls is sent with a snapshot of the repository:
  the list of files git tracks, and the contents of the tracked top-level docs and manifests
  (`AGENTS.md`, `CLAUDE.md`, `README.md`, `CONTRIBUTING.md`, `package.json`, …), within fixed size
  limits. Only tracked files are read, so an ignored `.env` is never sent. Outside a git repository
  the snapshot is empty. The model is told to name the files it would need rather than guess them.

## Sessions

Each agent keeps one conversation through a run. An agent CLI's draft session is continued for its
cross-review and the final synthesis (`codex exec resume`, `claude --resume`), so those stages start
with what it already read instead of exploring the repository again; a resumed Codex keeps its
read-only sandbox. A chat API is sent its earlier messages, so the repository snapshot goes once.
If a session cannot be continued, the call starts afresh with the whole prompt.

The CLIs keep those sessions as they keep any other: in `~/.codex/sessions` and
`~/.claude/projects`, and Claude's appear in its `/resume` list. [`--no-resume`](../guides/usage.md) starts every call
afresh and keeps none, as before.

## One provider, several agents

An agent is a provider under a name. `--agents codex` is short for `codex:codex`, and
`--agents codex:sol,codex:terra` runs Codex twice, as two agents named `sol` and `terra`. Each has
its own session, draft and [round files](../guides/usage.md) (`round1/sol.md`), and the overrides take the name:

```sh
jev-planner --agents codex:sol,codex:terra \
  --model sol=gpt-5.6-sol --model terra=gpt-5.6-terra "Add caching to the search endpoint"
```

- **Names** are a letter, then letters, digits or `-`, at most 24 characters, read lowercased. A
  name cannot be `auto`, `none`, `tie`, a Windows device name (`con`, `nul`, …) or another
  provider's id.
- **Labels** tell them apart: the output, the peer reviews and Jev see `Codex (sol)` and
  `Codex (terra)`.
- **Vary them.** Two agents with the same provider, model and effort get a warning on stderr, since
  their drafts may barely differ; the run still goes ahead.
- **Name the one you mean.** Once a provider's agents are named, `--model codex=…` is an error that
  lists them.
- **One quota.** Both draw on the same subscription or key, at the same time. A rate limit (HTTP 429) fails the call, and a failed call fails the run.
- `doctor` checks each provider once.

## Credentials

Every provider's API key, and Jev's, is removed from the environment of every agent subprocess: an
agent never sees another provider's credentials.

To add an AI that is not listed here, see [adding an AI](./adding-an-ai.md).
