---
title: How it works
description: Independent drafts, Jev's typed evaluation, a cross-review when it earns its place, and one final plan.
---

`jev-planner` creates repository-aware implementation plans by combining two or more AIs with
[TypeSafe Jev](https://docs.typesafe.ai/concepts/system-one). A run has four stages, and in the
default `fast` mode Jev decides which of them a plan actually needs.

## 1. Independent drafts

Each agent — Codex and Claude by default — drafts a plan independently, all in parallel. None of
them sees another's work yet. This is the stage where the agents explore the repository; later
stages are told to open a file only to settle a specific point.

## 2. Jev evaluates

Jev scores completeness, feasibility, and risk coverage; chooses a finalizer; and decides whether a
cross-review would materially improve the plan.

## 3. Cross-review

When Jev asks for one, each agent sees every other agent's plan and returns a revised, standalone
plan, aimed by Jev's typed feedback — and Jev evaluates the result. An agent opens a file only to check a claim
the plans disagree on, or one it is unsure of. That repeats while Jev keeps
asking, up to `--review-rounds` times (two by default; `0` skips the cross-review altogether).

In `--mode ultra` the first cross-review is not Jev's to skip: the agents always review each other,
and Jev only decides whether to ask for a second pass.

## 4. Synthesis

The selected agent merges the plans into one final implementation plan. `--finalizer <id>` overrides
Jev's choice with one of the selected agents. `--finalizer none` skips this step when Jev
rates one cross-reviewed plan stronger, and returns that plan as it is; on a tie the finalizer
still merges.

In `fast` mode this stage is skipped when Jev judges the strongest cross-reviewed plan already final
as it stands: every plan has answered the others by then, so the merge would rewrite what is already
there. A plan that has not been cross-reviewed is never adopted this way — the merge is the only
place the agents' material comes together, so it always runs.

## Why the mode matters

The agents in a round run in parallel, so a run's wall clock is not the number of agent calls but
the number of rounds: each one waits for the one before it, and each is minutes long. `fast` spends
two rounds where `ultra` spends three, and asks Jev — one cheap, typed call — whether a third is
worth it.

`fast` also stops a round waiting on one slow agent: once half of them have answered, the rest get
`--straggler-grace` seconds (90 by default) and are then dropped, with their calls aborted rather
than left running and billing. A round never falls below two plans, and an agent dropped from a
cross-review keeps the plan it had. `ultra` always waits for every agent.

Every run reports what it spent on stderr, and `--json` includes it as `cost`:

```text
[jev-planner] fast mode, 3 agent calls, 1 Jev call, 0 cross-review rounds, merged
```

## Why Jev is the arbiter

Jev does not generate prose or code. It returns constrained `choice`, `score`, and `noul` decisions
with probabilities. That makes it a good fit for the branch points in this workflow — quality
scoring, review routing, finalizer selection, and whether a round is worth its wait — while the
agents handle repository exploration and plan writing.

The agents never edit the repository: agent CLIs run read-only, and chat APIs cannot open files at
all. The [agents reference](../reference/agents.md) says exactly what each kind can see.
