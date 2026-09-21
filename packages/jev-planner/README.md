# jev-planner

`jev-planner` creates repository-aware implementation plans by combining two coding agents with
[TypeSafe Jev](https://docs.typesafe.ai/concepts/system-one):

1. Codex and Claude independently inspect the repository and draft plans in parallel.
2. Each agent sees the other's draft and returns a revised, standalone plan.
3. Jev scores completeness, feasibility, and risk coverage; chooses a finalizer; and decides
   whether the plans need one more cross-review.
4. The selected agent merges the revised drafts into one final implementation plan.

Codex and Claude run read-only. The tool uses the existing CLI logins, so their calls consume your
Codex and Claude subscription allowances instead of OpenAI or Anthropic API keys. Jev is a separate
service and requires its own API key. That key is removed from the environment inherited by the two
coding-agent subprocesses.

## Requirements

- Node.js 20 or newer
- [Codex CLI](https://learn.chatgpt.com/docs/non-interactive-mode), already logged in
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code/getting-started), already logged in
- A TypeSafe API key from <https://console.typesafe.ai/keys>

The implementation uses the official [`@typesafe-ai/sdk`](https://docs.typesafe.ai/sdk/javascript)
and defaults to the SDK's `jev-latest` model alias.

## Install locally

```sh
npm install
npm run build
npm link
export TYPESAFE_API_KEY="your-key"
jev-planner doctor
```

`doctor` verifies that both CLIs are installed and authenticated and that the Jev environment
variable exists. It does not make a paid model call.

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

Use JSON in another tool:

```sh
jev-planner --json "Make image uploads resumable" | jq '.verdict, .plan'
```

See every option with `jev-planner --help`. Useful controls include:

- `--codex-model` and `--claude-model` to override each CLI's configured/default model.
- `--jev-model` to pin a TypeSafe model rather than use `jev-latest`.
- `--finalizer codex|claude` to override Jev's routing decision.
- `--review-rounds 1` to disable Jev's optional second review pass.
- `--verbose` to print Jev's typed verdict to stderr.
- `--allow-any-task` to plan text that looks like a placeholder.

A task that is empty or a near-certain placeholder — the text `TODO`, `TBD` or `<coding task>`,
an unfilled `<…>`, `{{…}}` or `[…]` slot, or text with no letters — is rejected before any paid
call. Only the whole text is compared, so a brief that quotes a placeholder, or a short real task
such as `Add caching`, is planned as usual. `Planner.plan` runs the same check and throws
`TaskValidationError`; set `allowAnyTask: true` in its options to skip it.

## Cost and data flow

A normal run makes five coding-agent calls: two initial drafts, two cross-reviews, and one final
synthesis. If Jev requests another pass, it makes two more coding-agent calls. Codex and Claude calls
use the accounts currently logged into their respective CLIs.

Each evaluation uses one TypeSafe API call; a second review pass causes one re-evaluation. Jev sees
the task and the agents' plan text, not a direct repository snapshot. Nevertheless, plan text may
contain file names or code details. Do not run this on material you are not allowed to send to all
three providers.

## Development

```sh
npm run check
npm run build
node dist/cli.js --help
```

The orchestration tests use fake agents and make no model calls.

## Why Jev is the arbiter

Jev does not generate prose or code. It returns constrained `choice`, `score`, and `noul` decisions
with probabilities. That makes it a good fit for the branch points in this workflow—quality scoring,
review routing, and finalizer selection—while Codex and Claude handle repository exploration and
plan writing.

## License

MIT
