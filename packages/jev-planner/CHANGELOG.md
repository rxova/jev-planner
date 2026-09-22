# jev-planner

## 0.1.0

### Minor Changes

- [#1](https://github.com/rxova/jev-planner/pull/1) [`30f60bf`](https://github.com/rxova/jev-planner/commit/30f60bfefc120fbcd1753f3cb3a299e17605367c) Thanks [@jonatankruszewski](https://github.com/jonatankruszewski)! - Add `--effort <id>=<level>` to override an agent CLI's reasoning effort for the run, over its local configuration: Codex gets `-c model_reasoning_effort=…`, Claude Code `--effort`. `cliProvider`'s `args` now receives `{ model, effort }`, and a `Provider` says whether it takes an effort.

- [#1](https://github.com/rxova/jev-planner/pull/1) [`0bf6e55`](https://github.com/rxova/jev-planner/commit/0bf6e55be5653dc6eca5c26a31f5b02ba849d9ea) Thanks [@jonatankruszewski](https://github.com/jonatankruszewski)! - `--verbose` streams each agent's work as it happens, one `[agent]` line per message, command or file read. Codex and Claude now run with JSON event output; `cliProvider` takes `events` to read such a CLI, and `PlanOptions.onAgentProgress` / `AgentRequest.onProgress` carry the lines from code.

- [#1](https://github.com/rxova/jev-planner/pull/1) [`ea9d32e`](https://github.com/rxova/jev-planner/commit/ea9d32e5c300a87f860a70637147f2c5fd9ff4af) Thanks [@jonatankruszewski](https://github.com/jonatankruszewski)! - Each agent now keeps one conversation through a run. Codex and Claude Code continue their draft session for the cross-review and the final synthesis (`codex exec resume`, still in the read-only sandbox; `claude --resume`), so those stages no longer start cold and explore the repository again; chat API agents are sent their earlier messages, so the repository snapshot goes once. The later prompts leave out what the conversation already holds. This changes the default: the sessions are kept in `~/.codex/sessions` and `~/.claude/projects` like any other, and Claude's appear in `/resume`. `--no-resume` (`resume: false` in `PlanOptions`) restores the old behaviour. A session that cannot be continued falls back to a fresh call. New in the API: `AgentSession`, `AgentRequest.session` and `resumePrompt`, and `CliProviderConfig.sessions`.

- [#1](https://github.com/rxova/jev-planner/pull/1) [`5a8086d`](https://github.com/rxova/jev-planner/commit/5a8086d5e26bc0148528d1140998ecfce0d23332) Thanks [@jonatankruszewski](https://github.com/jonatankruszewski)! - Plan with any two or more AIs, not only Codex and Claude. `--agents` picks them from a registry that adds DeepSeek, Kimi (Moonshot) and GLM (Z.ai) through a generic OpenAI-compatible adapter, which sends chat APIs a snapshot of the tracked files and top-level docs. `--model <id>=<model>` replaces `--codex-model` and `--claude-model`, and `--finalizer` takes any selected agent. Every provider's API key is stripped from every agent subprocess. Breaking for the library: `CodexAgent` and `ClaudeAgent` are replaced by `PROVIDERS`, `cliProvider` and `openAICompatibleProvider`; `Planner` takes an array of agents; `AgentName` is a string; `PlanningAgent` gains `label`; `JevJudge.judge` takes `plans`; `runDoctor` takes the providers to check.

- [#1](https://github.com/rxova/jev-planner/pull/1) [`c4ce308`](https://github.com/rxova/jev-planner/commit/c4ce30853956630d2ac90b04ac555a8c48bbac2e) Thanks [@jonatankruszewski](https://github.com/jonatankruszewski)! - The CLI reads a run's setup from `jev-planner.json` in the repository, or from `--config <path>`; `--no-config` reads none. Its keys follow the flags (`agents` with each agent's `model`, `effort` and `reviewEffort`, `mode`, `reviewMode`, `task`, …), plus `runsDir`, a reusable parent folder for the run folders. A flag given on the command line wins, and every boolean now has both forms (`--json` / `--no-json`, `--resume` / `--no-resume`, …). A task piped on stdin while the config has one is an error. The file never holds a key, and the package ships `config.schema.json` for editors. The file is found automatically, so an unrelated `jev-planner.json` already in a repository is now read: pass `--no-config` to skip it. `Planner` and the library API are unchanged.

- [#1](https://github.com/rxova/jev-planner/pull/1) [`88aed41`](https://github.com/rxova/jev-planner/commit/88aed41bae75f935f66e84b5a1eca5a4042de010) Thanks [@jonatankruszewski](https://github.com/jonatankruszewski)! - Add an experimental debate review: `--review-mode debate` (`reviewMode: 'debate'`) runs the first review as critiques and replies. Each agent lists numbered objections to every other plan, each author accepts or rejects the ones to its own and revises it, and Jev rules on the rejected ones in its usual call; later passes and the final synthesis work from those rulings. `--claim-checks` (`claimChecks: true`) has agent CLIs check the disputed claims about the repository before Jev rules. The rounds folder gains `objections.json`, `replies.json` and `disputes.json`. New in the API: `ReviewMode`, `Objection`, `Reply`, `ClaimCheck`, `Dispute`, `DisputeRuling`, `RoundDebate`, `PlanningAgent.readsRepository`, `JevVerdict.disputes`, and `PlanResult.debate`. `PlanRound.stage` gains `critique`, `reply` and `check`, and `PlanCost.reviewMode` is always set, so an exhaustive `switch` on the stage needs the new cases.

- [#1](https://github.com/rxova/jev-planner/pull/1) [`ea9d32e`](https://github.com/rxova/jev-planner/commit/ea9d32e5c300a87f860a70637147f2c5fd9ff4af) Thanks [@jonatankruszewski](https://github.com/jonatankruszewski)! - Save every run's rounds by default, to a new `.jev-planner/<UTC start time>/` folder in the repository, which a `.gitignore` inside `.jev-planner/` keeps out of git. `--rounds-dir <path>` still chooses the folder, and the new `--no-rounds` writes none.

- [#1](https://github.com/rxova/jev-planner/pull/1) [`ea9d32e`](https://github.com/rxova/jev-planner/commit/ea9d32e5c300a87f860a70637147f2c5fd9ff4af) Thanks [@jonatankruszewski](https://github.com/jonatankruszewski)! - Add `--finalizer none` to skip the synthesis call when Jev rates one cross-reviewed plan stronger, and return that plan as it is; on a tie, or when no cross-review ran, the finalizer still merges. From code, `PlanOptions.selectStronger`; `PlanResult.selected` and `PlanRound.selected` mark a selected plan, and `final/plan.md` is headed `<!-- selected from <agent> -->`.

- [#1](https://github.com/rxova/jev-planner/pull/1) [`29249ed`](https://github.com/rxova/jev-planner/commit/29249ed424a881e77a548d2a76b9726e41b88ad1) Thanks [@jonatankruszewski](https://github.com/jonatankruszewski)! - Reject an empty or placeholder task before any paid call, with `--allow-any-task` (`allowAnyTask` in `PlanOptions`) to plan it anyway; `Planner.plan` throws the new `TaskValidationError`. The planning prompts now ask for clarifying questions when a task is too vague to act on.

- [#1](https://github.com/rxova/jev-planner/pull/1) [`05b5ed3`](https://github.com/rxova/jev-planner/commit/05b5ed344231802367a56426e9282199bb4214d5) Thanks [@jonatankruszewski](https://github.com/jonatankruszewski)! - Move the planner, its providers and its CLI into an internal package, bundled into jev-planner, which still exports the planner, the providers and the types. The judge is named neutrally throughout: `JevJudge` is `PlanJudge` (which gains `name`), `JevVerdict` is `Verdict`, `jevModel`/`--jev-model` are `judgeModel`/`--judge-model`, `jevCalls` and `jevMs` are `judgeCalls` and `judgeMs`, and a round's `jev-verdict.json` is `verdict.json`.

- [#1](https://github.com/rxova/jev-planner/pull/1) [`5ac0079`](https://github.com/rxova/jev-planner/commit/5ac0079f6edc6982dc2f081f642513f47dc5a5e5) Thanks [@jonatankruszewski](https://github.com/jonatankruszewski)! - Let Jev skip the rounds a plan does not need, and add `--mode` to choose how many it may spend.
  
  A run's wall clock is the number of rounds, not the number of agent calls: the agents in a round run
  in parallel, and each round waits for the one before it. Both the cross-review and the final merge
  used to run unconditionally, so every plan cost three rounds and 2N + 1 agent calls.
  
  - `--mode balanced`, the new default, puts Jev's typed judgment in front of each round instead of
    after it. It judges the drafts first and orders a cross-review only when one would materially
    improve the plan; it answers with the strongest cross-reviewed plan when it judges that plan final
    as it stands, rather than paying an agent to rewrite it; and a round stops waiting for a
    straggling agent once half have answered, aborting its call instead of leaving it running. A plan
    that has not been cross-reviewed is never adopted whole there: the merge is the only place the
    agents' material comes together. With two agents, a plan Jev finds ready costs three agent calls
    in two rounds where it used to cost five in three.
  - `--mode fast` has Jev judge each draft alone, one at a time in the order they arrive, and answers
    with the first it rates 0.5 or more, stopping the agents still drafting. When it accepts
    none, the drafts are merged with no cross-review. That is N or N + 1 agent calls in one or two
    rounds, and 1 … N + 1 Jev calls. The accepted plan was read by no other agent, the quickest agent
    is judged first, and an agent stopped mid-draft has still billed what it used. It has no review
    round, so it rejects `--review-mode debate` and `--claim-checks` and ignores `--review-rounds`;
    `--finalizer` only picks who merges.
  - `--mode ultra` keeps the previous pipeline: every agent cross-reviews every other, Jev may ask for
    one more pass, and the finalizer always merges.
  
  Also:
  
  - `mode` in `PlanOptions` chooses the pipeline from code. `PlanMode` is `'fast' | 'balanced' |
  'ultra'`; an exhaustive `switch` over it needs a `'fast'` case.
  - `--straggler-grace <seconds>` sets how long a `balanced` or `fast` round waits for the agents still
    working once half have answered (default: 90; `0` waits for every agent).
  - `--review-rounds` now also takes `0`, to skip the cross-review entirely.
  - Every run reports what it spent on stderr, and `PlanResult.cost` (`cost` in `--json`) carries the
    mode, the rounds run, the agent and Jev call counts, whether the plan was merged, and any agent a
    round stopped waiting for. A `fast` run that answers with an accepted draft reports `selected`.
  - `JevVerdict` gains `standsAloneProbability`, and `JevJudge.judge` takes the `stage` of the plans it
    is given: `'solo'` for one draft judged alone, `'draft'` or `'review'` for the plans judged
    together. A custom judge should handle all three. `AgentRequest` gains an optional `signal`, which
    both built-in provider kinds honor.

- [#1](https://github.com/rxova/jev-planner/pull/1) [`ea9d32e`](https://github.com/rxova/jev-planner/commit/ea9d32e5c300a87f860a70637147f2c5fd9ff4af) Thanks [@jonatankruszewski](https://github.com/jonatankruszewski)! - Add `--review-effort <id>=<level>` to give an agent CLI another reasoning effort for its cross-reviews and synthesis, while its draft keeps `--effort`. `AgentRequest.effort` carries a per-call effort, and `PlanOptions.reviewEfforts` sets it from code.

- [#1](https://github.com/rxova/jev-planner/pull/1) [`ea9d32e`](https://github.com/rxova/jev-planner/commit/ea9d32e5c300a87f860a70637147f2c5fd9ff4af) Thanks [@jonatankruszewski](https://github.com/jonatankruszewski)! - Time every run. `--verbose` prints how long each round and each agent and Jev call took, and the
  total; `--rounds-dir` writes a `timings.json` in each round's folder; `--json` includes `timings`.
  From code, `PlanRound.timings` and `PlanResult.timings` carry the same numbers, typed as the new
  `RoundTimings` and `RunTimings`.

- [#1](https://github.com/rxova/jev-planner/pull/1) [`30f60bf`](https://github.com/rxova/jev-planner/commit/30f60bfefc120fbcd1753f3cb3a299e17605367c) Thanks [@jonatankruszewski](https://github.com/jonatankruszewski)! - Add `--rounds-dir <path>`, which writes every round's plans as the run goes — `round1/` for the drafts, `round2/` and up for each cross-review with Jev's verdict, and `final/plan.md` for the merged plan — and the `onRound` option on `Planner.plan` it is built on, with the new `PlanRound` type.

- [#1](https://github.com/rxova/jev-planner/pull/1) [`c6a2d13`](https://github.com/rxova/jev-planner/commit/c6a2d135376bedf14415eea0b3bb8bfee3f8f007) Thanks [@jonatankruszewski](https://github.com/jonatankruszewski)! - Run one provider as two or more agents. `--agents` takes `<provider>[:<name>]`, so `--agents codex:sol,codex:terra` runs Codex twice, each agent with its own session, draft and round files, labelled `Codex (sol)` and `Codex (terra)`. `--model`, `--effort`, `--review-effort` and `--finalizer` take the agent's name; a bare provider id is still its own name, so existing commands and configs are unchanged. In `jev-planner.json`, a key that is not a provider id names an agent and sets `provider`. Two agents with the same provider, model and effort get a warning, and `doctor` checks each provider once. New in the API: `AgentSetup.name` and `label`.

### Patch Changes

- [#1](https://github.com/rxova/jev-planner/pull/1) [`ea9d32e`](https://github.com/rxova/jev-planner/commit/ea9d32e5c300a87f860a70637147f2c5fd9ff4af) Thanks [@jonatankruszewski](https://github.com/jonatankruszewski)! - Run Claude Code with `--strict-mcp-config`. `--tools Read,Glob,Grep` does not cover MCP servers, so every server in the user's Claude configuration was started with each call and its tools were callable by the planning agent. Now Claude has only the three read-only tools the docs describe, and each call starts faster.

- [#1](https://github.com/rxova/jev-planner/pull/1) [`0dba94f`](https://github.com/rxova/jev-planner/commit/0dba94ff1209af2b7813e6d2e6ec99bd63100d8d) Thanks [@jonatankruszewski](https://github.com/jonatankruszewski)! - Correct the README, `llms.txt`, the `PlanMode` TSDoc and `--help` where they overstated a mode: `ultra` runs its second cross-review only when Jev asks and skips the merge with `--finalizer none`, and `balanced` skips a review by Jev's 0.65 score, not when the drafts "agree". The README's development commands now use pnpm, the Node requirement reads 20.19, and the `--verbose` example shows a real run's timings.

- [#1](https://github.com/rxova/jev-planner/pull/1) [`26ecf72`](https://github.com/rxova/jev-planner/commit/26ecf726a5982d06c6d14bbf30fe596a3b879d9d) Thanks [@jonatankruszewski](https://github.com/jonatankruszewski)! - Point the package's `homepage` and its `llms.txt` at the documentation site, https://jev-planner.com.

- [#1](https://github.com/rxova/jev-planner/pull/1) [`ea9d32e`](https://github.com/rxova/jev-planner/commit/ea9d32e5c300a87f860a70637147f2c5fd9ff4af) Thanks [@jonatankruszewski](https://github.com/jonatankruszewski)! - Only the draft stage is told to inspect the repository. The cross-review is told to open a file only to check a claim the plans disagree on, and the final synthesis only to settle a contradiction between them, so later stages stop re-reading the repository from scratch.
