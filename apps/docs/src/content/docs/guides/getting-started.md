---
title: Quick start
description: 'From nothing to a first plan: two logged-in agents, the Jev key, doctor, one run.'
sidebar:
  order: 1
---

Three steps, a few minutes: check what you need, run `doctor`, plan something. [How it
works](../learn/how-it-works.md) explains what happens in between.

## Before you start

- **Node.js 20.19 or newer.**
- **Two agents.** By default the [Codex CLI](https://learn.chatgpt.com/docs/non-interactive-mode)
  and [Claude Code](https://docs.anthropic.com/en/docs/claude-code/getting-started), each installed
  and already logged in. A chat API needs its key in the environment instead; the
  [agents reference](../reference/agents.md) lists every option.
- **A TypeSafe API key**, from <https://console.typesafe.ai/keys>.

## Install and check

```sh
npm install -g jev-planner
export TYPESAFE_API_KEY="your-key"
jev-planner doctor
```

`doctor` checks the selected agents — each CLI installed and logged in, each API key set — and the
Jev key, without making a paid model call.

## First plan

Run it from the repository you want the agents to inspect:

```sh
jev-planner -o PLAN.md "Add per-user rate limiting to the public API"
```

```text
[jev-planner] Drafting independent plans with Codex and Claude…
[jev-planner] Asking Jev for typed quality and routing decisions…
# only when Jev asks: [jev-planner] Cross-reviewing the 2 drafts…
[jev-planner] Wrote /home/you/my-app/PLAN.md
```

A run takes minutes and makes several paid calls; read [cost and data
flow](./cost-and-data-flow.md) before pointing it at a large task.

**Next:** [usage](./usage.md) covers every other option, a [config file](./config-file.md) pins them
for a repository, and [how it works](../learn/how-it-works.md) explains Jev's part. To run it
without installing: `npx jev-planner "<task>"`.
