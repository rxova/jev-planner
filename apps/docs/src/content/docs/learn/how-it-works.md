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

### What the cross-review improves

A draft is written blind: each agent knows the repository, but not what the others noticed in it.
The cross-review is the first time a plan meets a second opinion, and it is where most of a run's
improvement happens. Reading each other's plans, the agents:

- **Correct each other's facts.** One plan assumes a function is private; another has read the file
  and shows it is exported. Claims the plans disagree on are exactly the ones an agent reopens the
  repository to check.
- **Drop their weakest ideas.** A shortcut that looked fine in isolation rarely survives a peer that
  proposes something safer.
- **Take the other plan's strengths.** One draft is concise and well structured, another is tied to
  files and line numbers; after the review each revised plan carries more of both.
- **Name the real open questions.** Where the agents still disagree, the revised plans say so,
  rather than each confidently settling it a different way.

For example, on a brief to add a debate-style review to `jev-planner` itself, Claude's draft merged
similar objections by word overlap; after reading Codex's plan it switched to exact matching, which
cannot merge two different objections. Codex, in turn, took Claude's idea of evaluating the feature
against past commits instead of trusting the tool's own scores. The final merge added little on
top: the revised plans had already done the work.

A hand review of that run's five plans, scored out of 10 (a person's judgement, not Jev's; the brief
asked for under 1,500 words):

| Plan            | Words | Score | In one line                                                                                  |
| --------------- | ----: | ----: | -------------------------------------------------------------------------------------------- |
| Codex, round 1  |  1312 |   6.5 | Clean design and the only one within the word limit, but it names no file or line            |
| Claude, round 1 |  1968 |     7 | Best tied to the actual code, but it has two risky ideas                                     |
| Codex, round 2  |  1465 |   7.5 | Took Claude's evaluation ideas and the stricter duplicate check, still no references to code |
| Claude, round 2 |  2175 |     8 | Dropped its weak ideas, well grounded, and says what it took from Codex and why              |
| Final, merged   |  2278 |   8.5 | The best overall, but only slightly better than Claude's round 2 plan, and the longest       |

Both agents gained a point from the cross-review; the merge gained half of one.

To see it on your own run, compare `round1/` with `round2/` in the run folder. That is also why a
plan that has not been cross-reviewed is never adopted whole, and why `--review-rounds 0` trades
quality for time.

## 4. Synthesis

The selected agent merges the plans into one final implementation plan. `--finalizer <id>` overrides
Jev's choice with one of the selected agents. `--finalizer none` skips this step when Jev
rates one cross-reviewed plan stronger, and returns that plan as it is; on a tie the finalizer
still merges.

In `fast` mode this stage is skipped when Jev judges the strongest cross-reviewed plan already final
as it stands: every plan has answered the others by then, so the merge would rewrite what is already
there. A plan that has not been cross-reviewed is never adopted this way — the merge is the only
place the agents' material comes together, so it always runs.

## Fast or ultra, in short

Both modes start the same way: every agent writes its own plan, at the same time. They differ in
what happens next.

- **`ultra` runs every step, every time.** The agents always read each other's plans and improve
  their own, Jev may ask for a second pass, and one agent always merges the plans. With two agents
  that is five agent calls in three rounds, or seven in four. Nothing is skipped.
- **`fast` asks Jev before each optional step.** When the drafts already agree and look solid, it
  skips the cross-review and goes straight to the merge: three calls in two rounds. After a
  cross-review, when one plan is already final, it answers with that plan and skips the merge. It
  also stops waiting for a slow agent once the others have answered.

`fast` is quicker because rounds, not calls, are what take the time. The price is trusting Jev's
call on which steps a plan can do without. Use `ultra` when the plan matters more than the wait.

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
