---
title: Debate review
description: The experimental review mode where agents critique each other's plans, answer the objections, and Jev rules on what they still disagree about.
sidebar:
  order: 4
  badge: Experimental
---

The standard cross-review hands each agent every other plan and asks for a better one. It works, but
nothing records what an agent disagreed with, or whether the other side agreed. `--review-mode
debate` makes the disagreement explicit, so Jev can rule on it and the next pass can aim at it.

```sh
jev-planner --review-mode debate "Add rate limiting to the public API"
jev-planner --claim-checks "Add rate limiting to the public API"
```

It is experimental: the prompts, the file names and the `PlanRound.debate` shape may change in a
minor release.

## What runs

A debate replaces the first cross-review, and runs wherever that would run: always in `--mode
ultra`, and in `balanced` only when Jev asks for a review of the drafts.

1. **Critiques.** Each agent reads every other plan and lists numbered objections to each, at most
   five per plan, most important first. An objection that makes a claim someone could check by
   opening a file is tagged `[repo]`. The agent writes no plan in this round.

   ```text
   TARGET: claude
   C1 [repo]: runRound is not exported from orchestrator.ts — the plan imports it
   C2: the retry budget is never reset — a long run stops retrying
   ```

2. **Replies.** Each author answers every objection to its own plan by id — `ACCEPT` and change the
   plan, or `REJECT` with the reason — and returns its revised plan. An author with no objections
   returns its plan, improved where it sees fit.
3. **Disputes.** Every rejected objection becomes a dispute. The same claim against the same plan
   is one dispute, however many agents raised it; disputes are ranked by how many agents raised
   them, then by whether they are about the repository. Jev rules on up to eight — the critic is
   right, the author is right, or the material does not settle it — in the same call as its usual
   verdict. The rest are listed as not judged.
4. **A targeted pass.** When Jev still asks for another pass, the agents revise against the
   disputes it left open — a ruling of _unclear_, or one below 0.65 confidence — rather than against
   the whole verdict. If every dispute was settled, the pass aims at Jev's weakest score instead.
5. **The merge** sees every dispute and Jev's ruling on it, and follows a ruling unless the plans
   show it wrong.

The adoption rules do not change: in `balanced`, a reviewed plan Jev judges final as it stands is
still used without a merge, and `--finalizer none` still keeps the stronger plan.

## Claim checks

`--claim-checks`, which implies `--review-mode debate`, adds one step between the replies and Jev.
Each disputed `[repo]` claim goes to an agent that reads the repository and did not raise it —
another author's peer first, the author itself if no one else is left — and that agent answers:

```text
D1: REFUTE — src/orchestrator.ts:Planner.round is private, runRound is a local closure
```

Jev then rules with the check in front of it. An agent CLI (`codex`, `claude`) runs in the
repository and can check a claim; a chat API (`deepseek`, `kimi`, `glm`) sees only a snapshot and
cannot. With fewer than two agent CLIs, or no disputed repository claim, the checks are skipped and
the run says so on stderr.

## What it costs

With N agents, the debate spends 2N agent calls where a cross-review spends N: a critique and a
reply from each. Claim checks add one call per agent that has a claim to check. Jev calls are
unchanged. The cost line on stderr names the review mode:

```text
[jev-planner] ultra mode, debate review, 7 agent calls, 1 Jev call, 1 cross-review round, merged
```

A debate is a review round, so it cannot run with `--review-rounds 0`, and `--claim-checks` cannot
be combined with an explicit `--review-mode standard`.

## What it writes

Beside the plans in the rounds folder, a debate keeps each agent's raw answer and what was parsed
from it:

```text
round2/                 the critiques; the plans have not changed yet
  codex.critique.md
  claude.critique.md
  objections.json       every objection, with its id, critic, target and [repo] tag
round3/                 the replies and the revised plans
  codex.md
  codex.reply.md
  claude.md
  claude.reply.md
  replies.json          { replies, unanswered }
  disputes.json         { disputes, overflow, claimChecks? }
  jev-verdict.json      with a ruling for each dispute
```

With claim checks, the replies round has no verdict, and a round after it holds each checker's
`<agent>.check.md`, `disputes.json` with each check, and Jev's verdict.

From code, pass `reviewMode: 'debate'` and `claimChecks: true` in `PlanOptions`. Each round's
`PlanRound.debate` and `PlanRound.artifacts` carry the same data, `PlanResult.debate` carries the
last debate state, `JevVerdict.disputes` holds the rulings, and `PlanCost.reviewMode` says which
review ran. An agent built by `cliProvider` sets `readsRepository: true`; your own `PlanningAgent`
sets it to take part in claim checks.
