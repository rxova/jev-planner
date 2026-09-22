# @rxova/planner-core

The planner behind [jev-planner](https://www.npmjs.com/package/jev-planner), as a library. Two or
more AI agents draft a coding plan for the same task. A judge you supply scores the drafts, orders a
cross-review or a debate when one would help, and picks the stronger plan and the agent that writes
the final version. Every agent runs read-only.

It also holds the CLI around the planner. A program is a `PlannerProgram` (its name, version and
judge), a `PlanJudge`, and a `bin` of a few lines. jev-planner is one such program, judged by
TypeSafe's Jev.

Node >= 20.19. MIT. ESM and CommonJS, with type declarations.

Not on npm yet. It is private for now, and jev-planner bundles it and re-exports the planner, the
providers and the types. The install line below is for when it is published.

## Install

```sh
npm install @rxova/planner-core
```

## Plan from code

```ts
import { PROVIDERS, Planner } from '@rxova/planner-core'
import type { PlanJudge } from '@rxova/planner-core'

declare const judge: PlanJudge // `name`, and `judge(input)` returning a `Verdict`

const secrets = PROVIDERS.flatMap((p) => p.secretEnv)
const agents = PROVIDERS.filter((p) => ['codex', 'claude'].includes(p.id)).map((p) =>
  p.create({ env: process.env, omitEnv: secrets }),
)
const { plan, verdict, finalizer } = await new Planner(agents, judge).plan({
  task: 'Add rate limiting to the public API',
  cwd: process.cwd(),
  timeoutMs: 600_000,
})
```

A judge answers the questions `planQuestions` builds for each round: the stronger plan, the
finalizer, three scores, whether another pass would help, whether a plan stands alone, and a ruling
on each dispute. `judgedPlans` gives the plans the way a judge should be sent them.

## Make a CLI of it

```ts
#!/usr/bin/env node
import { main, processDeps } from '@rxova/planner-core'
import type { PlannerProgram } from '@rxova/planner-core'
import { MyJudge } from './my-judge.js'

const program: PlannerProgram = {
  name: 'my-planner',
  version: '1.0.0',
  summary: 'coding plans from two or more agents, judged by mine',
  judge: 'Mine',
  judgeModelDefault: 'mine-latest',
  judgeEnv: [{ variable: 'MY_JUDGE_KEY', check: 'Judge key', missing: 'MY_JUDGE_KEY is not set.' }],
}

void main(
  process.argv.slice(2),
  processDeps(program, () => new MyJudge()),
).then((code) => {
  process.exitCode = code
})
```

The program gets every flag jev-planner has, `doctor`, a `my-planner.json` config file and a
`.my-planner/` rounds folder. The judge's variables must be set before a run. `doctor` checks them,
and they are kept from every agent subprocess, along with every provider's key.

The flags, modes and config keys are documented at [jev-planner.com](https://jev-planner.com/). The
full API is in [`llms.txt`](llms.txt).

## License

MIT
