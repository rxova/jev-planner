#!/usr/bin/env node
import { main, processDeps } from '@rxova/planner-core'
import { TypeSafeJevJudge } from './jev.js'
import { JEV_PLANNER } from './program.js'

// No top-level await: this entry is also built as CJS.
void main(
  process.argv.slice(2),
  processDeps(JEV_PLANNER, () => new TypeSafeJevJudge()),
).then((code) => {
  process.exitCode = code
})
