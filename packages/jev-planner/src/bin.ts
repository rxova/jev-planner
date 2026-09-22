#!/usr/bin/env node
import { createAgents, main } from './cli.js'
import type { CliDeps } from './cli.js'
import { runDoctor } from './doctor.js'
import { TypeSafeJevJudge } from './jev.js'
import { Planner } from './orchestrator.js'
import { PROVIDERS } from './providers.js'

// Every provider's credentials, and Jev's, are kept from every agent subprocess:
// an agent only ever sees the login it uses itself.
const omitEnv = ['TYPESAFE_API_KEY', ...PROVIDERS.flatMap(({ secretEnv }) => secretEnv)]

async function readPipedStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  }
  return Buffer.concat(chunks).toString('utf8').trim()
}

const deps: CliDeps = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  cwd: () => process.cwd(),
  readStdin: readPipedStdin,
  createPlanner: (setup) =>
    new Planner(createAgents(setup, process.env, omitEnv), new TypeSafeJevJudge()),
  doctor: runDoctor,
  now: () => new Date(),
}

// No top-level await: this entry is also built as CJS.
void main(process.argv.slice(2), deps).then((code) => {
  process.exitCode = code
})
