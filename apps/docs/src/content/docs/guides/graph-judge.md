---
title: Graph judge
description: Judge the plans with a panel of the providers' own models instead of TypeSafe's Jev, with rules that settle what they can and no TypeSafe key.
sidebar:
  order: 6
  badge: Experimental
---

By default [TypeSafe's Jev](https://docs.typesafe.ai/concepts/system-one) judges every round. The
graph judge asks the same questions of a panel of models you already use as agents, through
[`@rxova/journey-judge`](https://www.npmjs.com/package/@rxova/journey-judge). It needs no
`TYPESAFE_API_KEY`: each panel model runs on its provider's CLI login or API key.

It is set in [`jev-planner.json`](./config-file.md) only; no flag selects it.

```json
{
  "$schema": "https://jev-planner.com/config.schema.json",
  "judge": {
    "kind": "graph",
    "panel": [
      { "provider": "claude", "model": "haiku" },
      { "provider": "deepseek", "weight": 2 }
    ],
    "samples": 3,
    "maxCalls": 12,
    "timeout": 60,
    "rules": { "claimChecks": true }
  }
}
```

It is experimental: the questions, the rules and the `judge.json` shape may change in a minor
release.

## The settings

| Key                 | Value                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `kind`              | `graph`; `typesafe`, the default, is Jev and takes no other key                                              |
| `panel`             | One or more `{ provider, model?, weight? }`. A provider is one of the [agents](../reference/agents.md)       |
| `panel[].model`     | The model that judges; the provider's default otherwise                                                      |
| `panel[].weight`    | How much its vote counts, above 0; `1` otherwise                                                             |
| `samples`           | Answers per question round, shared among the panel in turn; by default a multiple of the choices, at least 3 |
| `maxCalls`          | Model calls one verdict may make, retries included; 4 × `samples` by default                                 |
| `timeout`           | Seconds for each model call                                                                                  |
| `rules.claimChecks` | `true` lets a [claim check](./debate-review.md) settle its dispute without the panel; off by default         |

A panel entry is checked before the run starts: an unknown provider, or an API provider whose key is
not set, stops it with the variable to set. `--jev-model` names a TypeSafe model, so it is ignored
with a warning.

## What it asks

The panel answers the questions Jev answers, in the same shape: the stronger plan, the finalizer,
completeness, feasibility and risk coverage on 0–3, whether another pass would help, whether the
strongest plan stands alone, and in a [debate](./debate-review.md) a ruling on each dispute. The
option labels rotate from sample to sample, so no plan is always option A. A split vote on the
stronger plan is `tie`, on a dispute `unclear`; on the finalizer it falls back to the first plan's
agent.

Before any call, rules and the run's progress settle what they can:

- **Too short.** When every plan is under 200 characters, not counting whitespace, none stands alone.
- **Claim checks**, with `rules.claimChecks`. A dispute an agent checked in the repository goes to
  the critics on `confirm` and to the author on `refute`, at confidence 0.8, since one checker can
  be wrong. `unknown` leaves it to the panel.
- **One plan.** With a single plan, the stronger plan and the finalizer are that plan's agent.
- **Answers the run will not read** take their fallback without a call: another pass once the run
  has used its review rounds (always, in `--mode fast`), and the stronger plan and whether it stands
  alone before any review.

## What it costs, and what it writes

Every sample is a model call billed to the provider it runs on, so a verdict costs up to
`maxCalls` calls, where Jev's costs one. A CLI panel model runs in the system's temporary folder,
not the repository; Claude runs with no tools and no MCP servers. It judges the plans it is given.

The verdict's `model` names the panel, then the questions a rule settled and those the panel could
not agree on: `claude/haiku+deepseek rule:stands_alone abstained:finalizer`. Each judged round
folder gets a `judge.json` beside `jev-verdict.json`: the judge's path, each answer's source
(`rule`, `panel`, `abstained` or `skipped`) and every sample. `--json` and `--verbose` print the
verdict without it.

`jev-planner doctor` checks the panel's providers too, and leaves out the TypeSafe key.

## From code

`Planner` takes any `JevJudge`, so a script can build the graph judge itself:

```ts
import { tmpdir } from 'node:os'
import { GraphJevJudge, judgePanel, Planner } from 'jev-planner'

// Where CLI models run, the variables they must not see, and the environment.
const panel = judgePanel([{ provider: 'claude', model: 'haiku' }, { provider: 'deepseek' }], {
  cwd: tmpdir(),
  omitEnv: ['TYPESAFE_API_KEY'],
  env: process.env,
})
// `agents`: your `PlanningAgent`s, as for Jev.
const planner = new Planner(agents, new GraphJevJudge({ panel, claimChecks: true }))
```

`GraphJevJudge` takes any `@rxova/journey-judge` panel, so a model need not be one of the providers.
