import { createAgents, secretEnv } from '../cli/cli.js'
import { runDoctor } from '../doctor/doctor.js'
import { Planner } from '../orchestrator/orchestrator.js'
import type { CliDeps, PlannerProgram } from '../cli/cli.types.js'
import type { PlanJudge } from '../questions/questions.types.js'

async function readPipedStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  }
  return Buffer.concat(chunks).toString('utf8').trim()
}

/**
 * `main`'s dependencies in a real process: its stdio, environment and working
 * directory, the real agents, and a judge from `judge` for each run. What a
 * program's `bin` hands `main`.
 *
 * Every provider's credentials, and the judge's, are kept from every agent
 * subprocess: an agent only ever sees the login it uses itself.
 */
export function processDeps(program: PlannerProgram, judge: () => PlanJudge): CliDeps {
  const omitEnv = secretEnv(program)
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
    cwd: () => process.cwd(),
    readStdin: readPipedStdin,
    createPlanner: (setup) => new Planner(createAgents(setup, process.env, omitEnv), judge()),
    doctor: runDoctor,
    now: () => new Date(),
    program,
  }
}
