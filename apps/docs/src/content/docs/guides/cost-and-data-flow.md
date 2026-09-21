---
title: Cost and data flow
description: How many paid calls a run makes, and what each agent and Jev get to see.
sidebar:
  order: 3
---

## Calls per run

With N agents, a normal run makes 2N + 1 agent calls: N drafts, N cross-reviews, and one final
synthesis. If Jev requests another pass, it makes N more. `--finalizer none` drops the synthesis
when Jev rates one plan stronger. With the default two agents that is five
calls, or seven. Agent CLIs use the accounts logged into them; chat APIs bill the key they are given.

Each evaluation uses one TypeSafe API call; a second review pass causes one re-evaluation.

## What is sent where

- **Jev** sees the task and the agents' plan text, not a direct repository snapshot.
- **Chat APIs** see the repository snapshot described in the
  [agents reference](../reference/agents.md#agent-clis-and-chat-apis).
- **Every agent** sees the other agents' plans, which may contain file names or code details.

Do not run this on material you are not allowed to send to every provider you select.
