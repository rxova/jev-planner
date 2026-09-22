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

Steps 3 and 4 are the ones a run can skip, and skipping them is most of the wall clock: the agents
in a step run in parallel, but each step waits for the one before, and a step waits for its slowest
agent. In the runs on [Modes compared](https://jev-planner.com/learn/modes-compared/) a step took
from under a minute to four. See [Modes](#modes).

The cross-review is what those steps buy. Drafts are written blind; reading each other's plans, the
agents can correct each other's facts about the repository, drop the ideas that do not survive a
second opinion, take the other plan's strengths, and name the questions they still disagree on. In
the debate run on Modes compared, 7 of the 10 objections were about the repository, and all 10 were
accepted. Compare `round1/` with `round2/` in a run folder to see it in yours.
[How the cross-review improves a plan →](https://jev-planner.com/learn/how-it-works/#what-the-cross-review-improves)

The planner itself is [`packages/core`](https://github.com/rxova/jev-planner/tree/main/packages/core#readme),
an internal package bundled into this one; jev-planner adds Jev, TypeSafe's typed judge, and the
`jev-planner` command.

**[Documentation →](https://jev-planner.com/)**

## Agents

Pick the agents with `--agents`, two or more, comma-separated. One provider can be two of them,
under different names; see [one provider, several agents](#one-provider-several-agents).

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

## One provider, several agents

An agent is a provider under a name. `--agents codex` is short for `codex:codex`, and
`--agents codex:sol,codex:terra` runs Codex twice, as two agents named `sol` and `terra`. Each has
its own session, draft and round files (`round1/sol.md`), and the overrides take the name:

```sh
jev-planner --agents codex:sol,codex:terra \
  --model sol=gpt-5.6-sol --model terra=gpt-5.6-terra "Add caching to the search endpoint"
```

- **Names** are a letter, then letters, digits or `-`, at most 24 characters, read lowercased. A
  name cannot be `auto`, `none`, `tie`, a Windows device name (`con`, `nul`, …) or another
  provider's id.
- **Labels** tell them apart: the output, the peer reviews and Jev see `Codex (sol)` and
  `Codex (terra)`.
- **Vary them.** Two agents with the same provider, model and effort get a warning on stderr, since
  their drafts may barely differ; the run still goes ahead.
- **Name the one you mean.** Once a provider's agents are named, `--model codex=…` is an error that
  lists them.
- **One quota.** Both draw on the same subscription or key, at the same time. A rate limit (HTTP 429) fails the call, and a failed call fails the run.
- `doctor` checks each provider once.

The CLIs keep those sessions as they keep any other: in `~/.codex/sessions` and
`~/.claude/projects`, and Claude's appear in its `/resume` list. `--no-resume` starts every call
afresh and keeps none, as before.

Every provider's API key, and Jev's, is removed from the environment of every agent subprocess:
an agent never sees another provider's credentials.

## Requirements

- Node.js 20.19 or newer
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
corepack enable
pnpm install
pnpm build
node packages/jev-planner/dist/bin.mjs --help
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

- `--agents <provider[:name],…>` to choose two or more agents (default: `codex,claude`).
- `--model <name>=<model>`, repeatable, to override one agent's model.
- `--effort <name>=<level>`, repeatable, to override an agent CLI's reasoning effort. Levels are the
  CLI's own (`low` … `xhigh` and more, per model) and are passed through unchecked.
- `--review-effort <name>=<level>`, repeatable, to use another effort for that agent's cross-reviews
  and synthesis only, while its draft keeps `--effort`. The later stages edit plans rather than
  explore the repository, so a lower effort is meant to make them quicker; that is not measured.

Model and effort overrides win over the CLIs' local configuration, such as `model` and
`model_reasoning_effort` in `~/.codex/config.toml`, for that run only. Codex on GPT-5.6-Terra at low
effort, with Claude at its defaults:

```sh
jev-planner --model codex=gpt-5.6-terra --effort codex=low "Add caching to the search endpoint"
```

- `--judge-model` to pin a TypeSafe model rather than use `jev-latest`.
- `--finalizer <name>` to override Jev's routing decision with one of the selected agents.
- `--finalizer none` to keep the cross-reviewed plan Jev rates stronger as it is, rather than
  merge. It saves the last agent call, at the cost of the merge; on a tie, or when no cross-review
  ran, the finalizer still runs.
- `--mode ultra` to always run the first cross-review rather than let Jev skip it, or `--mode fast`
  to answer with the first draft Jev accepts on its own (below).
- `--review-rounds 0` to skip the cross-review entirely, or `1` to allow only one.
- `--straggler-grace <seconds>` to change how long a `balanced` or `fast` round waits for a slow
  agent.
- `--review-mode debate` to have the agents critique and answer each other, and Jev rule on what
  they still disagree about; `--claim-checks` to check the disputed repository claims too (below).
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

## Config file

A `jev-planner.json` in the repository, the `--cwd` folder or the current one, sets up every run
from there. `--config <path>` reads another file, `--no-config` none. It is for the CLI only;
`Planner` never reads it.

```json
{
  "$schema": "https://jev-planner.com/config.schema.json",
  "agents": { "codex": { "model": "gpt-5.6-sol", "effort": "high" }, "claude": {} },
  "mode": "ultra",
  "runsDir": "planner-runs",
  "output": "PLAN.md"
}
```

Each key stands for the flag of the same name: `agents` with each agent's `model`, `effort` and
`reviewEffort`, keyed by provider id or by a name that sets `provider`
(`"sol": { "provider": "codex" }`); `mode`, `reviewMode`, `reviewRounds`, `claimChecks`, `finalizer`, `judgeModel`,
`stragglerGrace` and `timeout` (seconds); `resume`, `rounds`, `json`, `verbose` and
`allowAnyTask`; `output`; `task` or `taskFile`; and `cwd`, only in a file passed with `--config`.
`runsDir` is a folder in which each run gets its own timestamped folder. Paths are relative to the
file, and an unknown key or a wrong type is an error that names the key.

- **Flags win**, setting by setting. `--model codex=gpt-x` beats the config's model for Codex only,
  `--agents` drops the config's settings for the agents it leaves out, and every boolean has both
  forms: `--json` and `--no-json`, `--resume` and `--no-resume`, and so on.
- **The task**: arguments or `--file` first, then the config's `task` or `taskFile`, then stdin. A
  task piped while the config has one is an error, never silently ignored.
- **No secrets.** The file is meant to be committed. A key such as `apiKey` or `token` is rejected
  with the environment variable to set instead.

The schema ships as `node_modules/jev-planner/config.schema.json` too. The
[config file guide](https://jev-planner.com/guides/config-file/) has the full table.

## Modes

A run's wall clock is not the number of agent calls — the agents in a round run in parallel — but
the number of rounds, because each one waits for the round before it. `--mode` decides how many a
run is allowed to spend.

| `--mode`             | Cross-review                     | Final merge                               | Agent calls, N agents | Rounds |
| -------------------- | -------------------------------- | ----------------------------------------- | --------------------- | ------ |
| `fast`               | Never                            | Skipped when one draft stands alone       | N … N + 1             | 1 or 2 |
| `balanced` (default) | Only when Jev asks for one       | Skipped when a reviewed plan stands alone | N + 1 … 3N + 1        | 2 … 4  |
| `ultra`              | Always, plus Jev's optional pass | Always, unless `--finalizer none`         | 2N + 1, or 3N + 1     | 3 or 4 |

At best, with the default two agents, `balanced` spends three agent calls in two rounds where `ultra`
spends five in three. When Jev asks for both reviews, it spends what `ultra` does.

`balanced` puts Jev's typed judgment in front of each round instead of after it:

- **The cross-review is Jev's to order.** It judges the drafts first, and the agents only revise
  against each other when Jev rates the chance that another pass would materially improve the plan
  at 0.65 or more. Below that, it is a whole round of agent calls the run does not make.
- **The merge is Jev's to waive.** After a cross-review every plan already answers the others, so
  when Jev judges the strongest one final as it stands, the run answers with it rather than paying
  an agent to rewrite it. A plan that has _not_ been cross-reviewed is never adopted this way: the
  merge is the only place the agents' material comes together, so it always runs.
- **A round stops waiting for a straggler.** Once half the agents (rounded up) have answered, the rest get
  `--straggler-grace` seconds (90 by default) before the round goes on without them, and their calls
  are aborted rather than left running. A round never drops below two plans, so with two agents a
  draft is always waited for; an agent dropped from a cross-review keeps its previous plan.

`ultra` always runs the first cross-review: every agent drafts, and every agent reviews every other,
whatever the drafts turned out to be. Jev may ask for one more pass, and the finalizer merges, unless
`--finalizer none` keeps the reviewed plan Jev rates stronger. `--review-rounds 0` removes the review.
Use it when the plan matters more than the wait.

`fast` spends the fewest rounds, and pays for it in scrutiny:

- **Jev judges each draft alone, as it arrives.** One at a time, in the order the agents answer,
  Jev is asked whether that plan could go to an implementer as it stands. The first one it rates
  at 0.5 or more is the answer, and the agents still drafting are stopped.
- **Otherwise it is `balanced` without the cross-review.** When Jev accepts no draft, it judges
  them together and the finalizer merges them; no agent reviews another's plan.
- **It favours the quickest agent.** Whichever agent answers first is judged first, so a quick
  plan that clears the bar beats a slower, better one nobody waited for.
- **An accepted plan was read by no other agent.** Nothing in it has been challenged; use `fast`
  for tasks where a single good plan is enough.
- **Stopped work is still paid for.** An agent aborted mid-draft has already spent what it used,
  and it counts as an agent call.

Each draft Jev judges alone is one TypeSafe call, so `fast` makes 1 … N + 1 of them. It has no
review round, so `--review-mode debate` and `--claim-checks` are rejected with it, and
`--review-rounds` is ignored. `--finalizer` only picks who merges when no draft is accepted.

[Modes compared](https://jev-planner.com/learn/modes-compared/) plans one real task in every mode,
with the time, rounds, calls and Jev's verdicts of each.

Every run prints what it spent on stderr, and `--json` includes it as `cost`:

```text
[jev-planner] balanced mode, 3 agent calls, 1 Jev call, 0 cross-review rounds, merged
```

A `fast` run that answers with an accepted draft ends with `selected`, and names the agents it
stopped:

```text
[jev-planner] fast mode, 2 agent calls, 1 Jev call, 0 cross-review rounds, selected, not waited for: codex
```

### Debate review (experimental)

`--review-mode debate` replaces the first cross-review with an exchange Jev can rule on. `balanced`
and `ultra` run it where they would run a cross-review; `fast` has none, and rejects it:

1. **Critiques.** Each agent lists numbered objections to every other plan, at most five per plan,
   and tags the ones that make a claim about the repository `[repo]`. It writes no plan.
2. **Replies.** Each author accepts or rejects every objection to its own plan, by id, and returns
   its revised plan.
3. **Disputes.** The rejected objections become disputes, the same claim against the same plan
   merged whoever raised it. Jev rules on up to eight of them, critic, author or unclear, in the
   same call as its usual verdict.
4. **A targeted pass.** When Jev asks for another pass, the agents revise against the disputes it
   left open, not the whole verdict. The merge sees every dispute and its ruling.

`--claim-checks` (which implies `--review-mode debate`) adds a step before Jev rules: each disputed
`[repo]` claim goes to an agent that reads the repository and did not raise it, which answers
CONFIRM, REFUTE or UNKNOWN with the file that shows it. It needs two agent CLIs among the agents; a
chat API sees only a snapshot, so with fewer the checks are skipped and the run says so.

A debate costs 2N agent calls where a cross-review costs N, plus one call per agent that checks a
claim. It never runs with `--review-rounds 0`. The rounds folder keeps each critique, reply and check
as `<agent>.critique.md`, `.reply.md` and `.check.md`, beside `objections.json`, `replies.json` and
`disputes.json`; from code, `PlanRound.debate` and `PlanResult.debate` carry the same.

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
      verdict.json  in balanced and fast mode; ultra judges only reviewed plans
      timings.json    how long the round and each call in it took, in milliseconds
    round2/           only when a cross-review ran: the revised plans, and Jev's verdict
      codex.md
      claude.md
      verdict.json
    round3/           only when Jev asked for a second review
    final/
      plan.md         the merged plan, headed by the agent that merged it, or selected from
      verdict.json  the verdict the merge followed
```

In `fast` mode, `round1/verdict.json` is the verdict that decided the run: the accepted draft's,
or the one Jev gave the drafts together. The verdicts of drafts it turned down alone are not saved.
A debate names its rounds' files differently ([Debate review](#debate-review-experimental)).

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
total at the end. These are the rounds of the `ultra` run on Modes compared:

```text
[jev-planner] Drafts: 2m58s (Claude 1m18s, Codex 2m58s)
[jev-planner] Review: 1m20s (Claude 1m01s, Codex 1m18s, Jev 1.4s)
[jev-planner] Review: 1m25s (Claude 1m04s, Codex 1m24s, Jev 1.2s)
[jev-planner] Final plan: 54s (Claude 54s)
```

The same numbers, in milliseconds, are in each round's `timings.json`, in `--json`'s `timings`,
and in `PlanRound.timings` and `PlanResult.timings` from code.

## Cost and data flow

With N agents, `--mode ultra` makes 2N + 1 agent calls: N drafts, N cross-reviews, and one final
synthesis. If Jev requests another pass, it makes N more. With the default two agents that is five
calls, or seven. `--mode balanced`, the default, makes as few as N + 1 — the drafts and the merge, when
Jev asks for no cross-review — and never more than `ultra` would. `--mode fast` makes N, or N + 1
when it has to merge; an agent it stops mid-draft still counts, and still bills what it used. `--finalizer none` drops the
synthesis when Jev rates one cross-reviewed plan stronger. Agent CLIs use the accounts logged into
them; chat APIs bill the key they are given.

Each evaluation uses one TypeSafe API call, and `balanced` spends one extra to judge the drafts;
`fast` spends one per draft it judges alone, plus one to judge them together when it accepts none. Jev sees
the task and the agents' plan text, not a direct repository snapshot. Chat APIs see the snapshot
described under [Agents](#agents). Every agent that cross-reviews, checks a claim or merges sees the
other agents' plans, which may contain file names or code details; a draft `fast` accepts is read by
no other agent. Do not run this on material you are not allowed to send to every
provider you select.

## Adding a new AI

Every agent comes from one list, `PROVIDERS` in `packages/core/src/providers/providers.ts`. The CLI flags, `--help`,
`doctor`, the prompts and Jev's choices are all built from it, so wiring up a new AI is one entry
there. Add the agent to `config.schema.json` too, and to its copy in `apps/docs/public/`: a test
fails until both list it.

An OpenAI-compatible chat API is one `openAICompatibleProvider` call:

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
return the arguments that keep one and continue it, and without it every call starts afresh. Both builders are
exported by this package, so a program using the library can build its own agents from them and
pass them to `Planner`.

## Development

```sh
pnpm --filter jev-planner test
pnpm run verify
```

The orchestration tests use fake agents and make no model calls.
[CONTRIBUTING.md](https://github.com/rxova/jev-planner/blob/main/CONTRIBUTING.md) has the rest.

## Why Jev is the arbiter

Jev does not generate prose or code. It returns constrained `choice`, `score`, and `noul` decisions
with probabilities. That makes it a good fit for the branch points in this workflow—quality scoring,
review routing, and finalizer selection—while the agents handle repository exploration and plan
writing.

## License

MIT
