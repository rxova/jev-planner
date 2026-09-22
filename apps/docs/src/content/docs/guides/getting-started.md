---
title: Getting started
description: Install jev-planner, check the agents and keys with doctor, and write your first plan.
sidebar:
  order: 1
---

`jev-planner` writes an implementation plan for a coding task by having two or more AIs draft it,
cross-review it when that would help, and merge it, with TypeSafe Jev deciding each step. This page gets you from nothing
to a first plan.

## Requirements

- Node.js 20.19 or newer
- For each agent CLI you select: the CLI, already logged in
- For each chat API you select: its API key in the environment
- A TypeSafe API key from <https://console.typesafe.ai/keys>

The default agents are the [Codex CLI](https://learn.chatgpt.com/docs/non-interactive-mode) and
[Claude Code](https://docs.anthropic.com/en/docs/claude-code/getting-started). The
[agents reference](../reference/agents.md) lists the others.

## Install

```sh
npm install -g jev-planner
```

Or run it without installing:

```sh
npx jev-planner "Add per-user rate limiting to the public API"
```

## Check your setup

```sh
export TYPESAFE_API_KEY="your-key"
jev-planner doctor
```

`doctor` checks the selected agents — each CLI is installed and logged in, each API key is set —
and the Jev key. `jev-planner doctor --agents codex,deepseek` checks that pair. It does not make a
paid model call.

## Write your first plan

Run from the repository you want the agents to inspect:

```sh
jev-planner "Add per-user rate limiting to the public API"
```

The plan is printed to stdout. To write it to a file instead:

```sh
jev-planner -o PLAN.md "Migrate the persistence layer from SQLite to Postgres"
```

A run takes minutes and makes several paid calls; see [cost and data flow](./cost-and-data-flow.md)
before you run it on a large task. [Usage](./usage.md) covers every other option, and a
[config file](./config-file.md) pins them for a repository.
