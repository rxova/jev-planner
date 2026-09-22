---
title: Cost and data flow
description: How many paid calls a run makes, and what each agent and Jev get to see.
sidebar:
  order: 3
---

## Calls per run

With N agents, `--mode ultra` makes 2N + 1 agent calls: N drafts, N cross-reviews, and one final
synthesis. If Jev requests another pass, it makes N more. `--finalizer none` drops the synthesis
when Jev rates one cross-reviewed plan stronger. With the default two agents that is five
calls, or seven. Agent CLIs use the accounts logged into them; chat APIs bill the key they are given.

`--mode balanced`, the default, makes as few as N + 1 — the drafts and the merge, when Jev asks for no
cross-review — and never more than `ultra` would:

| What Jev decides                             | Agent calls | Rounds |
| -------------------------------------------- | ----------- | ------ |
| The drafts need no cross-review              | N + 1       | 2      |
| One cross-review, then one plan stands alone | 2N          | 2      |
| One cross-review, then a merge               | 2N + 1      | 3      |
| Two cross-reviews, then a merge              | 3N + 1      | 4      |

Each evaluation uses one TypeSafe API call; `balanced` spends one extra to judge the drafts, and each
further review round causes one re-evaluation. Every run reports its own totals on stderr, and
`--json` includes them as `cost`.

`--review-mode debate` spends 2N agent calls on its first review where a cross-review spends N — a
critique and a reply from each agent — plus one call per agent that checks a claim with
`--claim-checks`. Its Jev call rules on the disagreements in the same request; see
[debate review](debate-review.md).

A `balanced` round also stops waiting for a slow agent once half the others have answered, and aborts
its call rather than leave it running, so a dropped call stops billing where the provider bills by
use.

## What is sent where

- **Jev** sees the task and the agents' plan text, not a direct repository snapshot.
- **Chat APIs** see the repository snapshot described in the
  [agents reference](../reference/agents.md#agent-clis-and-chat-apis).
- **Every agent** sees the other agents' plans, which may contain file names or code details.

Do not run this on material you are not allowed to send to every provider you select.
