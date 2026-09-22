---
title: Cost and data flow
description: How many paid calls a run makes, and what each agent and Jev get to see.
sidebar:
  order: 3
---

## Calls per run

A run pays for two kinds of call: agent calls, billed to the account or key each agent runs under,
and Jev calls, one TypeSafe API call each. Agent CLIs use the accounts logged into them; chat APIs
bill the key they are given. No prices are given here, because they depend on your plans and keys.

With N agents and the standard review:

| Mode and what happens                            | Agent calls | Jev calls | Rounds |
| ------------------------------------------------ | ----------- | --------- | ------ |
| `fast`: Jev accepts a draft judged alone         | N           | 1 … N     | 1      |
| `fast`: Jev accepts none, so the drafts merge    | N + 1       | N + 1     | 2      |
| `balanced`: no cross-review, then a merge        | N + 1       | 1         | 2      |
| `balanced`: one cross-review, then adopted whole | 2N          | 2         | 2      |
| `balanced`: one cross-review, then a merge       | 2N + 1      | 2         | 3      |
| `balanced`: two cross-reviews, then adopted      | 3N          | 3         | 3      |
| `balanced`: two cross-reviews, then a merge      | 3N + 1      | 3         | 4      |
| `ultra`: one cross-review, then a merge          | 2N + 1      | 1         | 3      |
| `ultra`: two cross-reviews, then a merge         | 3N + 1      | 2         | 4      |
| `ultra` with `--review-rounds 0`                 | N + 1       | 1         | 2      |

A round here is one set of agent calls made at the same time; the rounds run one after another, so
they, not the calls, are the wall clock. With the default two agents, `balanced` makes three to seven
agent calls and `ultra` five or seven.

- **`--finalizer none`** drops the merge, one agent call and one round, whenever a cross-review ran
  and Jev rates one plan stronger; on a tie, the merge still runs.
- **`--finalizer <id>`** always merges: `balanced` then never adopts a plan whole.
- **`fast` still pays for the agents it stops.** An agent aborted mid-draft counts as a call and has
  billed what it used. Only the verdict that decided the run is saved; the verdicts of drafts Jev
  turned down alone are not.
- **`--review-mode debate`** spends 2N agent calls on its first review where a cross-review spends N
  — a critique and a reply from each agent — plus one call per agent that checks a claim with
  `--claim-checks`. Its Jev call rules on the disagreements in the same request; see
  [debate review](debate-review.md). It runs in `balanced` and `ultra`; `fast` rejects it.

Every run reports its own totals on stderr, and `--json` includes them as `cost`. The four runs on
[Modes compared](../learn/modes-compared.md) spent this, counted from their rounds folders and
written as the cost line reads:

```text
[jev-planner] fast mode, 3 agent calls, 3 Jev calls, 0 cross-review rounds, merged
[jev-planner] balanced mode, 7 agent calls, 3 Jev calls, 2 cross-review rounds, merged
[jev-planner] ultra mode, 7 agent calls, 2 Jev calls, 2 cross-review rounds, merged
[jev-planner] ultra mode, debate review, 9 agent calls, 2 Jev calls, 2 cross-review rounds, merged
```

The `fast` run judged both drafts alone, accepted neither, then judged them together. Its drafts
round took 3m41s because, with two agents, it has to wait for both: a round never falls below two
plans.

A `balanced` or `fast` round also stops waiting for a slow agent once half the agents (rounded up)
have answered: the rest get `--straggler-grace` seconds, then their calls are aborted rather than
left running, so a dropped call stops billing where the provider bills by use.

## What is sent where

- **Jev** sees the task and the agents' plan text, not a direct repository snapshot.
- **Chat APIs** see the repository snapshot described in the
  [agents reference](../reference/agents.md#agent-clis-and-chat-apis).
- **Every agent that cross-reviews, checks a claim or merges** sees the other agents' plans, which
  may contain file names or code details. When `balanced` skips the review, only the finalizer sees
  them all; a draft `fast` accepts is read by no other agent.
- **Jev** reads the first 40,000 characters of each plan.

Do not run this on material you are not allowed to send to every provider you select.
