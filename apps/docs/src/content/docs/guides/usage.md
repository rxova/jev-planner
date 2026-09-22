---
title: Usage
description: Task inputs, choosing agents, model and effort overrides, JSON output, --verbose and the saved rounds.
sidebar:
  order: 2
---

See every option with `jev-planner --help`. This page covers the ones you will reach for; a
[config file](./config-file.md) sets any of them for every run in a repository.

## Giving it a task

Run from the repository you want the agents to inspect:

```sh
jev-planner "Add per-user rate limiting to the public API"
```

Write the result to a file:

```sh
jev-planner -o PLAN.md "Migrate the persistence layer from SQLite to Postgres"
```

Target a different repository or provide a longer brief:

```sh
jev-planner --cwd ../my-app --file ./brief.md --output PLAN.md
```

A task that is empty or a near-certain placeholder — the text `TODO`, `TBD` or `<coding task>`, an
unfilled `<…>`, `{{…}}` or `[…]` slot, or text with no letters — is rejected before any paid call.
Only the whole text is compared, so a brief that quotes a placeholder, or a short real task such as
`Add caching`, is planned as usual. `--allow-any-task` skips the check.

## Choosing agents and models

- `--agents <ids>` to choose two or more agents (default: `codex,claude`). The
  [agents reference](../reference/agents.md) lists the ids.
- `--model <id>=<model>`, repeatable, to override one agent's model.
- `--effort <id>=<level>`, repeatable, to override an agent CLI's reasoning effort. Levels are the
  CLI's own (`low` … `xhigh` and more, per model) and are passed through unchecked.
- `--review-effort <id>=<level>`, repeatable, to use another effort for that agent's cross-reviews
  and synthesis only, while its draft keeps `--effort`. The later stages edit plans rather than
  explore the repository, so a lower effort is meant to make them quicker; that is not measured.
- `--jev-model` to pin a TypeSafe model rather than use `jev-latest`.
- `--finalizer <id>` to override Jev's routing decision with one of the selected agents.
- `--finalizer none` to keep the cross-reviewed plan Jev rates stronger as it is, rather than
  merge. It saves the last agent call, at the cost of the merge; on a tie, or when no cross-review
  ran, the finalizer still runs.
