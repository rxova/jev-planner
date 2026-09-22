<p align="center">
  <img src="https://raw.githubusercontent.com/rxova/jev-planner/main/apps/docs/public/logo.svg" alt="jev-planner" width="320">
</p>

# jev-planner

`jev-planner` creates repository-aware implementation plans by combining two or more AIs with
[TypeSafe Jev](https://docs.typesafe.ai/concepts/system-one):

1. Each agent — Codex and Claude by default — drafts a plan independently, all in parallel.
2. Jev scores completeness, feasibility, and risk coverage; chooses a finalizer; and decides
   whether a cross-review would materially improve the plan.
3. When it would, each agent sees every other agent's plan and returns a revised, standalone plan,
   and Jev evaluates again — up to `--review-rounds` times.
4. The selected agent merges the plans into one final implementation plan, unless Jev judges one
   cross-reviewed plan final as it stands.

Steps 3 and 4 are the ones a run can skip, and skipping them is most of the wall clock: every agent
call is minutes, and they happen in sequence. See [Modes](#modes).

The cross-review is where a run gains the most. Drafts are written blind; reading each other's
plans, the agents correct each other's facts about the repository, drop the ideas that do not
survive a second opinion, take the other plan's strengths, and name the questions they still
disagree on. Compare `round1/` with `round2/` in a run folder to see it.
[How the cross-review improves a plan →](https://jev-planner.com/learn/how-it-works/#what-the-cross-review-improves)

**[Documentation →](https://jev-planner.com/)**

## Agents

Pick the agents with `--agents`, two or more, comma-separated:

| Id         | AI                                                                            | Kind      | Needs              |
| ---------- | ----------------------------------------------------------------------------- | --------- | ------------------ |
| `codex`    | [Codex CLI](https://learn.chatgpt.com/docs/non-interactive-mode)              | agent CLI | the CLI, logged in |
| `claude`   | [Claude Code](https://docs.anthropic.com/en/docs/claude-code/getting-started) | agent CLI | the CLI, logged in |
| `deepseek` | [DeepSeek](https://api-docs.deepseek.com)                                     | chat API  | `DEEPSEEK_API_KEY` |
| `kimi`     | [Kimi](https://platform.moonshot.ai) (Moonshot)                               | chat API  | `MOONSHOT_API_KEY` |
| `glm`      | [GLM](https://docs.z.ai) (Z.ai)                                               | chat API  | `ZAI_API_KEY`      |

`jev-planner --help` prints the same list, generated from the registry.

- **Agent CLIs** inspect the repository themselves, read-only: Codex runs in its read-only sandbox,
  Claude Code in plan mode with only `Read`, `Glob` and `Grep` and none of your MCP servers. They use
  the CLIs' existing logins, so their calls consume your Codex and Claude subscription allowances,
  not API keys.
- **Chat APIs** cannot open files. Each of their calls is sent with a snapshot of the repository:
  the list of files git tracks, and the contents of the tracked top-level docs and manifests
  (`AGENTS.md`, `CLAUDE.md`, `README.md`, `CONTRIBUTING.md`, `package.json`, …), within fixed size
  limits. Only tracked files are read, so an ignored `.env` is never sent. Outside a git repository
  the snapshot is empty. The model is told to name the files it would need rather than guess them.

Each agent keeps one conversation through a run. An agent CLI's draft session is continued for its
cross-review and the final synthesis (`codex exec resume`, `claude --resume`), so those stages start
with what it already read instead of exploring the repository again; a resumed Codex keeps its
read-only sandbox. A chat API is sent its earlier messages, so the repository snapshot goes once.
If a session cannot be continued, the call starts afresh with the whole prompt.

The CLIs keep those sessions as they keep any other: in `~/.codex/sessions` and
`~/.claude/projects`, and Claude's appear in its `/resume` list. `--no-resume` starts every call
afresh and keeps none, as before.

Every provider's API key, and Jev's, is removed from the environment of every agent subprocess:
an agent never sees another provider's credentials.

## Requirements

- Node.js 20 or newer
- For each agent CLI you select: the CLI, already logged in
- For each chat API you select: its API key in the environment
- A TypeSafe API key from <https://console.typesafe.ai/keys>

The implementation uses the official [`@typesafe-ai/sdk`](https://docs.typesafe.ai/sdk/javascript)
and defaults to the SDK's `jev-latest` model alias.

## Install

```sh
npm install -g jev-planner
export TYPESAFE_API_KEY="your-key"
jev-planner doctor
```

Or run it without installing: `npx jev-planner "<coding task>"`.

To run it from a clone of this repository instead:

```sh
npm install
npm run build
npm link
```

`doctor` checks the selected agents — each CLI is installed and logged in, each API key is set —
and the Jev key. `jev-planner doctor --agents codex,deepseek` checks that pair. It does not make a
paid model call.

## Use

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

Plan with three agents, and pin one's model:

```sh
jev-planner --agents claude,deepseek,glm --model glm=glm-4.6 "Add a CSV export to the reports page"
```

Use JSON in another tool:

```sh
jev-planner --json "Make image uploads resumable" | jq '.verdict, .plan'
```

See every option with `jev-planner --help`. Useful controls include:

- `--agents <ids>` to choose two or more agents (default: `codex,claude`).
- `--model <id>=<model>`, repeatable, to override one agent's model.
- `--effort <id>=<level>`, repeatable, to override an agent CLI's reasoning effort. Levels are the
  CLI's own (`low` … `xhigh` and more, per model) and are passed through unchecked.
- `--review-effort <id>=<level>`, repeatable, to use another effort for that agent's cross-reviews
  and synthesis only, while its draft keeps `--effort`. A lower one shortens the later stages, whose
  job is editing plans rather than exploring the repository.

Model and effort overrides win over the CLIs' local configuration, such as `model` and
`model_reasoning_effort` in `~/.codex/config.toml`, for that run only. Codex on GPT-5.6-Terra at low
effort, with Claude at its defaults:

```sh
jev-planner --model codex=gpt-5.6-terra --effort codex=low "Add caching to the search endpoint"
```

- `--jev-model` to pin a TypeSafe model rather than use `jev-latest`.
- `--finalizer <id>` to override Jev's routing decision with one of the selected agents.
- `--finalizer none` to keep the cross-reviewed plan Jev rates stronger as it is, rather than
  merge. It saves the last agent call, at the cost of the merge; on a tie, or when no cross-review
  ran, the finalizer still runs.
- `--mode ultra` to buy every round rather than let Jev skip one (below).
- `--review-rounds 0` to skip the cross-review entirely, or `1` to allow only one.
- `--straggler-grace <seconds>` to change how long a `balanced` round waits for a slow agent.
- `--no-resume` to start every agent call afresh rather than continue its draft session
  ([Agents](#agents)).
- `--verbose` to watch the agents work, then print Jev's typed verdict to stderr (below).
- `--rounds-dir <path>` to keep every round's plans somewhere other than `.jev-planner/`, or
  `--no-rounds` to keep none (below).
- `--allow-any-task` to plan text that looks like a placeholder.

A task that is empty or a near-certain placeholder — the text `TODO`, `TBD` or `<coding task>`,
an unfilled `<…>`, `{{…}}` or `[…]` slot, or text with no letters — is rejected before any paid
call. Only the whole text is compared, so a brief that quotes a placeholder, or a short real task
such as `Add caching`, is planned as usual. `Planner.plan` runs the same check and throws
`TaskValidationError`; set `allowAnyTask: true` in its options to skip it.

## Modes

A run's wall clock is not the number of agent calls — the agents in a round run in parallel — but
the number of rounds, because each one waits for the round before it. `--mode` decides how many a
run is allowed to spend.

| `--mode`             | Cross-review                     | Final merge                        | Agent calls, N agents | Rounds |
| -------------------- | -------------------------------- | ---------------------------------- | --------------------- | ------ |
| `balanced` (default) | Only when Jev asks for one       | Skipped when one plan stands alone | N + 1 … 3N + 1        | 2 … 4  |
| `ultra`              | Always, plus Jev's optional pass | Always                             | 2N + 1, or 3N + 1     | 3 or 4 |

With the default two agents, that is three agent calls in two rounds where `ultra` spends
five in three.

`balanced` puts Jev's typed judgment in front of each round instead of after it:

- **The cross-review is Jev's to order.** It judges the drafts first, and the agents only revise
  against each other when Jev answers that another pass would materially improve the plan. When the
  drafts already agree, that is a whole round of agent calls a run does not make.
- **The merge is Jev's to waive.** After a cross-review every plan already answers the others, so
  when Jev judges the strongest one final as it stands, the run answers with it rather than paying
  an agent to rewrite it. A plan that has _not_ been cross-reviewed is never adopted this way: the
  merge is the only place the agents' material comes together, so it always runs.
- **A round stops waiting for a straggler.** Once half the agents have answered, the rest get
  `--straggler-grace` seconds (90 by default) before the round goes on without them, and their calls
  are aborted rather than left running. A round never drops below two plans, so with two agents a
  draft is always waited for; an agent dropped from a cross-review keeps its previous plan.

`ultra` runs every step, every time: every agent drafts, every agent reviews every other, Jev may ask
for one more pass, and the finalizer always merges. Use it when the plan matters more than the wait.

Every run prints what it spent on stderr, and `--json` includes it as `cost`:

```text
[jev-planner] balanced mode, 3 agent calls, 1 Jev call, 0 cross-review rounds, merged
```

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
      jev-verdict.json  in balanced mode; ultra judges only reviewed plans
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

`--rounds-dir <path>` writes them somewhere else instead, relative to `--cwd`; that folder must be
new or empty, so two runs never mix. `--no-rounds` writes nothing.

```sh
jev-planner --rounds-dir rounds -o PLAN.md "Add caching to the search endpoint"
```

From code, `onRound` in `Planner.plan`'s options receives the same rounds as `PlanRound` objects.

## Watching the agents work

A draft can take minutes. `--verbose` streams what each agent is doing to stderr as it happens, one
line per step, prefixed with the agent:

```text
[jev-planner] Drafting independent plans with Codex and Claude…
[claude] Grep deploy|pages
[codex] I'll inspect the docs app and the workflows first.
[codex] $ /bin/zsh -lc "ls apps/docs .github/workflows"
[claude] Read apps/docs/astro.config.mjs
```

Codex and Claude run with JSON event output (`codex exec --json`, `claude --output-format
stream-json`), so every message, command and file read is shown as the agent reaches it. A chat API
agent answers in one response, so it shows only which model it is waiting on. From code, pass
`onAgentProgress` in `Planner.plan`'s options.

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

## Cost and data flow

With N agents, `--mode ultra` makes 2N + 1 agent calls: N drafts, N cross-reviews, and one final
synthesis. If Jev requests another pass, it makes N more. With the default two agents that is five
calls, or seven. `--mode balanced`, the default, makes as few as N + 1 — the drafts and the merge, when
Jev asks for no cross-review — and never more than `ultra` would. `--finalizer none` drops the
synthesis when Jev rates one cross-reviewed plan stronger. Agent CLIs use the accounts logged into
them; chat APIs bill the key they are given.

Each evaluation uses one TypeSafe API call, and `balanced` spends one extra to judge the drafts. Jev sees
the task and the agents' plan text, not a direct repository snapshot. Chat APIs see the snapshot
described under [Agents](#agents), and every agent sees the other agents' plans, which may contain
file names or code details. Do not run this on material you are not allowed to send to every
provider you select.

## Adding a new AI

Every agent comes from one list, `PROVIDERS` in `src/providers.ts`. The CLI flags, `--help`,
`doctor`, the prompts and Jev's choices are all built from it, so adding an AI is one entry there.

An OpenAI-compatible chat API — most are — is one `openAICompatibleProvider` call:

```ts
openAICompatibleProvider({
  id: 'qwen',
  label: 'Qwen',
  baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  apiKeyEnv: 'DASHSCOPE_API_KEY',
  model: 'qwen-max',
}),
```

An agent CLI that can run non-interactively and read-only, taking the prompt on stdin and printing
the plan on stdout, is one `cliProvider` call:

```ts
cliProvider({
  id: 'acme',
  label: 'Acme',
  command: 'acme',
  // Whatever makes this CLI answer once, read-only, without prompting.
  args: ({ model, effort }) => [
    'ask',
    '--read-only',
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
  ],
  effort: true,
  auth: ['whoami'],
}),
```

`effort: true` says `args` passes an effort on, so `--effort` is accepted for it. `auth` is
optional: arguments that exit 0 when the CLI is logged in, or a check function. So is `sessions`,
for a CLI that can continue a conversation: `start(overrides, id)` and `resume(overrides, id)`
return the arguments that keep one and continue it, and without it every call starts afresh. The same
two builders are exported, so a program using the library can build its own agents from them and
pass them to `Planner`.

## Development

```sh
npm run check
npm run build
node dist/bin.mjs --help
```

The orchestration tests use fake agents and make no model calls.

## Why Jev is the arbiter

Jev does not generate prose or code. It returns constrained `choice`, `score`, and `noul` decisions
with probabilities. That makes it a good fit for the branch points in this workflow—quality scoring,
review routing, and finalizer selection—while the agents handle repository exploration and plan
writing.

## License

MIT
