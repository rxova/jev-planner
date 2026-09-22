---
'jev-planner': minor
---

The CLI reads a run's setup from `jev-planner.json` in the repository, or from `--config <path>`; `--no-config` reads none. Its keys follow the flags (`agents` with each agent's `model`, `effort` and `reviewEffort`, `mode`, `reviewMode`, `task`, …), plus `runsDir`, a reusable parent folder for the run folders. A flag given on the command line wins, and every boolean now has both forms (`--json` / `--no-json`, `--resume` / `--no-resume`, …). A task piped on stdin while the config has one is an error. The file never holds a key, and the package ships `config.schema.json` for editors. The file is found automatically, so an unrelated `jev-planner.json` already in a repository is now read: pass `--no-config` to skip it. `Planner` and the library API are unchanged.
