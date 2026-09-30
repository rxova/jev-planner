import { baseVitestConfig } from '@rxova/repo-config/vitest'

// `bin.ts` is only the process wiring around `main`: real stdio, env, and the
// real agents. The CLI tests drive `main` with fakes instead, because running
// the wiring for real spawns Codex and Claude and bills a Jev call.
export default baseVitestConfig({ root: import.meta.dirname, exclude: ['src/bin.ts'] })
