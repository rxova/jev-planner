#!/usr/bin/env node
import { ClaudeAgent, CodexAgent } from './agents.js'
import { main } from './cli.js'
import type { CliDeps } from './cli.js'
import { runDoctor } from './doctor.js'
import { TypeSafeJevJudge } from './jev.js'
import { Planner } from './orchestrator.js'

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
  createPlanner: ({ codexModel, claudeModel }) =>
    new Planner(new CodexAgent(codexModel), new ClaudeAgent(claudeModel), new TypeSafeJevJudge()),
  doctor: runDoctor,
}

// No top-level await: this entry is also built as CJS.
void main(process.argv.slice(2), deps).then((code) => {
  process.exitCode = code
})
