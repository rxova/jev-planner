---
title: Config file
description: Pin a run's agents, models, mode and task in jev-planner.json, which the flags override and which never holds a key.
sidebar:
  order: 3
---

A `jev-planner.json` in the repository sets up every run from there, so that `jev-planner "<task>"`,
or a bare `jev-planner` when the file has a task, always runs the same way. It is for the CLI only:
`Planner` in a program never reads it.

```json
{
  "$schema": "https://jev-planner.com/config.schema.json",
  "agents": {
    "codex": { "model": "gpt-5.6-sol", "effort": "high", "reviewEffort": "low" },
    "claude": {}
  },
  "mode": "ultra",
  "reviewMode": "debate",
  "runsDir": "planner-runs",
  "output": "PLAN.md"
}
```

`$schema` gives an editor completion and checks. The same schema ships in the package, as
`node_modules/jev-planner/config.schema.json`, for a config pinned to the installed version.

## Where it is read from

- `jev-planner.json` in the repository: the `--cwd` folder, or the current one. With no such file,
  nothing changes.
- `--config <path>` (`-c`) reads that file instead, relative to the current folder; it must exist.
- `--no-config` reads none.

A run that uses a config says so on stderr: `[jev-planner] Using config <path>`. `--help` and
`--version` never read it, so a broken config cannot hide them.

## The keys

Each key stands for the flag of the same name.

| Key                                              | Flag                                        | Value                                                           |
| ------------------------------------------------ | ------------------------------------------- | --------------------------------------------------------------- |
| `agents`                                         | `--agents`                                  | Two or more agents, in order; `{}` selects one with no settings |
| `agents.<id>.model`                              | `--model <id>=…`                            | A model name                                                    |
| `agents.<id>.effort`, `agents.<id>.reviewEffort` | `--effort <id>=…`, `--review-effort <id>=…` | A level; only for `codex` and `claude`                          |
| `mode`, `reviewMode`                             | `--mode`, `--review-mode`                   | `fast`, `balanced` or `ultra`; `standard` or `debate`           |
| `reviewRounds`                                   | `--review-rounds`                           | `0`, `1` or `2`                                                 |
| `finalizer`, `jevModel`                          | `--finalizer`, `--jev-model`                | As the flags take them                                          |
| `timeout`, `stragglerGrace`                      | `--timeout`, `--straggler-grace`            | Seconds                                                         |
| `claimChecks`, `json`, `verbose`, `allowAnyTask` | The flags of those names                    | `true` or `false`                                               |
| `resume`, `rounds`                               | `--no-resume`, `--no-rounds`                | `false` turns them off                                          |
| `runsDir`                                        | —                                           | A folder in which each run gets its own timestamped folder      |
| `output`                                         | `--output`                                  | A path                                                          |
| `task` or `taskFile`                             | The task, or `--file`                       | The task to plan when none is given; set one, not both          |
| `cwd`                                            | `--cwd`                                     | Only in a file passed with `--config`                           |

Paths in the file are relative to the file. An unknown key is an error, and so is a wrong type:
`jev-planner.json: agents.deepseek.effort: DeepSeek does not take effort`. The file is plain JSON,
with no comments; of a key written twice, the last one counts.

There is no key for `--rounds-dir`: that folder must be new or empty, so a fixed one would fail the
second run. `runsDir` is its reusable parent, which gets a `.gitignore` like `.jev-planner/`.

A discovered file cannot set `cwd`: a config found inside a repository cannot point the agents at
another one. Put `cwd` in a file you name with `--config`.

## Flags win

A flag on the command line beats the config, setting by setting:

- `--mode fast` beats `"mode": "ultra"`, and `--model codex=gpt-x` beats the config's model for
  Codex only.
- `--agents` picks the agents; the config's settings for the others are dropped.
- Every boolean has both forms: `--json` and `--no-json`, `--verbose` and `--no-verbose`,
  `--claim-checks` and `--no-claim-checks`, `--allow-any-task` and `--no-allow-any-task`, and
  `--resume` and `--rounds` beside `--no-resume` and `--no-rounds`.
- `--rounds-dir` or `--no-rounds` beats `runsDir`.

The task works the same way. A task given as arguments or with `--file` beats the config's, and
stdin is not read. Otherwise the config's `task` or `taskFile` is used, and without one, stdin. A
task piped on stdin while the config has one is an error, not ignored: pass it as an argument or
with `--file` to override the config's.

```sh
jev-planner "Add caching"      # the config's settings, this task
jev-planner --no-config "…"    # no config at all
```

Rules between settings are checked on the result, as for flags: `stragglerGrace` with `"mode":
"ultra"` fails, and so does a `finalizer` that is not one of the run's agents.

`jev-planner doctor` checks the config's agents in its repository, and ignores its task.

## No keys in it

The file is meant to be committed, so it never holds a secret. A key such as `apiKey` or `token` is
rejected, with the variable to set instead: `TYPESAFE_API_KEY` for Jev and each chat API's own, such
as `DEEPSEEK_API_KEY`. The [agents reference](../reference/agents.md) lists them.

An unrelated `jev-planner.json` already in a repository is read too; `--no-config` skips it.
