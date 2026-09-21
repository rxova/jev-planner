---
title: Usage
description: Task inputs, choosing agents, model and effort overrides, JSON output, --verbose and the saved rounds.
sidebar:
  order: 2
---

See every option with `jev-planner --help`. This page covers the ones you will reach for.

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
- `--jev-model` to pin a TypeSafe model rather than use `jev-latest`.
- `--finalizer <id>` to override Jev's routing decision with one of the selected agents.
- `--review-rounds 1` to disable Jev's optional second review pass.

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
total at the end:

```text
[jev-planner] Drafts: 4m12s (Codex 4m12s, Claude 2m51s)
[jev-planner] Review: 1m05s (Codex 58s, Claude 41s, Jev 7.0s)
[jev-planner] Final plan: 49s (Claude 49s)
[jev-planner] Total: 6m06s
```

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
      timings.json    how long the round and each call in it took, in milliseconds
    round2/           the cross-reviewed plans, and Jev's verdict on them
      codex.md
      claude.md
      jev-verdict.json
    round3/           only when Jev asked for a second review
    final/
      plan.md         the merged plan, headed by the agent that merged it
      jev-verdict.json  the verdict the merge followed
```

`--rounds-dir <path>` writes them somewhere else instead, relative to `--cwd`; that folder must be
new or empty, so two runs never mix. `--no-rounds` writes nothing.

```sh
jev-planner --rounds-dir rounds -o PLAN.md "Add caching to the search endpoint"
```

## From code

`Planner.plan` runs the same flow as the CLI. In its options, `onRound` receives each round as a
`PlanRound`, `onAgentProgress` receives the lines `--verbose` prints, and `allowAnyTask: true`
skips the placeholder check, which otherwise throws `TaskValidationError`.
