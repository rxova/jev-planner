---
title: Agents
description: The AIs jev-planner can use, what each needs, and what each is allowed to see.
sidebar:
  order: 1
---

Pick the agents with `--agents`, two or more, comma-separated:

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
  Claude Code in plan mode with only `Read`, `Glob` and `Grep`. They use the CLIs' existing logins,
  so their calls consume your Codex and Claude subscription allowances, not API keys.
- **Chat APIs** cannot open files. Each of their calls is sent with a snapshot of the repository:
  the list of files git tracks, and the contents of the tracked top-level docs and manifests
  (`AGENTS.md`, `CLAUDE.md`, `README.md`, `CONTRIBUTING.md`, `package.json`, …), within fixed size
  limits. Only tracked files are read, so an ignored `.env` is never sent. Outside a git repository
  the snapshot is empty. The model is told to name the files it would need rather than guess them.

## Credentials

Every provider's API key, and Jev's, is removed from the environment of every agent subprocess: an
agent never sees another provider's credentials.

To add an AI that is not listed here, see [adding an AI](./adding-an-ai.md).
