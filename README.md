<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./apps/docs/src/assets/logo-dark.svg">
    <img src="./apps/docs/public/logo.svg" alt="jev-planner" width="420">
  </picture>
</p>

<p align="center">
  <strong>BIG TASK. MULTIPLE BRAINS. ONE PLAN.</strong>
</p>

<p align="center">
  Repository-aware implementation plans from AIs that challenge each other,<br>
  with <a href="https://docs.typesafe.ai/concepts/system-one">TypeSafe Jev</a> making the final call.
</p>

---

## Why jev-planner?

A single AI can produce a confident but incomplete plan. `jev-planner` builds disagreement into the
process before implementation starts:

1. Two or more agents inspect the repository and draft plans independently.
2. Jev scores completeness, feasibility, and risk coverage, and decides whether a cross-review
   would improve the plans.
3. When it would, the agents review one another's work and revise their own plans, correcting
   each other's facts and dropping the ideas that do not survive a second opinion
   ([how it helps](https://jev-planner.com/learn/how-it-works/#what-the-cross-review-improves)).
4. Jev selects a finalizer, which merges the strongest ideas into one plan — unless one reviewed
   plan already stands alone.

```text
                         ┌─ Codex ──► draft ──┐
TASK + REPOSITORY ───────┤                    ├─► JEV EVALUATION
                         └─ Claude ─► draft ──┘      │        ▲
                                                     │        │
                                        only if Jev asks ─► CROSS-REVIEW
                                                     │
                                                     ▼
                                               ONE FINAL PLAN
```

Codex and Claude are the defaults. DeepSeek, Kimi, and GLM are supported too.

## Quick start

You need Node.js 20.19 or newer, credentials for at least two agents, and a
[TypeSafe API key](https://console.typesafe.ai/keys).

```sh
npm install -g jev-planner
export TYPESAFE_API_KEY="your-key"
jev-planner doctor
```

Run it from the repository you want the agents to inspect:

```sh
jev-planner "Add per-user rate limiting to the public API"
```

Write the result to a file:

```sh
jev-planner -o PLAN.md "Migrate persistence from SQLite to Postgres"
```

Or run without installing:

```sh
npx jev-planner "Make image uploads resumable"
```

## Choose the agents

| Agent      | Type      | Requirement                    |
| ---------- | --------- | ------------------------------ |
| `codex`    | agent CLI | Codex CLI, already logged in   |
| `claude`   | agent CLI | Claude Code, already logged in |
| `deepseek` | chat API  | `DEEPSEEK_API_KEY`             |
| `kimi`     | chat API  | `MOONSHOT_API_KEY`             |
| `glm`      | chat API  | `ZAI_API_KEY`                  |

Use any two or more, and override models when needed:

```sh
jev-planner \
  --agents claude,deepseek,glm \
  --model glm=glm-4.6 \
  "Add CSV export to reports"
```

Agent CLIs also accept per-run reasoning effort overrides:

```sh
jev-planner \
  --model codex=gpt-5.6-terra \
  --effort codex=low \
  "Add caching to search"
```

## Useful controls

- `--verbose` streams agent messages, commands, and file reads as they happen.
- Every draft, review, and Jev verdict is saved under `.jev-planner/<run>/`; `--rounds-dir <path>`
  moves it, `--no-rounds` skips it.
- `--json` emits structured output for another tool.
- `--mode ultra` runs every round, every time; the default `fast` lets Jev skip the ones a plan
  does not need ([fast or ultra](https://jev-planner.com/learn/how-it-works/#fast-or-ultra-in-short)).
- `--finalizer <agent>` overrides Jev's finalizer choice; `none` keeps the stronger plan unmerged.
- `--review-rounds <0|1|2>` caps the cross-reviews; `0` skips them.

```text
.jev-planner/20260921-230512/
  round1/          independent drafts (+ Jev verdict in fast mode)
  round2/          cross-reviewed plans + Jev verdict, when a review ran
  round3/          optional second review
  final/plan.md    merged, or selected, implementation plan
```

## Cost and data flow

With **N** agents, `--mode ultra` makes **2N + 1** agent calls: drafts, reviews, and final
synthesis, plus **N** if Jev requests another review. The default `fast` makes as few as **N + 1**
and never more than `ultra`. Each Jev evaluation is a separate TypeSafe call.

Agent CLIs inspect the repository in read-only mode. Chat APIs receive a bounded snapshot of tracked
filenames and top-level project docs. Ignored `.env` files are not read, and provider keys are
removed from every agent subprocess.

Only use providers that are allowed to see the repository material you send them. See the
[full cost and data-flow guide](https://jev-planner.com/guides/cost-and-data-flow/).

## Why Jev?

Jev does not write the plan. It returns constrained choices, scores, and confidence for the workflow's
branch points: whether a plan is strong enough, whether another review is needed, and which agent
should finish. The agents explore and write; Jev evaluates.

## Documentation

- [Guides and reference](https://jev-planner.com/)
- [Complete package README](packages/jev-planner/README.md)
- [Agent-readable reference](packages/jev-planner/llms.txt)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## License

MIT © 2026 [Jonatan Kruszewski (rxova)](https://github.com/rxova). See [LICENSE](LICENSE).
