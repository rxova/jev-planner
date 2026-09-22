---
title: Adding an AI
description: Every agent is one entry in PROVIDERS, built with cliProvider or openAICompatibleProvider.
sidebar:
  order: 2
---

Every agent comes from one list, `PROVIDERS` in `src/providers.ts`. The CLI flags, `--help`,
`doctor`, the prompts and Jev's choices are all built from it, so adding an AI is one entry there.

## A chat API

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

## An agent CLI

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
return the arguments that keep one and continue it; without it every call starts afresh. A CLI
that names its own sessions reports the name as `session` from `events`.

## From your own program

The same two builders are exported, so a program using the library can build its own agents from
them and pass them to `Planner`. The existing agents are listed in the
[agents reference](./agents.md).
