---
title: How it works
description: Independent drafts, Jev's typed evaluation, a cross-review when it earns its place, and one final plan.
---

`jev-planner` creates repository-aware implementation plans by combining two or more AIs with
[TypeSafe Jev](https://docs.typesafe.ai/concepts/system-one). A run has four stages, and in the
default `balanced` mode Jev decides which of them a plan actually needs.

The words this page uses:

- **Agent**: one AI that writes plans, such as Codex or Claude. See the
  [agents reference](../reference/agents.md).
- **Jev**: TypeSafe's typed judge. It reads the plans and answers fixed questions with scores and
  probabilities; it writes no plan.
- **Round**: one set of agent calls that run at the same time, such as every agent's draft. A run's
  wall clock is mostly its rounds, one after another.
- **Cross-review**: a round in which each agent reads the others' plans and revises its own.
- **Finalizer**: the agent that merges the plans into one at the end.

```mermaid diagram=pipeline caption="One run, from a task to one plan. The dashed step runs only when Jev asks for it."
flowchart TD
  task["Task and repository"] --> drafts["Every agent drafts a plan<br>in parallel; none sees another"]
  drafts --> jev["Jev judges the plans<br>scores, a finalizer, two probabilities"]
  jev -.->|"another pass ≥ 0.65"| review["Cross-review<br>each agent revises against the others"]
  review -.-> jev
  jev --> finish["Adopt one plan, or merge them"]
  finish --> plan["One final plan"]
```

## 1. Independent drafts

Each agent — Codex and Claude by default — drafts a plan independently, all in parallel. None of
them sees another's work yet. This is the stage where the agent CLIs explore the repository, read
only; a chat API gets a fixed snapshot of it instead. The later stages' prompts tell the agents to
open a file only to settle a specific point.

## 2. Jev evaluates

Jev scores completeness, feasibility, and risk coverage; chooses a finalizer; and answers two
yes-or-no questions as probabilities, which decide what the run does next:

| Question Jev answers                                                          | Threshold | What it decides                                           |
| ----------------------------------------------------------------------------- | --------: | --------------------------------------------------------- |
| Would a cross-review round materially improve the plan?                       |    ≥ 0.65 | Another cross-review runs, in `balanced` and `ultra`      |
| Could the strongest cross-reviewed plan be final, with no merge?              |     ≥ 0.7 | `balanced` answers with that plan and skips the merge     |
| Could this one draft, judged alone, be handed to an implementer as it stands? |     ≥ 0.5 | `fast` answers with that draft and stops the other agents |

In the `balanced` run on [Modes compared](modes-compared.md), Jev rated the first question 0.66 for
the drafts and 0.70 after the first review, so both reviews ran. No verdict saved in those four runs
rated a plan 0.7 or more to stand alone.

Jev reads the first 40,000 characters of each plan; a longer plan is cut there for Jev, not for the
agents.

## 3. Cross-review

When Jev asks for one, each agent sees every other agent's plan and returns a revised, standalone
plan, aimed by Jev's typed feedback — and Jev evaluates the result. An agent opens a file only to check a claim
the plans disagree on, or one it is unsure of. That repeats while Jev keeps
asking, up to `--review-rounds` times (two by default; `0` skips the cross-review altogether).

In `--mode ultra` the first cross-review is not Jev's to skip: the agents always review each other,
and Jev only decides whether to ask for a second pass.

### What the cross-review improves

A draft is written blind: each agent knows the repository, but not what the others noticed in it.
The cross-review is the first time a plan meets a second opinion, and it is meant to be where a run
improves most. Reading each other's plans, the agents can:

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

To see it on your own run, compare `round1/` with `round2/` in the run folder. That is also why
`balanced` never adopts a plan that has not been cross-reviewed, and why `--review-rounds 0` trades
quality for time.

## 4. Synthesis

The selected agent merges the plans into one final implementation plan. `--finalizer <name>` overrides
Jev's choice with one of the selected agents. `--finalizer none` skips this step when Jev
rates one cross-reviewed plan stronger, and returns that plan as it is; on a tie the finalizer
still merges.

In `balanced` mode this stage is skipped when Jev judges the strongest cross-reviewed plan already final
as it stands: every plan has answered the others by then, so the merge would rewrite what is already
there. `balanced` never adopts a plan that has not been cross-reviewed this way — before a review,
the merge is the only place the agents' material comes together, so it runs. `fast` is the
exception, and that is its trade.

`--finalizer <name>` turns this off: naming the agent that merges means the merge runs.

## Fast, balanced or ultra, in short

All three modes start the same way: every agent writes its own plan, at the same time. They differ in
what happens next.

```mermaid diagram=mode-fast,mode-balanced,mode-ultra caption="The three modes, with the round times from the runs on Modes compared. A dashed step runs only when Jev asks for it."
flowchart TD
  subgraph fast["fast"]
    fd["Every agent drafts"] --> fj["Jev judges each draft<br>alone, as it arrives"]
    fj --> fa["first ≥ 0.5<br>That draft<br>is the plan"]
    fj --> fm["none ≥ 0.5<br>All judged,<br>then merged"]
    ft["Its run: 221 s, 54 s"]
  end
  subgraph balanced["balanced"]
    bd["Every agent drafts"] --> bj["Jev judges the drafts"]
    bj -.->|"another pass ≥ 0.65"| br["Cross-review, Jev again<br>up to twice"]
    br --> ba["reviewed,<br>rated ≥ 0.7<br>Adopt the<br>strongest"]
    br --> bm["otherwise<br>One agent<br>merges"]
    bj --> bm
    bt["Its run: 239 s, 113 s, 116 s, 53 s"]
  end
  subgraph ultra["ultra"]
    ud["Every agent drafts"] --> ur["Cross-review, always<br>then Jev judges"]
    ur -.->|"another pass ≥ 0.65"| u2["Second cross-review"]
    ur --> um["by default<br>One agent<br>merges"]
    u2 --> um
    u2 --> us["--finalizer<br>none<br>The stronger<br>plan, as is"]
    ur --> us
    ut["Its run: 178 s, 80 s, 85 s, 54 s"]
  end
```

- **`ultra` always runs the first cross-review.** The agents always read each other's plans and
  improve their own, Jev may ask for a second pass, and one agent merges the plans, unless
  `--finalizer none` keeps the reviewed plan Jev rates stronger. With two agents that is five agent
  calls in three rounds, or seven in four.
- **`balanced` asks Jev before each optional step.** When Jev rates another pass below 0.65, it
  skips the cross-review and goes straight to the merge: three calls in two rounds. After a
  cross-review, when one plan is already final, it answers with that plan and skips the merge. It
  also stops waiting for a slow agent once the others have answered.
- **`fast` takes the first draft Jev accepts.** Jev judges each draft on its own as it arrives, and
  the first one it rates 0.5 or more is the answer: the agents still drafting are stopped.
  With two agents that can be two calls in one round. When Jev accepts none, the drafts are merged
  with no cross-review.

`balanced` is quicker only when Jev skips a round, because rounds, not calls, are what take the
time. When Jev asks for every round, as in the run on [Modes compared](modes-compared.md), it runs
what `ultra` does. The price of the saving is trusting Jev's call on which steps a plan can do
without. Use `ultra` when the plan matters more than the wait.

`fast` goes further and pays for it: an accepted plan is one agent's work that no other agent has
read, and the quickest agent is judged first, so a quick plan that clears the bar beats a slower,
better one nobody waited for. An agent stopped mid-draft has still spent what it used. Use `fast`
when one good plan is enough. [Modes compared](modes-compared.md) runs one real task all four ways.

## Why the mode matters

The agents in a round run in parallel, so a run's wall clock is not the number of agent calls but
the number of rounds: each one waits for the one before it, and for its slowest agent. In the runs
on [Modes compared](modes-compared.md) a round took from 49 seconds to four minutes, and a Jev call
from about 1 to 1.6 seconds. At best `balanced` spends two rounds where `ultra` spends three, and asks
Jev — one quick, typed call — whether each further round is worth it.

`balanced` also stops a round waiting on one slow agent: once half of them have answered, the rest get
`--straggler-grace` seconds (90 by default) and are then dropped, with their calls aborted rather
than left running and billing. A round never falls below two plans, so with two agents every draft
is waited for, and an agent dropped from a cross-review keeps the plan it had. `fast` applies the same grace to its drafts. `ultra` always
waits for every agent.

Every run reports what it spent on stderr, and `--json` includes it as `cost`:

```text
[jev-planner] balanced mode, 3 agent calls, 1 Jev call, 0 cross-review rounds, merged
```

## Why Jev is the arbiter

Jev does not generate prose or code. It returns constrained `choice`, `score`, and `noul` decisions
with probabilities. That makes it a good fit for the branch points in this workflow — quality
scoring, review routing, finalizer selection, and whether a round is worth its wait — while the
agents handle repository exploration and plan writing.

The agents never edit the repository: agent CLIs run read-only, and chat APIs cannot open files at
all. The [agents reference](../reference/agents.md) says exactly what each kind can see.
