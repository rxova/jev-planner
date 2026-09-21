---
title: How it works
description: Independent drafts, cross-review, Jev's typed evaluation, an optional second pass, and one merged plan.
---

`jev-planner` creates repository-aware implementation plans by combining two or more AIs with
[TypeSafe Jev](https://docs.typesafe.ai/concepts/system-one). A run has four stages.

## 1. Independent drafts

Each agent — Codex and Claude by default — drafts a plan independently, all in parallel. None of
them sees another's work yet. This is the stage where the agents explore the repository; later
stages are told to open a file only to settle a specific point.

## 2. Cross-review

Each agent sees every other agent's draft and returns a revised, standalone plan. It opens a file
only to check a claim the plans disagree on, or one it is unsure of.

## 3. Jev evaluates

Jev scores completeness, feasibility, and risk coverage; chooses a finalizer; and decides whether
the plans need one more cross-review. If it does, the agents review each other once more and Jev
evaluates again. `--review-rounds 1` disables that optional pass.

## 4. Synthesis

The selected agent merges the revised drafts into one final implementation plan. `--finalizer <id>`
overrides Jev's choice with one of the selected agents.

## Why Jev is the arbiter

Jev does not generate prose or code. It returns constrained `choice`, `score`, and `noul` decisions
with probabilities. That makes it a good fit for the branch points in this workflow — quality
scoring, review routing, and finalizer selection — while the agents handle repository exploration
and plan writing.

The agents never edit the repository: agent CLIs run read-only, and chat APIs cannot open files at
all. The [agents reference](../reference/agents.md) says exactly what each kind can see.