- `--no-resume` to start every agent call afresh rather than continue its draft session; the
  [agents reference](../reference/agents.md#sessions) says where sessions are kept.

Plan with three agents, and pin one's model:

```sh
jev-planner --agents claude,deepseek,glm --model glm=glm-4.6 "Add a CSV export to the reports page"
```

Model and effort overrides win over the CLIs' local configuration, such as `model` and
`model_reasoning_effort` in `~/.codex/config.toml`, for that run only. Codex on GPT-5.6-Terra at low
effort, with Claude at its defaults:

```sh
jev-planner --model codex=gpt-5.6-terra --effort codex=low "Add caching to the search endpoint"
```

## How much of the pipeline to run

A run's wall clock is the number of rounds, not the number of agent calls: the agents in a round run
in parallel, and each round waits for the one before it. `--mode` decides how many rounds a run may
spend — see [how it works](../learn/how-it-works.md#why-the-mode-matters).

- `--mode balanced` (the default) lets Jev skip the rounds a plan does not need: the cross-review when
  Jev rates another pass below 0.65, and the merge when it rates one cross-reviewed plan 0.7 or more
  to stand alone.
- `--mode fast` has Jev judge each draft alone, as it arrives, and answers with the first it rates
  0.5 or more,
  stopping the other agents; when it accepts none, the drafts are merged with no cross-review. The
  accepted plan was read by no other agent, and `--finalizer` only picks who merges.
- `--mode ultra` always runs the first cross-review, then merges — 2N + 1 agent calls with N agents,
  or 3N + 1 when Jev asks for a second pass. `--finalizer none` can still skip the merge. The
  [cost guide](cost-and-data-flow.md#calls-per-run) has every case.
- `--review-rounds <0|1|2>` caps the cross-review rounds `balanced` and `ultra` may run (default: 2); `fast` runs none.
- `--straggler-grace <seconds>` sets how long a `balanced` or `fast` round waits for the agents still working once
  half (rounded up) have answered (default: 90; `0` waits for every agent). `ultra` never drops an agent.
- `--review-mode debate` (experimental) runs the first cross-review as critiques, replies and Jev's
  ruling on each disagreement, and `--claim-checks` checks the disputed repository claims — see
  [debate review](debate-review.md). Neither works with `--mode fast`, which has no review.

```sh
jev-planner --mode ultra "Migrate the persistence layer from SQLite to Postgres"
```

Every run reports what it spent on stderr:

```text
[jev-planner] balanced mode, 3 agent calls, 1 Jev call, 0 cross-review rounds, merged
```

## JSON output

Use JSON in another tool:

```sh
jev-planner --json "Make image uploads resumable" | jq '.verdict, .plan'
```

## Watching the agents work

A draft can take minutes. `--verbose` streams what each agent is doing to stderr as it happens, one
line per step, prefixed with the agent, then prints Jev's typed verdict:

```text
[jev-planner] Drafting independent plans with Codex and Claude…
[claude] Grep deploy|pages
[codex] I'll inspect the docs app and the workflows first.
[codex] $ /bin/zsh -lc "ls apps/docs .github/workflows"
[claude] Read apps/docs/astro.config.mjs
```

Codex and Claude run with JSON event output (`codex exec --json`, `claude --output-format
stream-json`), so every message, command and file read is shown as the agent reaches it. A chat API
agent answers in one response, so it shows only which model it is waiting on.

After each round, `--verbose` prints how long it took and how long each call in it took, and a
total at the end. These are the rounds of the `ultra` run on
[Modes compared](../learn/modes-compared.md):

```text
[jev-planner] Drafts: 2m58s (Claude 1m18s, Codex 2m58s)
[jev-planner] Review: 1m20s (Claude 1m01s, Codex 1m18s, Jev 1.4s)
[jev-planner] Review: 1m25s (Claude 1m04s, Codex 1m24s, Jev 1.2s)
[jev-planner] Final plan: 54s (Claude 54s)
```

Each round waits for its slowest agent, here Codex, so a round's time is that agent's.

The same numbers, in milliseconds, are in each round's `timings.json`, in `--json`'s `timings`,
and in `PlanRound.timings` and `PlanResult.timings` from code.

## Following a run round by round

Every run writes each round's plans as soon as the round ends, to a new folder under
`.jev-planner/` in the repository, named by the run's UTC start time:

```text
.jev-planner/
  .gitignore          `*`, so the folder never shows up in git
  20260921-230512/
    round1/           the independent drafts
      codex.md
      claude.md
      jev-verdict.json  in balanced and fast mode; ultra judges only reviewed plans
      timings.json    how long the round and each call in it took, in milliseconds
    round2/           only when a cross-review ran: the revised plans, and Jev's verdict
      codex.md
      claude.md
      jev-verdict.json
    round3/           only when Jev asked for a second review
    final/
      plan.md         the merged plan, headed by the agent that merged it, or selected from
      jev-verdict.json  the verdict the merge followed
```

In `fast` mode, `round1/jev-verdict.json` is the verdict that decided the run: the accepted draft's,
or the one Jev gave the drafts together. The verdicts of drafts it turned down alone are not saved.
A debate adds its own files; see [debate review](debate-review.md).

`--rounds-dir <path>` writes them somewhere else instead, relative to `--cwd`; that folder must be
new or empty, so two runs never mix. `--no-rounds` writes nothing.

```sh
jev-planner --rounds-dir rounds -o PLAN.md "Add caching to the search endpoint"
```

## From code

`Planner.plan` runs the same flow as the CLI. In its options, `onRound` receives each round as a
`PlanRound`, `onAgentProgress` receives the lines `--verbose` prints, and `allowAnyTask: true`
skips the placeholder check, which otherwise throws `TaskValidationError`.
