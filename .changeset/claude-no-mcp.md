---
'jev-planner': patch
---

Run Claude Code with `--strict-mcp-config`. `--tools Read,Glob,Grep` does not cover MCP servers, so every server in the user's Claude configuration was started with each call and its tools were callable by the planning agent. Now Claude has only the three read-only tools the docs describe, and each call starts faster.
