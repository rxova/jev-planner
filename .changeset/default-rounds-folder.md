---
'jev-planner': minor
---

Save every run's rounds by default, to a new `.jev-planner/<UTC start time>/` folder in the repository, which a `.gitignore` inside `.jev-planner/` keeps out of git. `--rounds-dir <path>` still chooses the folder, and the new `--no-rounds` writes none.
